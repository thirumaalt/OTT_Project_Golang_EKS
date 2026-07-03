// Package s3store wraps the AWS SDK v2 S3 client for media-library-service.
//
// Credentials are never set explicitly here. On EKS, this service runs under
// the "media-library-service" ServiceAccount (created via
// `eksctl create iamserviceaccount`), which is annotated with an IRSA IAM
// role ARN. config.LoadDefaultConfig walks the standard AWS credential
// chain and picks up that role's temporary, auto-rotated credentials with
// no code-level awareness that IRSA is even involved.
package s3store

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Client struct {
	s3     *s3.Client
	Bucket string
}

// New creates an S3-backed store client for the given bucket.
// region should match where the bucket was created (ap-south-1 for MyFlix).
func New(ctx context.Context, bucket, region string) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("loading AWS config: %w", err)
	}

	return &Client{
		s3:     s3.NewFromConfig(cfg),
		Bucket: bucket,
	}, nil
}

// ListObjects returns all object keys under the given prefix.
// This replaces filepath.Walk — S3 has no directories, "prefix" is the
// closest equivalent (e.g. "Movies/" behaves like listing that folder).
func (c *Client) ListObjects(ctx context.Context, prefix string) ([]ObjectInfo, error) {
	var results []ObjectInfo

	paginator := s3.NewListObjectsV2Paginator(c.s3, &s3.ListObjectsV2Input{
		Bucket: aws.String(c.Bucket),
		Prefix: aws.String(prefix),
	})

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("listing objects: %w", err)
		}
		for _, obj := range page.Contents {
			modTime := time.Time{}
			if obj.LastModified != nil {
				modTime = *obj.LastModified
			}
			results = append(results, ObjectInfo{
				Key:          aws.ToString(obj.Key),
				Size:         aws.ToInt64(obj.Size),
				ModifiedTime: modTime,
			})
		}
	}

	return results, nil
}

// ObjectInfo mirrors the pieces of scanner.MediaItem that come from S3 metadata.
type ObjectInfo struct {
	Key          string
	Size         int64
	ModifiedTime time.Time
}

// GetObjectRange fetches a byte range from an object — this is what powers
// video seeking (HTTP Range requests) via the Stream handler.
// end == -1 means "to the end of the object".
func (c *Client) GetObjectRange(ctx context.Context, key string, start, end int64) (io.ReadCloser, int64, error) {
	rangeHeader := fmt.Sprintf("bytes=%d-", start)
	if end >= 0 {
		rangeHeader = fmt.Sprintf("bytes=%d-%d", start, end)
	}

	out, err := c.s3.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.Bucket),
		Key:    aws.String(key),
		Range:  aws.String(rangeHeader),
	})
	if err != nil {
		return nil, 0, fmt.Errorf("getting object range: %w", err)
	}

	return out.Body, aws.ToInt64(out.ContentLength), nil
}

// HeadObject returns just the size of an object, without downloading it —
// used to compute total size before serving a Range request.
func (c *Client) HeadObject(ctx context.Context, key string) (int64, error) {
	out, err := c.s3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return 0, fmt.Errorf("head object: %w", err)
	}
	return aws.ToInt64(out.ContentLength), nil
}

// PutObject uploads data to the given key — used by the Upload handler.
func (c *Client) PutObject(ctx context.Context, key string, body io.Reader, contentType string) error {
	_, err := c.s3.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(c.Bucket),
		Key:         aws.String(key),
		Body:        body,
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return fmt.Errorf("putting object: %w", err)
	}
	return nil
}

// Exists checks whether a key exists in the bucket (e.g. checking for an
// HLS master playlist before assuming a video isn't yet transcoded).
func (c *Client) Exists(ctx context.Context, key string) bool {
	_, err := c.s3.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.Bucket),
		Key:    aws.String(key),
	})
	return err == nil
}
