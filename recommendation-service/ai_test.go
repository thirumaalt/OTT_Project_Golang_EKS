package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

var testRecent = []Item{{ID: 10, Title: "Se7en", Genre: "Crime, Thriller"}}

var testPool = []Item{{ID: 1, Title: "Heat"}, {ID: 2, Title: "Ronin"}, {ID: 3, Title: "Collateral"}, {ID: 4, Title: "Up"}}

func TestParsePicksFiltersBadIDsAndDuplicates(t *testing.T) {
	got, _, err := parsePicks("```json\n{\"picks\":[{\"id\":2,\"reason\":\"Like Se7en, a dark crime hunt.\"},{\"id\":99,\"reason\":\"invented\"},{\"id\":2,\"reason\":\"dup\"},{\"id\":3,\"reason\":\"Same grim tone as Se7en.\"},{\"id\":1,\"reason\":\"Crime again.\"}]}\n```", testPool, testRecent)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != 2 || got[1].ID != 3 || got[2].ID != 1 {
		t.Fatalf("unexpected picks: %+v", got)
	}
	if got[0].Reason != "Like Se7en, a dark crime hunt." {
		t.Fatalf("reason lost: %q", got[0].Reason)
	}
}

func TestParsePicksRejectsTooFewOrBadJSON(t *testing.T) {
	if _, _, err := parsePicks(`{"picks":[{"id":1,"reason":"x"}]}`, testPool, testRecent); err == nil {
		t.Fatal("expected error for <3 valid picks")
	}
	if _, _, err := parsePicks("sorry, here are some films", testPool, testRecent); err == nil {
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

func TestRepairsSelfReferencingAndGenericReasons(t *testing.T) {
	pool := []Item{
		{ID: 1, Title: "Parasite", Genre: "Comedy, Thriller, Drama"},
		{ID: 2, Title: "Prisoners", Genre: "Drama, Thriller, Crime"},
		{ID: 3, Title: "Up", Genre: "Animation"},
	}
	content := `{"picks":[
		{"id":1,"reason":"Enjoy a dark comedy similar to Parasite."},
		{"id":2,"reason":"An intense thriller with kidnapping themes."},
		{"id":3,"reason":"Fun for fans of Se7en?"}]}`
	got, _, err := parsePicks(content, pool, testRecent)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Reason != "Shares its thriller feel with Se7en, which you watched." {
		t.Fatalf("self-reference not repaired: %q", got[0].Reason)
	}
	if got[1].Reason != "Shares its crime and thriller feel with Se7en, which you watched." {
		t.Fatalf("generic reason not repaired: %q", got[1].Reason)
	}
	if got[2].Reason != "Fun for fans of Se7en?" {
		t.Fatalf("valid reason changed: %q", got[2].Reason)
	}
}
