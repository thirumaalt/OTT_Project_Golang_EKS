package handler

import (
	"io"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/myflix/media-library-service/s3store"
	"github.com/myflix/media-library-service/scanner"
)

// Handler now holds both the Scanner (for listing/searching, via S3
// ListObjects) and the S3 store client directly (for the byte-level
// operations — streaming ranges and uploading — that don't belong in
// Scanner's listing-focused API).
type Handler struct {
	scanner *scanner.Scanner
	store   *s3store.Client
}

func New(s *scanner.Scanner, store *s3store.Client) *Handler {
	return &Handler{scanner: s, store: store}
}

type LibraryResponse struct {
	Code    int                 `json:"code"`
	Status  string              `json:"status"`
	Message string              `json:"message"`
	Total   int                 `json:"total"`
	Results []scanner.MediaItem `json:"results"`
}

func (h *Handler) GetLibrary(c *gin.Context) {
	ctx := c.Request.Context()
	category := c.Query("category")
	sortBy := c.DefaultQuery("sort", "title_asc")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))

	if limit < 1 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	var items []scanner.MediaItem
	var err error

	if category != "" {
		dirName := getCategoryDir(category)
		items, err = h.scanner.ScanCategory(ctx, category, dirName)
	} else {
		items, err = h.scanner.ScanAll(ctx)
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to scan library"})
		return
	}

	switch sortBy {
	case "title_asc":
		sort.Slice(items, func(i, j int) bool {
			return strings.ToLower(items[i].Title) < strings.ToLower(items[j].Title)
		})
	case "title_desc":
		sort.Slice(items, func(i, j int) bool {
			return strings.ToLower(items[i].Title) > strings.ToLower(items[j].Title)
		})
	case "date_asc":
		sort.Slice(items, func(i, j int) bool {
			return items[i].ModifiedTime < items[j].ModifiedTime
		})
	case "date_desc":
		sort.Slice(items, func(i, j int) bool {
			return items[i].ModifiedTime > items[j].ModifiedTime
		})
	}

	total := len(items)
	start := offset
	end := offset + limit
	if end > total {
		end = total
	}
	if start > total {
		start = total
	}

	paginated := items[start:end]

	c.JSON(http.StatusOK, LibraryResponse{
		Code:    200,
		Status:  "success",
		Message: "Library retrieved successfully",
		Total:   total,
		Results: paginated,
	})
}

func (h *Handler) Search(c *gin.Context) {
	ctx := c.Request.Context()
	query := c.Query("q")
	category := c.Query("category")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))

	if len(query) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"status":  "error",
			"message": "Search query must be at least 2 characters",
			"total":   0,
			"results": []scanner.MediaItem{},
		})
		return
	}

	items, err := h.scanner.Search(ctx, query, category)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Search failed"})
		return
	}

	total := len(items)
	start := offset
	end := offset + limit
	if end > total {
		end = total
	}
	if start > total {
		start = total
	}

	paginated := items[start:end]

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"status":  "success",
		"message": "Search completed",
		"query":   query,
		"total":   total,
		"results": paginated,
		"source":  "s3",
	})
}

// Stream serves a media file, supporting HTTP Range requests for seeking —
// same external behavior as before, but bytes now come from S3 via
// GetObjectRange instead of os.Open + Seek.
func (h *Handler) Stream(c *gin.Context) {
	ctx := c.Request.Context()
	reqPath := c.Query("path")
	if reqPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path parameter required"})
		return
	}

	cleanPath := path.Clean(reqPath)
	if strings.Contains(cleanPath, "..") {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	key := h.scanner.GetMediaKey(cleanPath)

	size, err := h.store.HeadObject(ctx, key)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	rangeHeader := c.GetHeader("Range")
	if rangeHeader == "" {
		body, contentLength, err := h.store.GetObjectRange(ctx, key, 0, -1)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
			return
		}
		defer body.Close()

		c.Header("Content-Type", getContentType(key))
		c.Header("Content-Length", strconv.FormatInt(contentLength, 10))
		c.Status(http.StatusOK)
		io.Copy(c.Writer, body)
		return
	}

	rangePattern := regexp.MustCompile(`bytes=(\d+)-(\d*)`)
	matches := rangePattern.FindStringSubmatch(rangeHeader)
	if matches == nil {
		c.Header("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
		c.Status(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	start, _ := strconv.ParseInt(matches[1], 10, 64)
	end := size - 1
	if matches[2] != "" {
		end, _ = strconv.ParseInt(matches[2], 10, 64)
	}

	if start < 0 || start > end || start >= size {
		c.Header("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
		c.Status(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	if end >= size {
		end = size - 1
	}

	contentLength := end - start + 1

	body, _, err := h.store.GetObjectRange(ctx, key, start, end)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file range"})
		return
	}
	defer body.Close()

	c.Header("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(size, 10))
	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Length", strconv.FormatInt(contentLength, 10))
	c.Header("Content-Type", getContentType(key))

	c.Status(http.StatusPartialContent)
	io.CopyN(c.Writer, body, contentLength)
}

// Upload streams the incoming multipart file straight to S3 — no temp file,
// no local disk touched at any point.
func (h *Handler) Upload(c *gin.Context) {
	ctx := c.Request.Context()
	title := c.PostForm("title")
	category := c.PostForm("category")
	if category == "" {
		category = "movies"
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file field required"})
		return
	}

	dirName := getCategoryDir(category)

	filename := sanitizeFilename(fileHeader.Filename)
	if filename == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	key := dirName + "/" + filename

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open uploaded file"})
		return
	}
	defer src.Close()

	contentType := fileHeader.Header.Get("Content-Type")
	if contentType == "" {
		contentType = getContentType(filename)
	}

	if err := h.store.PutObject(ctx, key, src, contentType); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to upload file"})
		return
	}

	if title == "" {
		title = strings.TrimSuffix(filename, path.Ext(filename))
	}

	c.JSON(http.StatusOK, gin.H{
		"path":     key,
		"title":    title,
		"category": category,
		"filename": filename,
	})
}

func (h *Handler) GetHLSFile(c *gin.Context) {
	ctx := c.Request.Context()
	fileID := c.Param("file_id")
	filename := c.Param("filename")

	if strings.Contains(fileID, "..") || strings.Contains(filename, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	key := h.scanner.GetHLSKey(fileID, filename)

	if !h.store.Exists(ctx, key) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	if strings.HasSuffix(filename, ".m3u8") {
		c.Header("Content-Type", "application/vnd.apple.mpegurl")
	} else {
		c.Header("Content-Type", "video/mp2t")
	}

	body, contentLength, err := h.store.GetObjectRange(ctx, key, 0, -1)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file"})
		return
	}
	defer body.Close()

	c.Header("Content-Length", strconv.FormatInt(contentLength, 10))
	c.Status(http.StatusOK)
	io.Copy(c.Writer, body)
}

// sanitizeFilename strips any directory components from a client-supplied
// filename, tolerating both "/" and "\" separators since the uploading
// client could be any OS. Rejects traversal attempts outright.
func sanitizeFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	if name == "." || name == "/" || strings.Contains(name, "..") {
		return ""
	}
	return name
}

func getCategoryDir(category string) string {
	switch strings.ToLower(category) {
	case "movies":
		return "Movies"
	case "tvshows", "series":
		return "TvShows"
	case "anime":
		return "Anime"
	default:
		return "Movies"
	}
}

func getContentType(p string) string {
	ext := strings.ToLower(path.Ext(p))
	switch ext {
	case ".mp4":
		return "video/mp4"
	case ".mkv":
		return "video/x-matroska"
	case ".avi":
		return "video/x-msvideo"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	default:
		return "application/octet-stream"
	}
}
