package handler

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/myflix/user-service/store"
	"gorm.io/gorm"
)

type Handler struct{ db *gorm.DB }

func New(db *gorm.DB) *Handler { return &Handler{db: db} }

// ── Users ────────────────────────────────────────────────────────────────────

func (h *Handler) CreateUser(c *gin.Context) {
	var u store.User
	if err := c.ShouldBindJSON(&u); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.db.WithContext(c.Request.Context()).Create(&u).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create user"})
		return
	}
	c.JSON(http.StatusCreated, u)
}

func (h *Handler) GetUser(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var u store.User
	if err := h.db.WithContext(c.Request.Context()).First(&u, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, u)
}

// GetByUsername looks up a user by their username query param.
// Called internally by auth-service after a successful login to enrich the
// login response with user-service data within the same distributed trace.
//
// GET /api/user/by-username?username=alice
func (h *Handler) GetByUsername(c *gin.Context) {
	username := c.Query("username")
	if username == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "username query param is required"})
		return
	}
	var u store.User
	if err := h.db.WithContext(c.Request.Context()).Where("username = ?", username).First(&u).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, u)
}

// ── Profiles ─────────────────────────────────────────────────────────────────

type createProfileReq struct {
	UserID    uint   `json:"userId"    binding:"required"`
	Name      string `json:"name"      binding:"required"`
	AvatarURL string `json:"avatarUrl"`
}

func (h *Handler) CreateProfile(c *gin.Context) {
	var req createProfileReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Verify user exists
	var u store.User
	if err := h.db.WithContext(c.Request.Context()).First(&u, req.UserID).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	p := store.Profile{UserID: req.UserID, Name: req.Name, AvatarURL: req.AvatarURL}
	if err := h.db.WithContext(c.Request.Context()).Create(&p).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create profile"})
		return
	}
	c.JSON(http.StatusCreated, p)
}

func (h *Handler) GetProfiles(c *gin.Context) {
	userID, err := strconv.ParseUint(c.Query("userId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "userId query param required"})
		return
	}
	var profiles []store.Profile
	h.db.WithContext(c.Request.Context()).Where("user_id = ?", userID).Find(&profiles)
	c.JSON(http.StatusOK, profiles)
}

func (h *Handler) GetProfile(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var p store.Profile
	if err := h.db.WithContext(c.Request.Context()).First(&p, id).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "profile not found"})
		return
	}
	c.JSON(http.StatusOK, p)
}

func (h *Handler) DeleteProfile(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	h.db.WithContext(c.Request.Context()).Delete(&store.Profile{}, id)
	c.Status(http.StatusNoContent)
}

// ── Watch History ─────────────────────────────────────────────────────────────

func (h *Handler) SaveHistory(c *gin.Context) {
	var wh store.WatchHistory
	if err := c.ShouldBindJSON(&wh); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	wh.LastWatched = time.Now()

	var existing store.WatchHistory
	err := h.db.WithContext(c.Request.Context()).Where("profile_id = ? AND media_path = ?", wh.ProfileID, wh.MediaPath).First(&existing).Error
	if err == nil {
		existing.ProgressSeconds = wh.ProgressSeconds
		existing.TotalDuration = wh.TotalDuration
		existing.LastWatched = time.Now()
		h.db.WithContext(c.Request.Context()).Save(&existing)
		c.JSON(http.StatusOK, existing)
		return
	}
	h.db.WithContext(c.Request.Context()).Create(&wh)
	c.JSON(http.StatusCreated, wh)
}

func (h *Handler) GetHistory(c *gin.Context) {
	profileID, err := strconv.ParseUint(c.Query("profileId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "profileId query param required"})
		return
	}
	var history []store.WatchHistory
	h.db.WithContext(c.Request.Context()).Where("profile_id = ?", profileID).Order("last_watched desc").Find(&history)
	c.JSON(http.StatusOK, history)
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

func (h *Handler) AddToWatchlist(c *gin.Context) {
	var wl store.Watchlist
	if err := c.ShouldBindJSON(&wl); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var existing store.Watchlist
	if err := h.db.WithContext(c.Request.Context()).Where("profile_id = ? AND media_path = ?", wl.ProfileID, wl.MediaPath).First(&existing).Error; err == nil {
		c.JSON(http.StatusOK, existing) // already in list
		return
	}
	h.db.WithContext(c.Request.Context()).Create(&wl)
	c.JSON(http.StatusCreated, wl)
}

func (h *Handler) RemoveFromWatchlist(c *gin.Context) {
	profileID, _ := strconv.ParseUint(c.Query("profileId"), 10, 64)
	mediaPath := c.Query("mediaPath")
	h.db.WithContext(c.Request.Context()).Where("profile_id = ? AND media_path = ?", profileID, mediaPath).Delete(&store.Watchlist{})
	c.Status(http.StatusNoContent)
}

func (h *Handler) GetWatchlist(c *gin.Context) {
	profileID, err := strconv.ParseUint(c.Query("profileId"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "profileId query param required"})
		return
	}
	var list []store.Watchlist
	h.db.WithContext(c.Request.Context()).Where("profile_id = ?", profileID).Find(&list)
	c.JSON(http.StatusOK, list)
}

// ── Trending ──────────────────────────────────────────────────────────────────

func (h *Handler) GetTrending(c *gin.Context) {
	var results []struct{ MediaPath string }
	h.db.WithContext(c.Request.Context()).Model(&store.WatchHistory{}).
		Select("media_path").
		Group("media_path").
		Order("count(*) desc").
		Limit(10).
		Scan(&results)

	paths := make([]string, len(results))
	for i, r := range results {
		paths[i] = r.MediaPath
	}
	c.JSON(http.StatusOK, paths)
}
