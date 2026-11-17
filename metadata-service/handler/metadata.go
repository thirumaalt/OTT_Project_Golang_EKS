package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/myflix/metadata-service/store"
	"gorm.io/gorm"
)

type Handler struct{ db *gorm.DB }

func New(db *gorm.DB) *Handler { return &Handler{db: db} }

// tmdbKey reads the TMDB API key from env.
func tmdbKey() string { return os.Getenv("TMDB_API_KEY") }

// ── TMDB proxy — what the frontend actually calls ─────────────────────────────

const defaultTMDBBase = "https://api.themoviedb.org/3"

var tmdbClient = &http.Client{Timeout: 10 * time.Second}

// tmdbBase is overridable (TMDB_BASE_URL) so tests can point at a mock server.
func tmdbBase() string {
	if v := os.Getenv("TMDB_BASE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return defaultTMDBBase
}

// tmdbGET calls TMDB and decodes JSON into out. Errors never contain the API key.
func tmdbGET(ctx context.Context, path string, params url.Values, out interface{}) error {
	params.Set("api_key", tmdbKey())
	params.Set("language", "en-US")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tmdbBase()+path+"?"+params.Encode(), nil)
	if err != nil {
		return fmt.Errorf("tmdb %s: build request", path)
	}
	resp, err := tmdbClient.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // strips the URL (and api_key) from the message
		}
		return fmt.Errorf("tmdb %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("tmdb %s: status %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// GET /api/metadata/title/:title
//
// Serves from our DB when we already hold the full TMDB details for this title.
// Otherwise: TMDB search -> TMDB detail (+credits, keywords, certifications) ->
// store everything -> respond. TMDB is only called on the first request for a title.
//
// Response stays { data: "<json-string>" } with { results: [ <tmdb detail> ] },
// which is what the existing frontend parses.
func (h *Handler) GetByTitle(c *gin.Context) {
	title := strings.TrimSpace(c.Param("title"))
	if title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title required"})
		return
	}
	key := strings.ToLower(title)
	ctx := c.Request.Context()

	// 1. DB hit (only rows that carry the full TMDB payload count as cached)
	var m store.Media
	if err := h.db.WithContext(ctx).
		Where("tmdb_raw IS NOT NULL AND (search_key = ? OR lower(title) = ?)", key, key).
		First(&m).Error; err == nil && m.TMDBRaw != nil {
		respondResults(c, *m.TMDBRaw, m.ID)
		return
	}

	// 2. Miss -> TMDB
	if tmdbKey() == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found and TMDB_API_KEY not configured"})
		return
	}
	raw, id, err := h.fetchAndStore(ctx, title, key)
	if err != nil {
		log.Printf("metadata: %q: %v", title, err)
		c.JSON(http.StatusNotFound, gin.H{"error": "TMDB lookup failed"})
		return
	}
	respondResults(c, raw, id)
}

// respondResults wraps the stored TMDB detail and adds myflix_id (our media.id), the id
// other services (watch history, interactions, recommendations) use as content_id.
func respondResults(c *gin.Context, detailJSON string, mediaID uint) {
	var d map[string]json.RawMessage
	if err := json.Unmarshal([]byte(detailJSON), &d); err == nil && mediaID != 0 {
		d["myflix_id"] = json.RawMessage(strconv.FormatUint(uint64(mediaID), 10))
		if b, err := json.Marshal(d); err == nil {
			detailJSON = string(b)
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": `{"results":[` + detailJSON + `]}`})
}

// fetchAndStore resolves a title on TMDB, saves the result, and returns the detail JSON.
func (h *Handler) fetchAndStore(ctx context.Context, title, key string) (string, uint, error) {
	var sr struct {
		Results []struct {
			ID        int    `json:"id"`
			MediaType string `json:"media_type"`
		} `json:"results"`
	}
	if err := tmdbGET(ctx, "/search/multi", url.Values{"query": {title}, "page": {"1"}}, &sr); err != nil {
		return "", 0, err
	}
	id, mt := 0, ""
	for _, r := range sr.Results { // skip "person" hits
		if r.MediaType == "movie" || r.MediaType == "tv" {
			id, mt = r.ID, r.MediaType
			break
		}
	}
	if id == 0 {
		return "", 0, fmt.Errorf("no movie/tv match")
	}

	extra := "credits,keywords,release_dates"
	if mt == "tv" {
		extra = "credits,keywords,content_ratings"
	}
	var d map[string]interface{}
	if err := tmdbGET(ctx, fmt.Sprintf("/%s/%d", mt, id), url.Values{"append_to_response": {extra}}, &d); err != nil {
		return "", 0, err
	}
	d["media_type"] = mt
	if _, ok := d["runtime"]; !ok || d["runtime"] == nil { // tv: use typical episode length
		if eps, ok := d["episode_run_time"].([]interface{}); ok && len(eps) > 0 {
			d["runtime"] = eps[0]
		}
	}
	rawBytes, err := json.Marshal(d)
	if err != nil {
		return "", 0, err
	}
	raw := string(rawBytes)

	entry := mediaFromTMDB(d, id, mt)
	entry.SearchKey = key
	entry.TMDBRaw = &raw

	db := h.db.WithContext(ctx)
	var existing store.Media
	savedID := uint(0)
	if db.Where("tmdb_id = ? AND media_type = ?", id, mt).First(&existing).Error == nil {
		// backfill a row cached earlier with only search-level fields
		entry.ID, entry.MediaPath = existing.ID, existing.MediaPath
		savedID = existing.ID
		err = db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Where("media_id = ?", existing.ID).Delete(&store.Tag{}).Error; err != nil {
				return err
			}
			return tx.Save(&entry).Error
		})
	} else if err = db.Create(&entry).Error; err != nil {
		// lost a race with a concurrent request for the same title: that's fine
		if db.Where("media_path = ?", entry.MediaPath).First(&existing).Error == nil {
			err = nil
			savedID = existing.ID
		}
	} else {
		savedID = entry.ID
	}
	if err != nil {
		// still return the data; caching failed but the user shouldn't suffer
		log.Printf("metadata: cache write for %q failed: %v", title, err)
	}
	return raw, savedID, nil
}

func mediaFromTMDB(d map[string]interface{}, id int, mt string) store.Media {
	str := func(m map[string]interface{}, k string) string { s, _ := m[k].(string); return s }
	title := str(d, "title")
	if title == "" {
		title = str(d, "name")
	}
	date := str(d, "release_date")
	if date == "" {
		date = str(d, "first_air_date")
	}
	year := 0
	if len(date) >= 4 {
		year, _ = strconv.Atoi(date[:4])
	}
	vote, _ := d["vote_average"].(float64)

	var genres []string
	if gs, ok := d["genres"].([]interface{}); ok {
		for _, g := range gs {
			if gm, ok := g.(map[string]interface{}); ok {
				if n := str(gm, "name"); n != "" {
					genres = append(genres, n)
				}
			}
		}
	}

	var cast []string
	director := ""
	if cr, ok := d["credits"].(map[string]interface{}); ok {
		if cs, ok := cr["cast"].([]interface{}); ok {
			for i, p := range cs {
				if i == 10 {
					break
				}
				if pm, ok := p.(map[string]interface{}); ok {
					cast = append(cast, str(pm, "name"))
				}
			}
		}
		if crew, ok := cr["crew"].([]interface{}); ok {
			for _, p := range crew {
				if pm, ok := p.(map[string]interface{}); ok && str(pm, "job") == "Director" {
					director = str(pm, "name")
					break
				}
			}
		}
	}

	// keywords become tags (movie: keywords.keywords, tv: keywords.results)
	var tags []store.Tag
	if kw, ok := d["keywords"].(map[string]interface{}); ok {
		list, _ := kw["keywords"].([]interface{})
		if list == nil {
			list, _ = kw["results"].([]interface{})
		}
		for i, k := range list {
			if i == 15 {
				break
			}
			if km, ok := k.(map[string]interface{}); ok && str(km, "name") != "" {
				tags = append(tags, store.Tag{Name: str(km, "name")})
			}
		}
	}

	path := "tmdb://" + strconv.Itoa(id)
	if mt == "tv" {
		path = "tmdb://tv/" + strconv.Itoa(id)
	}
	return store.Media{
		MediaPath:   path,
		Title:       title,
		Description: str(d, "overview"),
		Genre:       strings.Join(genres, ", "),
		ReleaseYear: year,
		Director:    director,
		Cast:        strings.Join(cast, ", "),
		PosterURL:   str(d, "poster_path"),
		BackdropURL: str(d, "backdrop_path"),
		Rating:      float32(vote),
		Language:    str(d, "original_language"),
		TMDBId:      id,
		MediaType:   mt,
		Tags:        tags,
	}
}

// ── Create ────────────────────────────────────────────────────────────────────

func (h *Handler) CreateMedia(c *gin.Context) {
	var m store.Media
	if err := c.ShouldBindJSON(&m); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.WithContext(c.Request.Context()).Create(&m).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create metadata"})
		return
	}
	c.JSON(http.StatusCreated, m)
}

// ── Get by ID ─────────────────────────────────────────────────────────────────

func (h *Handler) GetMedia(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var m store.Media
	if err := h.db.WithContext(c.Request.Context()).Preload("Tags").First(&m, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, m)
}

// ── Get by path ───────────────────────────────────────────────────────────────

// GET /api/metadata/by-path?path=<mediaPath>
func (h *Handler) GetByPath(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path query param required"})
		return
	}
	var m store.Media
	if err := h.db.WithContext(c.Request.Context()).Preload("Tags").Where("media_path = ?", path).First(&m).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, m)
}

// ── List ──────────────────────────────────────────────────────────────────────

// GET /api/metadata?genre=Action&mediaType=movie&page=1&limit=20
func (h *Handler) ListMedia(c *gin.Context) {
	genre := c.Query("genre")
	mediaType := c.Query("mediaType")
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if page < 1 {
		page = 1
	}
	if limit < 1 || limit > 100 {
		limit = 20
	}
	offset := (page - 1) * limit

	q := h.db.WithContext(c.Request.Context()).Preload("Tags").Model(&store.Media{})
	if genre != "" {
		q = q.Where("genre ILIKE ?", "%"+genre+"%")
	}
	if mediaType != "" {
		q = q.Where("media_type = ?", mediaType)
	}

	var total int64
	q.Count(&total)

	var items []store.Media
	q.Offset(offset).Limit(limit).Order("id desc").Find(&items)

	c.JSON(http.StatusOK, gin.H{
		"total": total,
		"page":  page,
		"limit": limit,
		"items": items,
	})
}

// ── Search ────────────────────────────────────────────────────────────────────

// GET /api/metadata/search?q=<term>
func (h *Handler) SearchMedia(c *gin.Context) {
	q := c.Query("q")
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "q query param required"})
		return
	}
	like := "%" + q + "%"
	var items []store.Media
	h.db.WithContext(c.Request.Context()).Preload("Tags").
		Where("title ILIKE ? OR description ILIKE ? OR cast ILIKE ? OR director ILIKE ?", like, like, like, like).
		Limit(50).
		Find(&items)
	c.JSON(http.StatusOK, items)
}

// ── Update ────────────────────────────────────────────────────────────────────

func (h *Handler) UpdateMedia(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var m store.Media
	if err := h.db.WithContext(c.Request.Context()).First(&m, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if err := c.ShouldBindJSON(&m); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	m.ID = uint(id)
	h.db.WithContext(c.Request.Context()).Save(&m)
	c.JSON(http.StatusOK, m)
}

// ── Delete ────────────────────────────────────────────────────────────────────

func (h *Handler) DeleteMedia(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	h.db.WithContext(c.Request.Context()).Delete(&store.Media{}, id)
	c.Status(http.StatusNoContent)
}

// ── Bulk upsert by path ───────────────────────────────────────────────────────

// POST /api/metadata/bulk  — upsert a slice of Media by media_path
func (h *Handler) BulkUpsert(c *gin.Context) {
	var items []store.Media
	if err := c.ShouldBindJSON(&items); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	for i := range items {
		var existing store.Media
		if err := h.db.WithContext(c.Request.Context()).Where("media_path = ?", items[i].MediaPath).First(&existing).Error; err == nil {
			items[i].ID = existing.ID
			h.db.WithContext(c.Request.Context()).Save(&items[i])
		} else {
			h.db.WithContext(c.Request.Context()).Create(&items[i])
		}
	}
	c.JSON(http.StatusOK, gin.H{"upserted": len(items)})
}
