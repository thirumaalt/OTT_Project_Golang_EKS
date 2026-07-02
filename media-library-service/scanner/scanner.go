package scanner

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
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

type Scanner struct {
	mediaDirs []string
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

func New(mediaDir string) *Scanner {
	dirs := strings.Split(mediaDir, ",")
	for i, d := range dirs {
		dirs[i] = strings.TrimSpace(d)
	}
	return &Scanner{mediaDirs: dirs}
}

func (s *Scanner) ScanCategory(category, dirName string) ([]MediaItem, error) {
	items := []MediaItem{}

	for _, baseDir := range s.mediaDirs {
		categoryPath := filepath.Join(baseDir, dirName)
		foundSubdir := true

		// Check if directory exists (case-insensitive)
		if _, err := os.Stat(categoryPath); os.IsNotExist(err) {
			// Try to find case-insensitive match
			foundSubdir = false
			entries, err := os.ReadDir(baseDir)
			if err == nil {
				for _, entry := range entries {
					if entry.IsDir() && strings.EqualFold(entry.Name(), dirName) {
						categoryPath = filepath.Join(baseDir, entry.Name())
						foundSubdir = true
						break
					}
				}
			}
		}

		// If "Movies" category is requested but no subdirectory found,
		// fall back to scanning root-level files.
		if !foundSubdir && strings.EqualFold(category, "Movies") {
			rootItems, _ := s.scanRoot()
			items = append(items, rootItems...)
			continue
		}
		if !foundSubdir {
			continue
		}

		// Walk directory
		err := filepath.Walk(categoryPath, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil // Skip errors
			}

			// Skip hidden files/directories
			if strings.HasPrefix(info.Name(), ".") {
				if info.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}

			// Skip directories
			if info.IsDir() {
				return nil
			}

			// Check extension
			ext := strings.ToLower(filepath.Ext(info.Name()))
			if !videoExtensions[ext] {
				return nil
			}

			// Skip trailers, teasers, etc.
			lowerName := strings.ToLower(info.Name())
			for _, keyword := range skipKeywords {
				if strings.Contains(lowerName, keyword) {
					return nil
				}
			}

			// Get relative path
			relPath, err := filepath.Rel(baseDir, path)
			if err != nil {
				return nil
			}

			// Generate ID
			itemID := strings.ReplaceAll(relPath, string(os.PathSeparator), "_")

			// Clean title
			title := cleanTitle(info.Name())

			// Check for HLS
			hlsPath := filepath.Join(baseDir, "hls", itemID, "master.m3u8")
			var hlsURL *string
			if _, err := os.Stat(hlsPath); err == nil {
				url := "/media/hls/" + itemID + "/master.m3u8"
				hlsURL = &url
			}

			items = append(items, MediaItem{
				ID:           itemID,
				Title:        title,
				Category:     category,
				Path:         filepath.ToSlash(relPath),
				HLSUrl:       hlsURL,
				Size:         info.Size(),
				ModifiedTime: float64(info.ModTime().Unix()),
			})

			return nil
		})

		if err != nil {
			// Continue to next directory
		}
	}

	return items, nil
}

func (s *Scanner) ScanAll() ([]MediaItem, error) {
	allItems := []MediaItem{}

	categories := []struct {
		name    string
		dirName string
	}{
		{"Movies", "Movies"},
		{"TvShows", "TvShows"},
		{"Anime", "Anime"},
	}

	for _, cat := range categories {
		items, err := s.ScanCategory(cat.name, cat.dirName)
		if err != nil {
			// Log but continue
			continue
		}
		allItems = append(allItems, items...)
	}

	// If no items found from category subdirs, fall back to scanning root files.
	// This handles flat media layouts where files sit directly in the media dir.
	if len(allItems) == 0 {
		rootItems, err := s.scanRoot()
		if err == nil {
			allItems = append(allItems, rootItems...)
		}
	}

	return allItems, nil
}

// scanRoot scans video files directly in the top-level of each mediaDir
// and assigns them the "Movies" category.
func (s *Scanner) scanRoot() ([]MediaItem, error) {
	items := []MediaItem{}
	for _, baseDir := range s.mediaDirs {
		entries, err := os.ReadDir(baseDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			ext := strings.ToLower(filepath.Ext(name))
			if !videoExtensions[ext] {
				continue
			}
			lowerName := strings.ToLower(name)
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

			info, err := entry.Info()
			if err != nil {
				continue
			}

			itemID := strings.ReplaceAll(name, string(os.PathSeparator), "_")
			title := cleanTitle(name)

			// Check for HLS
			hlsPath := filepath.Join(baseDir, "hls", itemID, "master.m3u8")
			var hlsURL *string
			if _, err := os.Stat(hlsPath); err == nil {
				url := "/media/hls/" + itemID + "/master.m3u8"
				hlsURL = &url
			}

			items = append(items, MediaItem{
				ID:           itemID,
				Title:        title,
				Category:     "Movies",
				Path:         filepath.ToSlash(name),
				HLSUrl:       hlsURL,
				Size:         info.Size(),
				ModifiedTime: float64(info.ModTime().Unix()),
			})
		}
	}
	return items, nil
}

func (s *Scanner) Search(query, category string) ([]MediaItem, error) {
	var items []MediaItem
	var err error

	if category != "" {
		// Scan specific category
		dirName := getCategoryDir(category)
		items, err = s.ScanCategory(category, dirName)
	} else {
		// Scan all
		items, err = s.ScanAll()
	}

	if err != nil {
		return nil, err
	}

	// Filter by query
	queryLower := strings.ToLower(query)
	filtered := []MediaItem{}
	for _, item := range items {
		if strings.Contains(strings.ToLower(item.Title), queryLower) {
			filtered = append(filtered, item)
		}
	}

	return filtered, nil
}

func (s *Scanner) GetMediaPath(relativePath string) string {
	for _, dir := range s.mediaDirs {
		p := filepath.Join(dir, filepath.FromSlash(relativePath))
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if len(s.mediaDirs) > 0 {
		return filepath.Join(s.mediaDirs[0], filepath.FromSlash(relativePath))
	}
	return ""
}

func (s *Scanner) GetHLSPath(fileID, filename string) string {
	for _, dir := range s.mediaDirs {
		p := filepath.Join(dir, "hls", fileID, filename)
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	if len(s.mediaDirs) > 0 {
		return filepath.Join(s.mediaDirs[0], "hls", fileID, filename)
	}
	return ""
}

func cleanTitle(filename string) string {
	// Remove extension
	title := strings.TrimSuffix(filename, filepath.Ext(filename))

	// Remove year in parentheses/brackets
	yearPattern := regexp.MustCompile(`\s*[\(\[]?\d{4}[\)\]]?\s*`)
	title = yearPattern.ReplaceAllString(title, "")

	// Clean up
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
