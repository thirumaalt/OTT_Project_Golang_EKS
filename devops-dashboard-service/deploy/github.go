// Package deploy talks to the GitHub API to bump image tags in manifest
// files — the piece that automates the step that got missed manually
// earlier in this project (pushing a new image without updating the
// Deployment YAML that references it, which reports Synced/Healthy while
// silently still running the old code).
package deploy

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
)

type GitHubClient struct {
	Token      string
	Owner      string
	Repo       string
	httpClient *http.Client
}

func NewGitHubClient(token, owner, repo string) *GitHubClient {
	return &GitHubClient{
		Token:      token,
		Owner:      owner,
		Repo:       repo,
		httpClient: &http.Client{},
	}
}

type fileContentResponse struct {
	Content string `json:"content"`
	SHA     string `json:"sha"`
}

// getFile fetches a file's current content and SHA (the SHA is required
// by GitHub's API to prove you're updating the version you think you are —
// without it, a concurrent edit could be silently overwritten).
func (g *GitHubClient) getFile(ctx context.Context, path, branch string) (content string, sha string, err error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/contents/%s?ref=%s", g.Owner, g.Repo, path, branch)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", "", err
	}
	g.setHeaders(req)

	resp, err := g.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("requesting file: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("GitHub API returned %d: %s", resp.StatusCode, string(body))
	}

	var parsed fileContentResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", "", fmt.Errorf("parsing response: %w", err)
	}

	decoded, err := base64.StdEncoding.DecodeString(parsed.Content)
	if err != nil {
		return "", "", fmt.Errorf("decoding file content: %w", err)
	}

	return string(decoded), parsed.SHA, nil
}

type updateFileRequest struct {
	Message string `json:"message"`
	Content string `json:"content"`
	SHA     string `json:"sha"`
	Branch  string `json:"branch"`
}

func (g *GitHubClient) updateFile(ctx context.Context, path, newContent, sha, branch, message string) error {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/contents/%s", g.Owner, g.Repo, path)

	payload := updateFileRequest{
		Message: message,
		Content: base64.StdEncoding.EncodeToString([]byte(newContent)),
		SHA:     sha,
		Branch:  branch,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	g.setHeaders(req)
	req.Header.Set("Content-Type", "application/json")

	resp, err := g.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("committing update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("GitHub API returned %d: %s", resp.StatusCode, string(respBody))
	}

	return nil
}

func (g *GitHubClient) setHeaders(req *http.Request) {
	req.Header.Set("Authorization", "Bearer "+g.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
}

// BumpImageTag rewrites the `image:` line for a given ECR repository inside
// a manifest file, using a targeted regex substitution rather than parsing
// and re-serializing the whole YAML — this preserves every comment and the
// exact formatting of the rest of the file, the same care taken throughout
// this project whenever a ConfigMap's embedded config got regenerated.
//
// registry, e.g. "723300665462.dkr.ecr.ap-south-1.amazonaws.com"
// repo, e.g. "myflix/auth-service"
func (g *GitHubClient) BumpImageTag(ctx context.Context, manifestPath, branch, registry, repo, newTag string) error {
	content, sha, err := g.getFile(ctx, manifestPath, branch)
	if err != nil {
		return fmt.Errorf("fetching manifest: %w", err)
	}

	// Matches: image: 723300665462...amazonaws.com/myflix/auth-service:v1
	// and replaces only the tag portion, leaving registry/repo untouched.
	pattern := regexp.MustCompile(fmt.Sprintf(
		`(image:\s*%s/%s):[^\s]+`,
		regexp.QuoteMeta(registry), regexp.QuoteMeta(repo),
	))

	if !pattern.MatchString(content) {
		return fmt.Errorf("no image line found for %s/%s in %s — check the manifest path and repo name", registry, repo, manifestPath)
	}

	updated := pattern.ReplaceAllString(content, "${1}:"+newTag)

	message := fmt.Sprintf("Deploy %s:%s via devops-dashboard-service", repo, newTag)
	if err := g.updateFile(ctx, manifestPath, updated, sha, branch, message); err != nil {
		return fmt.Errorf("committing tag bump: %w", err)
	}

	return nil
}
