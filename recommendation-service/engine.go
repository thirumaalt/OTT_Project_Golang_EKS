package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Item is a catalog entry returned in recommendation rows.
type Item struct {
	ID          uint    `json:"id"`
	Title       string  `json:"title"`
	Genre       string  `json:"genre"`
	MediaType   string  `json:"mediaType"`
	MediaPath   string  `json:"mediaPath"`
	PosterURL   string  `json:"posterUrl"`
	Rating      float32 `json:"rating"`
	ReleaseYear int     `json:"releaseYear"`
	Score       float64 `json:"score"`
}

// Row is one horizontal shelf on the home screen.
type Row struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	Items []Item `json:"items"`
}

const itemCols = `m.id, m.title, m.genre, m.media_type, m.media_path, m.poster_url, m.rating, m.release_year`

func registerEngineRoutes(g *gin.RouterGroup) {
	g.GET("/home", homeHandler)
	g.GET("/trending", trendingHandler)
	g.GET("/similar/:contentId", similarHandler)
}

func limitParam(c *gin.Context, def int) int {
	n, err := strconv.Atoi(c.DefaultQuery("limit", strconv.Itoa(def)))
	if err != nil || n < 1 || n > 50 {
		return def
	}
	return n
}

// trending: recent plays weighted by recency, plus likes and rating signal.
// Falls back to catalog rating when there is no behaviour data yet.
func trending(c *gin.Context, limit int, exclude []uint) []Item {
	var items []Item
	since := time.Now().AddDate(0, 0, -30)
	db.WithContext(c.Request.Context()).Raw(`
		SELECT `+itemCols+`, (COALESCE(w.plays,0) + 2*COALESCE(l.likes,0) + COALESCE(r.avg_score,0)) AS score
		FROM media m
		LEFT JOIN (SELECT content_id, COUNT(*) plays FROM watch_events
		           WHERE watched_at > ? GROUP BY content_id) w ON w.content_id = m.id
		LEFT JOIN (SELECT content_id, COUNT(*) likes FROM likes GROUP BY content_id) l ON l.content_id = m.id
		LEFT JOIN (SELECT content_id, AVG(score) avg_score FROM ratings GROUP BY content_id) r ON r.content_id = m.id
		WHERE m.id NOT IN (?)
		ORDER BY score DESC, m.rating DESC, m.id DESC
		LIMIT ?`, since, nonEmpty(exclude), limit).Scan(&items)
	return items
}

// recentlyWatched returns the user's latest distinct titles (no progress tracking exists yet).
func recentlyWatched(c *gin.Context, userID uint, limit int) []Item {
	var items []Item
	db.WithContext(c.Request.Context()).Raw(`
		SELECT `+itemCols+`, 0 AS score
		FROM (SELECT content_id, MAX(watched_at) last_at FROM watch_events
		      WHERE user_id = ? GROUP BY content_id) h
		JOIN media m ON m.id = h.content_id
		ORDER BY h.last_at DESC LIMIT ?`, userID, limit).Scan(&items)
	return items
}

func watchedIDs(c *gin.Context, userID uint) []uint {
	var ids []uint
	db.WithContext(c.Request.Context()).Raw(
		`SELECT DISTINCT content_id FROM watch_events WHERE user_id = ?`, userID).Scan(&ids)
	return ids
}

// coWatched: item-item collaborative filtering — titles watched by users who also watched `contentID`.
func coWatched(c *gin.Context, contentID uint, exclude []uint, limit int) []Item {
	var items []Item
	db.WithContext(c.Request.Context()).Raw(`
		SELECT `+itemCols+`, COUNT(DISTINCT w2.user_id) AS score
		FROM watch_events w1
		JOIN watch_events w2 ON w2.user_id = w1.user_id AND w2.content_id <> w1.content_id
		JOIN media m ON m.id = w2.content_id
		WHERE w1.content_id = ? AND m.id NOT IN (?)
		GROUP BY m.id
		ORDER BY score DESC, m.rating DESC LIMIT ?`, contentID, nonEmpty(exclude), limit).Scan(&items)
	return items
}

// contentBased: same genre / shared tags, ordered by overlap then catalog rating.
func contentBased(c *gin.Context, contentID uint, exclude []uint, limit int) []Item {
	var src struct {
		Genre string
	}
	db.WithContext(c.Request.Context()).Raw(`SELECT genre FROM media WHERE id = ?`, contentID).Scan(&src)
	genres := splitGenres(src.Genre)

	var items []Item
	db.WithContext(c.Request.Context()).Raw(`
		SELECT `+itemCols+`,
		  (COALESCE(t.shared,0) * 2 + CASE WHEN m.genre = ? AND ? <> '' THEN 3 ELSE 0 END
		   + (SELECT COUNT(*) FROM unnest(?::text[]) g WHERE m.genre ILIKE '%'||g||'%')) AS score
		FROM media m
		LEFT JOIN (SELECT t2.media_id, COUNT(*) shared FROM tags t1
		           JOIN tags t2 ON lower(t2.name) = lower(t1.name) AND t2.media_id <> t1.media_id
		           WHERE t1.media_id = ? GROUP BY t2.media_id) t ON t.media_id = m.id
		WHERE m.id <> ? AND m.id NOT IN (?)
		ORDER BY score DESC, m.rating DESC LIMIT ?`,
		src.Genre, src.Genre, pgArray(genres), contentID, contentID, nonEmpty(exclude), limit).Scan(&items)

	// drop zero-score rows: nothing in common
	out := items[:0]
	for _, it := range items {
		if it.Score > 0 {
			out = append(out, it)
		}
	}
	return out
}

func trendingHandler(c *gin.Context) {
	c.JSON(http.StatusOK, trending(c, limitParam(c, 20), nil))
}

func similarHandler(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("contentId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid contentId"})
		return
	}
	limit := limitParam(c, 12)
	items := mergeItems(limit,
		contentBased(c, uint(id), nil, limit),
		coWatched(c, uint(id), nil, limit))
	c.JSON(http.StatusOK, items)
}

func homeHandler(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId required"})
		return
	}
	uid := uint(userID)
	limit := limitParam(c, 15)
	rows := []Row{}

	if recent := recentlyWatched(c, uid, limit); len(recent) > 0 {
		rows = append(rows, Row{Key: "recent", Title: "Recently watched", Items: recent})

		seen := watchedIDs(c, uid)
		anchor := recent[0]
		because := mergeItems(limit,
			coWatched(c, anchor.ID, seen, limit),
			contentBased(c, anchor.ID, seen, limit))
		if len(because) > 0 {
			rows = append(rows, Row{Key: "because", Title: "Because you watched " + anchor.Title, Items: because})
		}
		if t := trending(c, limit, seen); len(t) > 0 {
			rows = append(rows, Row{Key: "trending", Title: "Trending now", Items: t})
		}
	} else {
		// cold start: no history for this user
		if t := trending(c, limit, nil); len(t) > 0 {
			rows = append(rows, Row{Key: "trending", Title: "Trending now", Items: t})
		}
	}
	c.JSON(http.StatusOK, gin.H{"userId": uid, "rows": rows})
}

// ── helpers ──────────────────────────────────────────────────────────────────

// mergeItems concatenates lists, de-duplicates by ID (first occurrence wins), truncates to limit.
func mergeItems(limit int, lists ...[]Item) []Item {
	seen := map[uint]bool{}
	out := []Item{}
	for _, l := range lists {
		for _, it := range l {
			if seen[it.ID] {
				continue
			}
			seen[it.ID] = true
			out = append(out, it)
			if len(out) == limit {
				return out
			}
		}
	}
	return out
}

// nonEmpty avoids "NOT IN ()" which is invalid SQL.
func nonEmpty(ids []uint) []uint {
	if len(ids) == 0 {
		return []uint{0}
	}
	return ids
}

func splitGenres(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '/' || r == '|' }) {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// pgArray renders a Go string slice as a Postgres text[] literal.
func pgArray(a []string) string {
	esc := make([]string, len(a))
	for i, s := range a {
		esc[i] = `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
	}
	return "{" + strings.Join(esc, ",") + "}"
}
