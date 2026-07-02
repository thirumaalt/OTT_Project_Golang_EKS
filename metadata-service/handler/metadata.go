package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/myflix/metadata-service/store"
	"gorm.io/gorm"
)

type Handler struct{ db *gorm.DB }

func New(db *gorm.DB) *Handler { return &Handler{db: db} }

// tmdbKey reads the TMDB API key from env.
func tmdbKey() string { return os.Getenv("TMDB_API_KEY") }

// ── TMDB proxy — what the frontend actually calls ─────────────────────────────

// GET /api/metadata/title/:title
// Checks DB first; if not found proxies to TMDB search and caches the result.
// Returns { data: "<raw-tmdb-json-string>" } to stay compatible with the
// old Java metadata-service the frontend was built against.
func (h *Handler) GetByTitle(c *gin.Context) {
	title := c.Param("title")
	if title == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title required"})
		return
	}

	// 1. Check our DB for a cached entry by title (case-insensitive)
	var m store.Media
	if err := h.db.WithContext(c.Request.Context()).Where("title ILIKE ?", title).First(&m).Error; err == nil {
		// Build a TMDB-compatible response from our stored data
		type tmdbResult struct {
			ID           int     `json:"id"`
			Title        string  `json:"title"`
			Name         string  `json:"name"`
			Overview     string  `json:"overview"`
			PosterPath   string  `json:"poster_path"`
			BackdropPath string  `json:"backdrop_path"`
			VoteAverage  float32 `json:"vote_average"`
			ReleaseDate  string  `json:"release_date"`
			MediaType    string  `json:"media_type"`
		}
		result := tmdbResult{
			ID:           m.TMDBId,
			Title:        m.Title,
			Name:         m.Title,
			Overview:     m.Description,
			PosterPath:   m.PosterURL,
			BackdropPath: m.BackdropURL,
			VoteAverage:  m.Rating,
			ReleaseDate:  fmt.Sprintf("%d-01-01", m.ReleaseYear),
			MediaType:    m.MediaType,
		}
		payload := map[string]interface{}{"results": []tmdbResult{result}}
		raw, _ := json.Marshal(payload)
		c.JSON(http.StatusOK, gin.H{"data": string(raw)})
		return
	}

	// 2. Fall back to TMDB
	key := tmdbKey()
	if key == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found and TMDB_API_KEY not configured"})
		return
	}

	tmdbURL := fmt.Sprintf(
		"https://api.themoviedb.org/3/search/multi?api_key=%s&query=%s&language=en-US&page=1",
		key,
		url.QueryEscape(title),
	)
	resp, err := http.Get(tmdbURL)
	if err != nil || resp.StatusCode != http.StatusOK {
		c.JSON(http.StatusNotFound, gin.H{"error": "TMDB lookup failed"})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	// Cache the first result in our DB asynchronously
	go func() {
		var parsed struct {
			Results []struct {
				ID           int     `json:"id"`
				Title        string  `json:"title"`
				Name         string  `json:"name"`
				Overview     string  `json:"overview"`
				PosterPath   string  `json:"poster_path"`
				BackdropPath string  `json:"backdrop_path"`
				VoteAverage  float64 `json:"vote_average"`
				MediaType    string  `json:"media_type"`
			} `json:"results"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Results) == 0 {
			return
		}
		r := parsed.Results[0]
		cachedTitle := r.Title
		if cachedTitle == "" {
			cachedTitle = r.Name
		}
		entry := store.Media{
			Title:       cachedTitle,
			Description: r.Overview,
			PosterURL:   r.PosterPath,
			BackdropURL: r.BackdropPath,
			Rating:      float32(r.VoteAverage),
			TMDBId:      r.ID,
			MediaType:   r.MediaType,
			MediaPath:   "tmdb://" + strconv.Itoa(r.ID),
		}
		var existing store.Media
		if h.db.WithContext(c.Request.Context()).Where("tmdb_id = ?", r.ID).First(&existing).Error != nil {
			h.db.WithContext(c.Request.Context()).Create(&entry)
		}
	}()

	c.JSON(http.StatusOK, gin.H{"data": string(body)})
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
