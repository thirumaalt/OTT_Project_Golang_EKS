package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// AI layer: the SQL engine in engine.go proposes candidates, a local LLM
// (Ollama, OpenAI-compatible API) picks and explains the best ones. The model
// may only choose from the candidate list, every id is validated, and any
// failure falls back to the plain rule-based shelf, so the model never blocks
// or breaks the home page.

var (
	llmBase    = strings.TrimRight(os.Getenv("LLM_BASE_URL"), "/") // e.g. http://192.168.1.50:11434/v1 ; empty disables the AI layer
	llmModel   = envOr("LLM_MODEL", "qwen2.5:7b-instruct")
	llmTimeout = envDuration("LLM_TIMEOUT_SECONDS", 120)
	aiWait     = envDuration("AI_WAIT_SECONDS", 25) // how long a request waits for the model before returning the fallback
	aiTTL      = envDuration("AI_CACHE_TTL_SECONDS", 1800)
	aiFailTTL  = 2 * time.Minute
	aiDebug    = os.Getenv("AI_DEBUG") == "true" // log the raw model reply and why reasons were rejected
)

const (
	aiPoolSize = 20 // candidates shown to the model (smaller prompt = faster on a 6 GB GPU)
	aiPicks    = 8
)

func envOr(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func envDuration(k string, defSeconds int) time.Duration {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return time.Duration(defSeconds) * time.Second
}

type aiEntry struct {
	done   chan struct{}
	items  []Item
	err    error
	expiry time.Time
}

var (
	aiMu    sync.Mutex
	aiCache = map[string]*aiEntry{}
	llmSem  = make(chan struct{}, 1) // one generation at a time: a 6 GB GPU serves one request well
)

type detail struct {
	ID          uint
	Description string
	Tags        string
}

func loadDetails(c *gin.Context, ids []uint) map[uint]detail {
	var rows []detail
	db.WithContext(c.Request.Context()).Raw(`
		SELECT m.id, COALESCE(m.description,'') AS description,
		       COALESCE((SELECT string_agg(name, ', ') FROM (SELECT name FROM tags WHERE media_id = m.id LIMIT 6) t), '') AS tags
		FROM media m WHERE m.id IN (?)`, nonEmpty(ids)).Scan(&rows)
	out := make(map[uint]detail, len(rows))
	for _, r := range rows {
		out[r.ID] = r
	}
	return out
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

func describe(it Item, d detail, withTags bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s", it.Title)
	if it.ReleaseYear > 0 {
		fmt.Fprintf(&b, " (%d)", it.ReleaseYear)
	}
	if it.Genre != "" {
		fmt.Fprintf(&b, " [%s]", it.Genre)
	}
	if withTags && d.Tags != "" {
		fmt.Fprintf(&b, " themes: %s.", d.Tags)
	}
	if d.Description != "" {
		fmt.Fprintf(&b, " %s", clip(d.Description, 120))
	}
	return b.String()
}

// candidatePool: similar-to-recent titles first, then trending, then top-rated
// unwatched titles until the pool is full. The catalogue is small, so the model
// effectively sees most of what the user hasn't watched.
func candidatePool(c *gin.Context, recent []Item, seen []uint) []Item {
	lists := [][]Item{}
	for i, r := range recent {
		if i >= 3 {
			break
		}
		lists = append(lists,
			coWatched(c, r.ID, seen, 10),
			contentBased(c, r.ID, seen, 10))
	}
	lists = append(lists, trending(c, 15, seen))
	var rated []Item
	db.WithContext(c.Request.Context()).Raw(
		`SELECT `+itemCols+`, 0 AS score FROM media m WHERE m.id NOT IN (?) ORDER BY m.rating DESC, m.id DESC LIMIT ?`,
		nonEmpty(seen), aiPoolSize).Scan(&rated)
	lists = append(lists, rated)
	return mergeItems(aiPoolSize, lists...)
}

func buildPrompt(recent, pool []Item, det map[uint]detail) (system, user string) {
	system = `You are the recommendation engine of a movie and TV streaming service.
Pick exactly 8 different titles for one viewer, using ONLY the candidate list. Refer to candidates by their numeric id and never invent ids.
Choose titles that are close to what the viewer recently watched in theme, genre, tone, cast or director. Prefer variety. Put the best match first.
For each pick, "because" is the exact title copied from the "Recently watched" list that the pick is most like, and "reason" says in one sentence what they share.
Never put the picked title in "because". Never write the picked title in "reason".
Reply with JSON only, in exactly this shape:
{"picks":[{"id":123,"because":"Heat","reason":"Another tense crime story with a cat-and-mouse chase."}]}
Each reason is one sentence of at most 20 words. No spoilers.`

	var b strings.Builder
	b.WriteString("Recently watched (newest first):\n")
	for _, r := range recent {
		b.WriteString("- " + describe(r, det[r.ID], true) + "\n")
	}
	fmt.Fprintf(&b, "\nCandidates (choose %d):\n", aiPicks)
	for _, p := range pool {
		fmt.Fprintf(&b, "[%d] %s\n", p.ID, describe(p, det[p.ID], true))
	}
	return system, b.String()
}

type chatReq struct {
	Model          string              `json:"model"`
	Messages       []map[string]string `json:"messages"`
	Temperature    float64             `json:"temperature"`
	MaxTokens      int                 `json:"max_tokens"`
	Stream         bool                `json:"stream"`
	ResponseFormat map[string]string   `json:"response_format"`
}

type chatResp struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func callLLM(ctx context.Context, system, user string) (string, error) {
	body, _ := json.Marshal(chatReq{
		Model: llmModel,
		Messages: []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
		Temperature:    0.3,
		MaxTokens:      700,
		ResponseFormat: map[string]string{"type": "json_object"},
	})
	ctx, cancel := context.WithTimeout(ctx, llmTimeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, llmBase+"/chat/completions", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var out chatResp
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("llm status %d: bad json", resp.StatusCode)
	}
	if out.Error != nil {
		return "", fmt.Errorf("llm: %s", out.Error.Message)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("llm status %d: no choices", resp.StatusCode)
	}
	return out.Choices[0].Message.Content, nil
}

// parsePicks accepts only ids from the pool, drops duplicates and empty
// reasons, and keeps the model's order.
func parsePicks(content string, pool, recent []Item) ([]Item, int, error) {
	content = strings.TrimSpace(content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	if aiDebug {
		log.Printf("ai-recs debug: raw model reply: %s", clip(content, 1500))
	}
	var parsed struct {
		Picks []struct {
			ID      uint   `json:"id"`
			Because string `json:"because"`
			Reason  string `json:"reason"`
		} `json:"picks"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &parsed); err != nil {
		return nil, 0, fmt.Errorf("model reply is not valid JSON: %w", err)
	}
	byID := make(map[uint]Item, len(pool))
	for _, p := range pool {
		byID[p.ID] = p
	}
	seen := map[uint]bool{}
	out := []Item{}
	repaired := 0
	for _, p := range parsed.Picks {
		it, ok := byID[p.ID]
		reason := clip(p.Reason, 160)
		if !ok || seen[p.ID] {
			continue
		}
		seen[p.ID] = true
		anchor, hasAnchor := findRecent(p.Because, it, recent)
		switch {
		case reason != "" && reasonOK(reason, it, recent):
			// the model named something the viewer watched and not the pick itself: keep its words
		case reason != "" && hasAnchor && !mentions(reason, it.Title):
			// no watched title in the sentence, but the model named a valid anchor: attach it
			reason = strings.TrimRight(reason, ". ") + ", like " + anchor.Title + "."
		default:
			if aiDebug {
				log.Printf("ai-recs debug: rejected reason for %q: %q (because=%q)", it.Title, reason, p.Because)
			}
			if hasAnchor {
				reason = repairWith(it, anchor)
			} else {
				reason = repairReason(it, recent)
			}
			repaired++
		}
		it.Reason = reason
		out = append(out, it)
		if len(out) == aiPicks {
			break
		}
	}
	if len(out) < 3 {
		return nil, 0, fmt.Errorf("model returned only %d valid picks", len(out))
	}
	return out, repaired, nil
}

func cacheKey(uid uint, recent, pool []Item) string {
	h := sha1.New()
	fmt.Fprintf(h, "%d|%s|", uid, llmModel)
	for _, r := range recent {
		fmt.Fprintf(h, "r%d,", r.ID)
	}
	ids := make([]int, 0, len(pool))
	for _, p := range pool {
		ids = append(ids, int(p.ID))
	}
	sort.Ints(ids)
	for _, id := range ids {
		fmt.Fprintf(h, "c%d,", id)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// generate runs in the background with its own context: it must outlive the
// HTTP request that triggered it so a slow first generation still lands in the cache.
func generate(key string, e *aiEntry, system, user string, pool, recent []Item) {
	llmSem <- struct{}{}
	defer func() { <-llmSem }()
	start := time.Now()
	content, err := callLLM(context.Background(), system, user)
	var items []Item
	repaired := 0
	if err == nil {
		items, repaired, err = parsePicks(content, pool, recent)
	}
	aiMu.Lock()
	e.items, e.err = items, err
	if err != nil {
		e.expiry = time.Now().Add(aiFailTTL)
		log.Printf("ai-recs: generation failed after %s: %v", time.Since(start).Round(time.Millisecond), err)
	} else {
		e.expiry = time.Now().Add(aiTTL)
		log.Printf("ai-recs: %d picks, %d reasons repaired, in %s (model %s)", len(items), repaired, time.Since(start).Round(time.Millisecond), llmModel)
	}
	aiMu.Unlock()
	close(e.done)
}

func aiHomeHandler(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	uid := uint(userID)

	recent := recentlyWatched(c, uid, 8)
	if len(recent) == 0 {
		c.JSON(http.StatusOK, gin.H{"userId": uid, "source": "cold-start", "rows": []Row{}})
		return
	}
	seen := watchedIDs(c, uid)
	pool := candidatePool(c, recent, seen)

	fallback := func(source string, pending bool) {
		n := 12
		if len(pool) < n {
			n = len(pool)
		}
		rows := []Row{}
		if n > 0 {
			rows = append(rows, Row{Key: "because", Title: "Because you watched " + recent[0].Title, Items: pool[:n]})
		}
		c.JSON(http.StatusOK, gin.H{"userId": uid, "source": source, "pending": pending, "rows": rows})
	}

	if llmBase == "" || len(pool) < 3 {
		fallback("rules", false)
		return
	}

	key := cacheKey(uid, recent, pool)
	aiMu.Lock()
	e := aiCache[key]
	if e != nil {
		select {
		case <-e.done:
			if time.Now().After(e.expiry) { // finished and stale: regenerate
				e = nil
			}
		default: // still running: wait for it below
		}
	}
	if e == nil {
		for k, old := range aiCache { // keep the map bounded
			if len(aiCache) < 500 {
				break
			}
			select {
			case <-old.done:
				delete(aiCache, k)
			default:
			}
		}
		e = &aiEntry{done: make(chan struct{})}
		aiCache[key] = e
		det := loadDetails(c, append(idsOf(recent), idsOf(pool)...))
		system, user := buildPrompt(recent, pool, det)
		go generate(key, e, system, user, pool, recent)
	}
	aiMu.Unlock()

	select {
	case <-e.done:
		if e.err != nil {
			fallback("rules", false)
			return
		}
		c.JSON(http.StatusOK, gin.H{"userId": uid, "source": "llm", "model": llmModel, "pending": false,
			"rows": []Row{{Key: "ai", Title: "Picked for you", Items: e.items}}})
	case <-time.After(aiWait):
		fallback("rules", true) // generation continues; the next call returns it from cache
	case <-c.Request.Context().Done():
	}
}

func idsOf(items []Item) []uint {
	out := make([]uint, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

// reasonOK rejects explanations a small model tends to produce: ones that name
// the recommended title itself, or that name nothing the viewer actually watched.
func reasonOK(reason string, pick Item, recent []Item) bool {
	low := strings.ToLower(reason)
	if t := strings.ToLower(strings.TrimSpace(pick.Title)); t != "" && strings.Contains(low, t) {
		return false
	}
	for _, r := range recent {
		if t := strings.ToLower(strings.TrimSpace(r.Title)); t != "" && strings.Contains(low, t) {
			return true
		}
	}
	return false
}

// repairReason builds a factual reason from the data: the recently watched
// title that shares the most genres with the pick.
func repairReason(pick Item, recent []Item) string {
	want := map[string]bool{}
	for _, g := range splitGenres(pick.Genre) {
		want[strings.ToLower(g)] = true
	}
	best, bestShared := Item{}, []string{}
	for _, r := range recent {
		shared := []string{}
		for _, g := range splitGenres(r.Genre) {
			if want[strings.ToLower(g)] {
				shared = append(shared, strings.ToLower(g))
			}
		}
		if len(shared) > len(bestShared) {
			best, bestShared = r, shared
		}
	}
	if len(bestShared) > 0 {
		return fmt.Sprintf("Shares its %s feel with %s, which you watched.", joinNatural(bestShared), best.Title)
	}
	if len(recent) > 0 {
		return fmt.Sprintf("A popular pick for fans of %s.", recent[0].Title)
	}
	return "A popular pick in the catalogue."
}

// joinNatural renders ["a","b","c"] as "a, b and c".
func joinNatural(a []string) string {
	switch len(a) {
	case 0:
		return ""
	case 1:
		return a[0]
	}
	return strings.Join(a[:len(a)-1], ", ") + " and " + a[len(a)-1]
}

func mentions(text, title string) bool {
	t := strings.ToLower(strings.TrimSpace(title))
	return t != "" && strings.Contains(strings.ToLower(text), t)
}

// findRecent matches the model's "because" against the viewer's recent titles
// (exact, case-insensitive). The pick itself is never a valid anchor.
func findRecent(because string, pick Item, recent []Item) (Item, bool) {
	b := strings.ToLower(strings.TrimSpace(because))
	if b == "" {
		return Item{}, false
	}
	for _, r := range recent {
		if r.ID != pick.ID && strings.ToLower(strings.TrimSpace(r.Title)) == b {
			return r, true
		}
	}
	return Item{}, false
}

// repairWith explains a pick through an anchor the model chose.
func repairWith(pick, anchor Item) string {
	want := map[string]bool{}
	for _, g := range splitGenres(pick.Genre) {
		want[strings.ToLower(g)] = true
	}
	shared := []string{}
	for _, g := range splitGenres(anchor.Genre) {
		if want[strings.ToLower(g)] {
			shared = append(shared, strings.ToLower(g))
		}
	}
	if len(shared) > 0 {
		return fmt.Sprintf("Shares its %s feel with %s, which you watched.", joinNatural(shared), anchor.Title)
	}
	return fmt.Sprintf("A pick for fans of %s.", anchor.Title)
}
