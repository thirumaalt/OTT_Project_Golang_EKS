package s3store

import (
	"context"
	"io"
)

// Store is the storage abstraction used by the handler and scanner.
// *Client (S3) and localstore.Client (local disk) both implement it.
type Store interface {
	ListObjects(ctx context.Context, prefix string) ([]ObjectInfo, error)
	GetObjectRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, int64, error)
	HeadObject(ctx context.Context, key string) (int64, error)
	PutObject(ctx context.Context, key string, body io.Reader, contentType string) error
	Exists(ctx context.Context, key string) bool
}

var _ Store = (*Client)(nil)
