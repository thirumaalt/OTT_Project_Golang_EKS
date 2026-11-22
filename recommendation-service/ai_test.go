package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

var testPool = []Item{{ID: 1, Title: "Heat"}, {ID: 2, Title: "Ronin"}, {ID: 3, Title: "Collateral"}, {ID: 4, Title: "Up"}}

func TestParsePicksFiltersBadIDsAndDuplicates(t *testing.T) {
	got, err := parsePicks("```json\n{\"picks\":[{\"id\":2,\"reason\":\"Like Heat.\"},{\"id\":99,\"reason\":\"invented\"},{\"id\":2,\"reason\":\"dup\"},{\"id\":3,\"reason\":\"Same director.\"},{\"id\":1,\"reason\":\"Crime again.\"}]}\n```", testPool)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != 2 || got[1].ID != 3 || got[2].ID != 1 {
		t.Fatalf("unexpected picks: %+v", got)
	}
	if got[0].Reason != "Like Heat." {
		t.Fatalf("reason lost: %q", got[0].Reason)
	}
}

func TestParsePicksRejectsTooFewOrBadJSON(t *testing.T) {
	if _, err := parsePicks(`{"picks":[{"id":1,"reason":"x"}]}`, testPool); err == nil {
		t.Fatal("expected error for <3 valid picks")
	}
	if _, err := parsePicks("sorry, here are some films", testPool); err == nil {
		t.Fatal("expected error for non-JSON")
	}
}

func TestCallLLM(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		w.Write([]byte(`{"choices":[{"message":{"content":"{\"picks\":[]}"}}]}`))
	}))
	defer srv.Close()
	llmBase = srv.URL + "/v1"
	out, err := callLLM(context.Background(), "s", "u")
	if err != nil || out != `{"picks":[]}` {
		t.Fatalf("out=%q err=%v", out, err)
	}
}
