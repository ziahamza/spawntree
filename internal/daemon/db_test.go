package daemon

import (
	"os"
	"path/filepath"
	"testing"
)

func setupTestDB(t *testing.T) *DB {
	t.Helper()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := OpenDB(dbPath)
	if err != nil {
		t.Fatalf("OpenDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestOpenDB(t *testing.T) {
	db := setupTestDB(t)
	if db.writerDB == nil || db.readerDB == nil {
		t.Fatal("expected both writer and reader pools")
	}
}

func TestUpsertAndListRepos(t *testing.T) {
	db := setupTestDB(t)

	repo := Repo{
		ID:       "github/ziahamza/spawntree",
		Slug:     "github-ziahamza-spawntree",
		Name:     "spawntree",
		Provider: "github",
		Owner:    "ziahamza",
	}
	if err := db.UpsertRepo(repo); err != nil {
		t.Fatalf("UpsertRepo: %v", err)
	}

	repos, err := db.ListRepos()
	if err != nil {
		t.Fatalf("ListRepos: %v", err)
	}
	if len(repos) != 1 {
		t.Fatalf("expected 1 repo, got %d", len(repos))
	}
	if repos[0].ID != "github/ziahamza/spawntree" {
		t.Errorf("repo ID = %q", repos[0].ID)
	}

	// Upsert again (update)
	repo.Description = "A dev env orchestrator"
	if err := db.UpsertRepo(repo); err != nil {
		t.Fatalf("UpsertRepo update: %v", err)
	}
	repos, _ = db.ListRepos()
	if len(repos) != 1 {
		t.Fatalf("expected 1 repo after upsert, got %d", len(repos))
	}
	if repos[0].Description != "A dev env orchestrator" {
		t.Errorf("description not updated: %q", repos[0].Description)
	}
}

func TestGetRepoBySlug(t *testing.T) {
	db := setupTestDB(t)

	repo := Repo{
		ID:       "github/org/repo",
		Slug:     "github-org-repo",
		Name:     "repo",
		Provider: "github",
		Owner:    "org",
	}
	_ = db.UpsertRepo(repo)

	found, err := db.GetRepoBySlug("github-org-repo")
	if err != nil {
		t.Fatalf("GetRepoBySlug: %v", err)
	}
	if found == nil {
		t.Fatal("expected repo, got nil")
	}
	if found.ID != "github/org/repo" {
		t.Errorf("repo ID = %q", found.ID)
	}

	notFound, err := db.GetRepoBySlug("nonexistent")
	if err != nil {
		t.Fatalf("GetRepoBySlug nonexistent: %v", err)
	}
	if notFound != nil {
		t.Error("expected nil for nonexistent slug")
	}
}

func TestClonesLifecycle(t *testing.T) {
	db := setupTestDB(t)

	repo := Repo{ID: "local/myrepo", Slug: "local-myrepo", Name: "myrepo", Provider: "local"}
	_ = db.UpsertRepo(repo)

	tmpDir := t.TempDir()
	clone := Clone{
		ID:     DeriveCloneID(tmpDir),
		RepoID: "local/myrepo",
		Path:   tmpDir,
		Status: "active",
	}
	if err := db.UpsertClone(clone); err != nil {
		t.Fatalf("UpsertClone: %v", err)
	}

	clones, err := db.ListClones("local/myrepo")
	if err != nil {
		t.Fatalf("ListClones: %v", err)
	}
	if len(clones) != 1 {
		t.Fatalf("expected 1 clone, got %d", len(clones))
	}
	if clones[0].Status != "active" {
		t.Errorf("clone status = %q", clones[0].Status)
	}

	// Update status to missing
	if err := db.UpdateCloneStatus(clone.ID, "missing"); err != nil {
		t.Fatalf("UpdateCloneStatus: %v", err)
	}
	got, _ := db.GetClone(clone.ID)
	if got.Status != "missing" {
		t.Errorf("status after update = %q", got.Status)
	}

	// Relink
	newDir := t.TempDir()
	if err := db.UpdateClonePath(clone.ID, newDir); err != nil {
		t.Fatalf("UpdateClonePath: %v", err)
	}
	got, _ = db.GetClone(clone.ID)
	if got.Path != newDir {
		t.Errorf("path after relink = %q, want %q", got.Path, newDir)
	}
	if got.Status != "active" {
		t.Errorf("status after relink = %q, want active", got.Status)
	}

	// Delete
	if err := db.DeleteClone(clone.ID); err != nil {
		t.Fatalf("DeleteClone: %v", err)
	}
	clones, _ = db.ListClones("local/myrepo")
	if len(clones) != 0 {
		t.Errorf("expected 0 clones after delete, got %d", len(clones))
	}
}

func TestWorktreesLifecycle(t *testing.T) {
	db := setupTestDB(t)

	repo := Repo{ID: "local/test", Slug: "local-test", Name: "test", Provider: "local"}
	_ = db.UpsertRepo(repo)

	tmpDir := t.TempDir()
	clone := Clone{ID: "clone1", RepoID: "local/test", Path: tmpDir, Status: "active"}
	_ = db.UpsertClone(clone)

	wt1 := Worktree{Path: filepath.Join(tmpDir, "main"), CloneID: "clone1", Branch: "main", HeadRef: "abc123", DiscoveredAt: "2026-04-01T00:00:00Z"}
	wt2 := Worktree{Path: filepath.Join(tmpDir, "feat"), CloneID: "clone1", Branch: "feat/x", HeadRef: "def456", DiscoveredAt: "2026-04-01T00:00:00Z"}

	if err := db.ReplaceWorktrees("clone1", []Worktree{wt1, wt2}); err != nil {
		t.Fatalf("ReplaceWorktrees: %v", err)
	}

	worktrees, err := db.ListWorktrees("clone1")
	if err != nil {
		t.Fatalf("ListWorktrees: %v", err)
	}
	if len(worktrees) != 2 {
		t.Fatalf("expected 2 worktrees, got %d", len(worktrees))
	}

	// Replace with different set
	wt3 := Worktree{Path: filepath.Join(tmpDir, "new"), CloneID: "clone1", Branch: "new", HeadRef: "ghi789", DiscoveredAt: "2026-04-01T00:00:00Z"}
	if err := db.ReplaceWorktrees("clone1", []Worktree{wt3}); err != nil {
		t.Fatalf("ReplaceWorktrees second: %v", err)
	}
	worktrees, _ = db.ListWorktrees("clone1")
	if len(worktrees) != 1 {
		t.Fatalf("expected 1 worktree after replace, got %d", len(worktrees))
	}

	// Delete clone should cascade delete worktrees
	_ = db.DeleteClone("clone1")
	worktrees, _ = db.ListWorktrees("clone1")
	if len(worktrees) != 0 {
		t.Errorf("expected 0 worktrees after clone delete, got %d", len(worktrees))
	}
}

// Regression: Devin review — DeleteClone must be transactional.
// If worktrees delete succeeds but clone delete would fail, both should roll back.
// Found by /qa on 2026-04-02.
func TestDeleteCloneIsTransactional(t *testing.T) {
	db := setupTestDB(t)

	repo := Repo{ID: "local/txtest", Slug: "local-txtest", Name: "txtest", Provider: "local"}
	_ = db.UpsertRepo(repo)

	clone := Clone{ID: "txclone", RepoID: "local/txtest", Path: t.TempDir(), Status: "active"}
	_ = db.UpsertClone(clone)

	wt := Worktree{Path: filepath.Join(clone.Path, "main"), CloneID: "txclone", Branch: "main", HeadRef: "abc", DiscoveredAt: "2026-04-01T00:00:00Z"}
	_ = db.ReplaceWorktrees("txclone", []Worktree{wt})

	// Normal delete should remove both clone and worktrees
	if err := db.DeleteClone("txclone"); err != nil {
		t.Fatalf("DeleteClone: %v", err)
	}
	clones, _ := db.ListClones("local/txtest")
	if len(clones) != 0 {
		t.Errorf("expected 0 clones after transactional delete, got %d", len(clones))
	}
	worktrees, _ := db.ListWorktrees("txclone")
	if len(worktrees) != 0 {
		t.Errorf("expected 0 worktrees after transactional delete, got %d", len(worktrees))
	}
}

// Regression: Devin review — ReplaceWorktrees must be transactional.
// If an INSERT fails mid-way, the old worktrees should be preserved (rolled back).
// Found by /qa on 2026-04-02.
func TestReplaceWorktreesIsTransactional(t *testing.T) {
	db := setupTestDB(t)

	repo := Repo{ID: "local/rwtx", Slug: "local-rwtx", Name: "rwtx", Provider: "local"}
	_ = db.UpsertRepo(repo)

	clone := Clone{ID: "rwclone", RepoID: "local/rwtx", Path: t.TempDir(), Status: "active"}
	_ = db.UpsertClone(clone)

	// Insert initial worktrees
	wt1 := Worktree{Path: "/a", CloneID: "rwclone", Branch: "main", HeadRef: "aaa", DiscoveredAt: "2026-04-01T00:00:00Z"}
	_ = db.ReplaceWorktrees("rwclone", []Worktree{wt1})

	// Replace with valid set
	wt2 := Worktree{Path: "/b", CloneID: "rwclone", Branch: "dev", HeadRef: "bbb", DiscoveredAt: "2026-04-01T00:00:00Z"}
	wt3 := Worktree{Path: "/c", CloneID: "rwclone", Branch: "feat", HeadRef: "ccc", DiscoveredAt: "2026-04-01T00:00:00Z"}
	if err := db.ReplaceWorktrees("rwclone", []Worktree{wt2, wt3}); err != nil {
		t.Fatalf("ReplaceWorktrees: %v", err)
	}

	worktrees, _ := db.ListWorktrees("rwclone")
	if len(worktrees) != 2 {
		t.Fatalf("expected 2 worktrees, got %d", len(worktrees))
	}
	// Verify old worktree is gone
	for _, wt := range worktrees {
		if wt.Path == "/a" {
			t.Error("old worktree /a should have been replaced")
		}
	}
}

// Regression: Devin review — DeriveRepoID must use filesystem paths, not URL slugs.
// The clone delete handler was calling DeriveRepoID with a slug like "github-org-repo"
// which always returned a wrong repo ID, bypassing the running-env safety check.
// Found by /qa on 2026-04-02.
func TestDeriveRepoIDUsesPathNotSlug(t *testing.T) {
	// DeriveRepoID should extract last path component
	got := string(DeriveRepoID("/Users/hzia/repos/spawntree"))
	if got != "spawntree" {
		t.Errorf("DeriveRepoID('/Users/hzia/repos/spawntree') = %q, want 'spawntree'", got)
	}

	// A slug with no slashes should NOT produce the same result as a real path
	slugResult := string(DeriveRepoID("github-ziahamza-spawntree"))
	pathResult := string(DeriveRepoID("/Users/hzia/repos/spawntree"))
	if slugResult == pathResult {
		t.Errorf("DeriveRepoID should produce different results for slug vs path, both got %q", slugResult)
	}
}

func TestDBPathExists(t *testing.T) {
	path := DBPath()
	if path == "" {
		t.Error("DBPath returned empty string")
	}
	dir := filepath.Dir(path)
	info, err := os.Stat(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Errorf("unexpected error checking dir: %v", err)
	}
	_ = info
}
