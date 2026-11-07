package localstore

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	ctx := context.Background()
	c, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := c.PutObject(ctx, "Movies/a.mp4", strings.NewReader("0123456789"), "video/mp4"); err != nil {
		t.Fatal(err)
	}
	if !c.Exists(ctx, "Movies/a.mp4") || c.Exists(ctx, "Movies/nope.mp4") {
		t.Fatal("Exists wrong")
	}
	if n, err := c.HeadObject(ctx, "Movies/a.mp4"); err != nil || n != 10 {
		t.Fatalf("head: %d %v", n, err)
	}
	rc, n, err := c.GetObjectRange(ctx, "Movies/a.mp4", 2, 5)
	if err != nil || n != 4 {
		t.Fatalf("range: %d %v", n, err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "2345" {
		t.Fatalf("got %q", b)
	}
	rc, n, _ = c.GetObjectRange(ctx, "Movies/a.mp4", 0, -1)
	b, _ = io.ReadAll(rc)
	rc.Close()
	if n != 10 || string(b) != "0123456789" {
		t.Fatalf("full: %d %q", n, b)
	}
	objs, err := c.ListObjects(ctx, "Movies/")
	if err != nil || len(objs) != 1 || objs[0].Key != "Movies/a.mp4" || objs[0].Size != 10 {
		t.Fatalf("list: %+v %v", objs, err)
	}
	if err := c.PutObject(ctx, "../evil", strings.NewReader("x"), ""); err == nil {
		t.Fatal("traversal not rejected")
	}
}
