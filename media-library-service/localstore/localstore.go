// Package localstore is a local-disk implementation of s3store.Store.
// Keys map to files under Root (e.g. "Movies/x.mp4" -> <Root>/Movies/x.mp4),
// so it can share a PersistentVolume with the transcoding service.
package localstore

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/myflix/media-library-service/s3store"
)

type Client struct {
	Root string
}

func New(root string) (*Client, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolving root: %w", err)
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, fmt.Errorf("creating root %q: %w", abs, err)
	}
	return &Client{Root: abs}, nil
}

var _ s3store.Store = (*Client)(nil)

// path resolves a key to a file path and rejects anything escaping Root.
func (c *Client) path(key string) (string, error) {
	p := filepath.Join(c.Root, filepath.FromSlash(key))
	if p != c.Root && !strings.HasPrefix(p, c.Root+string(os.PathSeparator)) {
		return "", fmt.Errorf("invalid key %q", key)
	}
	return p, nil
}

func (c *Client) ListObjects(ctx context.Context, prefix string) ([]s3store.ObjectInfo, error) {
	var results []s3store.ObjectInfo
	err := filepath.WalkDir(c.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(c.Root, p)
		if err != nil {
			return err
		}
		key := filepath.ToSlash(rel)
		if !strings.HasPrefix(key, prefix) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		results = append(results, s3store.ObjectInfo{Key: key, Size: info.Size(), ModifiedTime: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("listing objects: %w", err)
	}
	return results, nil
}

type sectionReadCloser struct {
	*io.SectionReader
	f *os.File
}

func (s sectionReadCloser) Close() error { return s.f.Close() }

// GetObjectRange returns bytes [start,end] inclusive; end == -1 means to EOF.
func (c *Client) GetObjectRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, int64, error) {
	p, err := c.path(key)
	if err != nil {
		return nil, 0, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, 0, fmt.Errorf("getting object range: %w", err)
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		f.Close()
		return nil, 0, fmt.Errorf("getting object range: not a file: %q", key)
	}
	size := st.Size()
	if end < 0 || end >= size {
		end = size - 1
	}
	if start < 0 || start > end {
		f.Close()
		return nil, 0, fmt.Errorf("getting object range: invalid range %d-%d", start, end)
	}
	length := end - start + 1
	return sectionReadCloser{io.NewSectionReader(f, start, length), f}, length, nil
}

func (c *Client) HeadObject(ctx context.Context, key string) (int64, error) {
	p, err := c.path(key)
	if err != nil {
		return 0, err
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return 0, fmt.Errorf("head object: %q not found", key)
	}
	return st.Size(), nil
}

func (c *Client) PutObject(ctx context.Context, key string, body io.Reader, contentType string) error {
	p, err := c.path(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return fmt.Errorf("putting object: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(p), ".upload-*")
	if err != nil {
		return fmt.Errorf("putting object: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, body); err != nil {
		tmp.Close()
		return fmt.Errorf("putting object: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("putting object: %w", err)
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return fmt.Errorf("putting object: %w", err)
	}
	if err := os.Rename(tmp.Name(), p); err != nil {
		return fmt.Errorf("putting object: %w", err)
	}
	return nil
}

func (c *Client) Exists(ctx context.Context, key string) bool {
	p, err := c.path(key)
	if err != nil {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
