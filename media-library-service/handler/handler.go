package handler

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/myflix/media-library-service/scanner"
)

type Handler struct {
	scanner *scanner.Scanner
}

func New(s *scanner.Scanner) *Handler {
	return &Handler{scanner: s}
}

type LibraryResponse struct {
	Code    int                 `json:"code"`
	Status  string              `json:"status"`
	Message string              `json:"message"`
	Total   int                 `json:"total"`
	Results []scanner.MediaItem `json:"results"`
}

func (h *Handler) GetLibrary(c *gin.Context) {
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
		items, err = h.scanner.ScanCategory(category, dirName)
	} else {
		items, err = h.scanner.ScanAll()
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to scan library"})
		return
	}

	// Sort
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

	// Pagination
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

	items, err := h.scanner.Search(query, category)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Search failed"})
		return
	}

	// Pagination
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
		"source":  "filesystem",
	})
}

func (h *Handler) Stream(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path parameter required"})
		return
	}

	// Security: prevent directory traversal
	cleanPath := filepath.Clean(path)
	if strings.Contains(cleanPath, "..") {
		c.JSON(http.StatusForbidden, gin.H{"error": "Access denied"})
		return
	}

	fullPath := h.scanner.GetMediaPath(cleanPath)

	// Check if file exists
	fileInfo, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Get file size
	size := fileInfo.Size()

	// Parse Range header
	rangeHeader := c.GetHeader("Range")
	if rangeHeader == "" {
		// No range, serve entire file
		c.File(fullPath)
		return
	}

	// Parse range
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

	// Validate range
	if start < 0 || start > end || start >= size {
		c.Header("Content-Range", "bytes */"+strconv.FormatInt(size, 10))
		c.Status(http.StatusRequestedRangeNotSatisfiable)
		return
	}

	if end >= size {
		end = size - 1
	}

	contentLength := end - start + 1

	// Open file
	file, err := os.Open(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file"})
		return
	}
	defer file.Close()

	// Seek to start position
	_, err = file.Seek(start, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to seek file"})
		return
	}

	// Set headers
	c.Header("Content-Range", "bytes "+strconv.FormatInt(start, 10)+"-"+strconv.FormatInt(end, 10)+"/"+strconv.FormatInt(size, 10))
	c.Header("Accept-Ranges", "bytes")
	c.Header("Content-Length", strconv.FormatInt(contentLength, 10))
	c.Header("Content-Type", getContentType(fullPath))

	// Stream the range
	c.Status(http.StatusPartialContent)
	io.CopyN(c.Writer, file, contentLength)
}

func (h *Handler) Upload(c *gin.Context) {
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

	// Map category to directory name
	dirName := getCategoryDir(category)

	// Build destination directory: <mediaDir>/<Category>/
	baseDir := h.scanner.GetMediaPath("") // returns mediaDirs[0] when path not found
	// GetMediaPath returns mediaDirs[0]+"/", strip trailing separator
	destDir := filepath.Join(baseDir, dirName)
	if err := os.MkdirAll(destDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create directory"})
		return
	}

	filename := filepath.Base(fileHeader.Filename)
	// Sanitize: reject traversal attempts
	if strings.Contains(filename, "..") || strings.ContainsAny(filename, `/\`) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid filename"})
		return
	}

	destPath := filepath.Join(destDir, filename)

	src, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to open uploaded file"})
		return
	}
	defer src.Close()

	dst, err := os.Create(destPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save file"})
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, src); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to write file"})
		return
	}

	relPath := dirName + "/" + filename
	if title == "" {
		title = strings.TrimSuffix(filename, filepath.Ext(filename))
	}

	c.JSON(http.StatusOK, gin.H{
		"path":     relPath,
		"title":    title,
		"category": category,
		"filename": filename,
	})
}

func (h *Handler) GetHLSFile(c *gin.Context) {
	fileID := c.Param("file_id")
	filename := c.Param("filename")

	// Security check
	if strings.Contains(fileID, "..") || strings.Contains(filename, "..") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid path"})
		return
	}

	hlsPath := h.scanner.GetHLSPath(fileID, filename)

	// Check if file exists
	if _, err := os.Stat(hlsPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}

	// Set content type
	if strings.HasSuffix(filename, ".m3u8") {
		c.Header("Content-Type", "application/vnd.apple.mpegurl")
	} else {
		c.Header("Content-Type", "video/mp2t")
	}

	c.File(hlsPath)
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

func getContentType(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
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
