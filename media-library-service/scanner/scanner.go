package scanner

import (
	"context"
	"path"
	"regexp"
	"strings"

	"github.com/myflix/media-library-service/s3store"
)

type MediaItem struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Category     string  `json:"category"`
	Path         string  `json:"path"`
	HLSUrl       *string `json:"hls_url,omitempty"`
	Size         int64   `json:"size"`
	ModifiedTime float64 `json:"modified_time"`
}

// Scanner now lists media from S3 instead of walking a local directory tree.
// There's no "mediaDirs" concept anymore — one bucket is the single source
// of truth, and S3 key prefixes (e.g. "Movies/") play the role directories
// used to play locally.
type Scanner struct {
	store *s3store.Client
}

var videoExtensions = map[string]bool{
	".mp4":  true,
	".mkv":  true,
	".avi":  true,
	".mov":  true,
	".webm": true,
	".flv":  true,
	".wmv":  true,
}

var skipKeywords = []string{"trailer", "teaser", "sample", "featurette"}

func New(store *s3store.Client) *Scanner {
	return &Scanner{store: store}
}

// ScanCategory lists every media file under a category's key prefix
// (e.g. prefix "Movies/"). Every Scanner method now takes a context.Context
// because S3 calls are network calls, not local disk reads — the context is
// what lets an in-flight request be cancelled/timed out upstream.
func (s *Scanner) ScanCategory(ctx context.Context, category, dirName string) ([]MediaItem, error) {
	prefix := dirName + "/"

	objects, err := s.store.ListObjects(ctx, prefix)
	if err != nil {
		return nil, err
	}

	items := s.objectsToMediaItems(ctx, objects, category)

	// Fallback: if "Movies" is requested but nothing lives under "Movies/",
	// treat top-level (no-prefix) objects as movies — mirrors the old
	// scanRoot() fallback for flat bucket layouts.
	if len(items) == 0 && strings.EqualFold(category, "Movies") {
		return s.scanRoot(ctx)
	}

	return items, nil
}

func (s *Scanner) ScanAll(ctx context.Context) ([]MediaItem, error) {
	var allItems []MediaItem

	categories := []struct {
		name    string
		dirName string
	}{
		{"Movies", "Movies"},
		{"TvShows", "TvShows"},
		{"Anime", "Anime"},
	}

	for _, cat := range categories {
		items, err := s.ScanCategory(ctx, cat.name, cat.dirName)
		if err != nil {
			continue // log but keep going, same behavior as before
		}
		allItems = append(allItems, items...)
	}

	if len(allItems) == 0 {
		rootItems, err := s.scanRoot(ctx)
		if err == nil {
			allItems = append(allItems, rootItems...)
		}
	}

	return allItems, nil
}

// scanRoot lists every object in the bucket with no prefix filter, then
// keeps only the ones that look like top-level files (no "/" in their key
// beyond the filename itself) — the S3 equivalent of "files sitting
// directly in the media dir, not in a category subfolder".
func (s *Scanner) scanRoot(ctx context.Context) ([]MediaItem, error) {
	objects, err := s.store.ListObjects(ctx, "")
	if err != nil {
		return nil, err
	}

	var topLevel []s3store.ObjectInfo
	for _, obj := range objects {
		if !strings.Contains(obj.Key, "/") {
			topLevel = append(topLevel, obj)
		}
	}

	return s.objectsToMediaItems(ctx, topLevel, "Movies"), nil
}

// objectsToMediaItems applies the same filtering/cleanup rules the old
// filepath.Walk callback did: skip hidden/system keys, filter by extension,
// skip trailer/teaser keywords, generate a stable ID, check for an HLS
// playlist, and build the final MediaItem.
func (s *Scanner) objectsToMediaItems(ctx context.Context, objects []s3store.ObjectInfo, category string) []MediaItem {
	var items []MediaItem

	for _, obj := range objects {
		filename := path.Base(obj.Key)

		if strings.HasPrefix(filename, ".") {
			continue
		}

		ext := strings.ToLower(path.Ext(filename))
		if !videoExtensions[ext] {
			continue
		}

		lowerName := strings.ToLower(filename)
		skip := false
		for _, kw := range skipKeywords {
			if strings.Contains(lowerName, kw) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}

		itemID := strings.ReplaceAll(obj.Key, "/", "_")
		title := cleanTitle(filename)

		hlsKey := "hls/" + itemID + "/master.m3u8"
		var hlsURL *string
		if s.store.Exists(ctx, hlsKey) {
			url := "/media/hls/" + itemID + "/master.m3u8"
			hlsURL = &url
		}

		items = append(items, MediaItem{
			ID:           itemID,
			Title:        title,
			Category:     category,
			Path:         obj.Key,
			HLSUrl:       hlsURL,
			Size:         obj.Size,
			ModifiedTime: float64(obj.ModifiedTime.Unix()),
		})
	}

	return items
}

func (s *Scanner) Search(ctx context.Context, query, category string) ([]MediaItem, error) {
	var items []MediaItem
	var err error

	if category != "" {
		dirName := getCategoryDir(category)
		items, err = s.ScanCategory(ctx, category, dirName)
	} else {
		items, err = s.ScanAll(ctx)
	}

	if err != nil {
		return nil, err
	}

	queryLower := strings.ToLower(query)
	var filtered []MediaItem
	for _, item := range items {
		if strings.Contains(strings.ToLower(item.Title), queryLower) {
			filtered = append(filtered, item)
		}
	}

	return filtered, nil
}

// GetMediaKey returns the S3 object key for a relative path. With a single
// bucket as the source of truth, this is mostly pass-through — kept as its
// own method (rather than using relativePath directly in handler.go) so
// there's one place to adjust if a media-root prefix is ever introduced.
func (s *Scanner) GetMediaKey(relativePath string) string {
	return strings.TrimPrefix(relativePath, "/")
}

// GetHLSKey returns the S3 object key for an HLS segment/playlist file.
func (s *Scanner) GetHLSKey(fileID, filename string) string {
	return "hls/" + fileID + "/" + filename
}

func cleanTitle(filename string) string {
	title := strings.TrimSuffix(filename, path.Ext(filename))

	yearPattern := regexp.MustCompile(`\s*[\(\[]?\d{4}[\)\]]?\s*`)
	title = yearPattern.ReplaceAllString(title, "")

	title = strings.TrimSpace(title)

	return title
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
