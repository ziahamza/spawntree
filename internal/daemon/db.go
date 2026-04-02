package daemon

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // SQLite driver for database/sql
)

// DB provides typed access to the spawntree SQLite database.
// Uses dual connection pools: writerDB (1 conn, for StateStore actor)
// and readerDB (4 conns, for HTTP handlers).
type DB struct {
	writerDB *sql.DB
	readerDB *sql.DB
}

// Repo represents a canonical git repository (grouped by remote URL).
type Repo struct {
	ID            string `json:"id"`            // "github/org/repo" or "local/name"
	Slug          string `json:"slug"`          // "github-org-repo" (URL-safe)
	Name          string `json:"name"`          // "repo" (display name)
	Provider      string `json:"provider"`      // "github" | "gitlab" | "bitbucket" | "local"
	Owner         string `json:"owner"`         // "org" or "" for local
	RemoteURL     string `json:"remoteUrl"`     // full remote URL, empty for local repos
	DefaultBranch string `json:"defaultBranch"` // from git/gh, may be empty
	Description   string `json:"description"`   // from gh, may be empty
	RegisteredAt  string `json:"registeredAt"`
	UpdatedAt     string `json:"updatedAt"`
}

// Clone represents a local checkout (clone or worktree root) of a repo.
type Clone struct {
	ID           string `json:"id"`     // sha256(path)[:12]
	RepoID       string `json:"repoId"` // references Repo.ID
	Path         string `json:"path"`   // absolute filesystem path
	Status       string `json:"status"` // "active" | "missing"
	LastSeenAt   string `json:"lastSeenAt"`
	RegisteredAt string `json:"registeredAt"`
}

// Worktree represents a git worktree discovered under a clone.
type Worktree struct {
	Path         string `json:"path"`    // absolute filesystem path
	CloneID      string `json:"cloneId"` // references Clone.ID
	Branch       string `json:"branch"`  // branch name, empty for detached HEAD
	HeadRef      string `json:"headRef"` // commit SHA
	DiscoveredAt string `json:"discoveredAt"`
}

// DiscoverResult is the result of a worktree discovery run.
type DiscoverResult struct {
	Warnings            []DiscoverWarning `json:"warnings"`
	DiscoveredWorktrees int               `json:"discoveredWorktrees"`
	ValidatedClones     int               `json:"validatedClones"`
	DurationMs          int64             `json:"durationMs"`
}

// DiscoverWarning represents a problem found during discovery.
type DiscoverWarning struct {
	Type    string `json:"type"` // "missing_clone" | "orphaned_worktree"
	RepoID  string `json:"repoId"`
	CloneID string `json:"cloneId,omitempty"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

const schemaVersion = 1

const schemaSQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS repos (
	id TEXT PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	provider TEXT NOT NULL,
	owner TEXT NOT NULL DEFAULT '',
	remote_url TEXT NOT NULL DEFAULT '',
	default_branch TEXT NOT NULL DEFAULT '',
	description TEXT NOT NULL DEFAULT '',
	registered_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clones (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL REFERENCES repos(id),
	path TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL DEFAULT 'active',
	last_seen_at TEXT NOT NULL,
	registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
	path TEXT PRIMARY KEY,
	clone_id TEXT NOT NULL REFERENCES clones(id),
	branch TEXT NOT NULL DEFAULT '',
	head_ref TEXT NOT NULL DEFAULT '',
	discovered_at TEXT NOT NULL
);
`

// OpenDB opens the spawntree SQLite database with dual connection pools.
func OpenDB(dbPath string) (*DB, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON&_synchronous=NORMAL", dbPath)

	writerDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open writer db: %w", err)
	}
	writerDB.SetMaxOpenConns(1)

	readerDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		writerDB.Close()
		return nil, fmt.Errorf("open reader db: %w", err)
	}
	readerDB.SetMaxOpenConns(4)

	db := &DB{writerDB: writerDB, readerDB: readerDB}
	if err := db.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate db: %w", err)
	}

	return db, nil
}

func (db *DB) Close() error {
	err1 := db.writerDB.Close()
	err2 := db.readerDB.Close()
	if err1 != nil {
		return err1
	}
	return err2
}

func (db *DB) migrate() error {
	if _, err := db.writerDB.Exec(schemaSQL); err != nil {
		return fmt.Errorf("create schema: %w", err)
	}

	var count int
	err := db.writerDB.QueryRow("SELECT COUNT(*) FROM schema_version").Scan(&count)
	if err != nil {
		return err
	}
	if count == 0 {
		_, err = db.writerDB.Exec("INSERT INTO schema_version (version) VALUES (?)", schemaVersion)
		return err
	}
	return nil
}

// --- Write operations (use writerDB, called via StateStore actor) ---

func (db *DB) UpsertRepo(repo Repo) error {
	now := time.Now().UTC().Format(time.RFC3339)
	if repo.RegisteredAt == "" {
		repo.RegisteredAt = now
	}
	repo.UpdatedAt = now

	_, err := db.writerDB.Exec(`
		INSERT INTO repos (id, slug, name, provider, owner, remote_url, default_branch, description, registered_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			slug = excluded.slug,
			name = excluded.name,
			remote_url = excluded.remote_url,
			default_branch = excluded.default_branch,
			description = excluded.description,
			updated_at = excluded.updated_at
	`, repo.ID, repo.Slug, repo.Name, repo.Provider, repo.Owner, repo.RemoteURL, repo.DefaultBranch, repo.Description, repo.RegisteredAt, repo.UpdatedAt)
	return err
}

func (db *DB) UpsertClone(clone Clone) error {
	now := time.Now().UTC().Format(time.RFC3339)
	if clone.RegisteredAt == "" {
		clone.RegisteredAt = now
	}
	clone.LastSeenAt = now

	_, err := db.writerDB.Exec(`
		INSERT INTO clones (id, repo_id, path, status, last_seen_at, registered_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			path = excluded.path,
			status = excluded.status,
			last_seen_at = excluded.last_seen_at
	`, clone.ID, clone.RepoID, clone.Path, clone.Status, clone.LastSeenAt, clone.RegisteredAt)
	return err
}

func (db *DB) UpdateCloneStatus(cloneID, status string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := db.writerDB.Exec("UPDATE clones SET status = ?, last_seen_at = ? WHERE id = ?", status, now, cloneID)
	return err
}

func (db *DB) UpdateClonePath(cloneID, newPath string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := db.writerDB.Exec("UPDATE clones SET path = ?, status = 'active', last_seen_at = ? WHERE id = ?", newPath, now, cloneID)
	return err
}

func (db *DB) DeleteClone(cloneID string) error {
	tx, err := db.writerDB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec("DELETE FROM worktrees WHERE clone_id = ?", cloneID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM clones WHERE id = ?", cloneID); err != nil {
		return err
	}
	return tx.Commit()
}

func (db *DB) ReplaceWorktrees(cloneID string, worktrees []Worktree) error {
	tx, err := db.writerDB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // rollback after commit is a no-op

	if _, err := tx.Exec("DELETE FROM worktrees WHERE clone_id = ?", cloneID); err != nil {
		return err
	}
	for _, wt := range worktrees {
		if _, err := tx.Exec(`
			INSERT INTO worktrees (path, clone_id, branch, head_ref, discovered_at)
			VALUES (?, ?, ?, ?, ?)
		`, wt.Path, cloneID, wt.Branch, wt.HeadRef, wt.DiscoveredAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// --- Read operations (use readerDB, safe for HTTP handlers) ---

func (db *DB) ListRepos() ([]Repo, error) {
	rows, err := db.readerDB.Query("SELECT id, slug, name, provider, owner, remote_url, default_branch, description, registered_at, updated_at FROM repos ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var repos []Repo
	for rows.Next() {
		var r Repo
		if err := rows.Scan(&r.ID, &r.Slug, &r.Name, &r.Provider, &r.Owner, &r.RemoteURL, &r.DefaultBranch, &r.Description, &r.RegisteredAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		repos = append(repos, r)
	}
	return repos, rows.Err()
}

func (db *DB) GetRepo(id string) (*Repo, error) {
	var r Repo
	err := db.readerDB.QueryRow("SELECT id, slug, name, provider, owner, remote_url, default_branch, description, registered_at, updated_at FROM repos WHERE id = ?", id).
		Scan(&r.ID, &r.Slug, &r.Name, &r.Provider, &r.Owner, &r.RemoteURL, &r.DefaultBranch, &r.Description, &r.RegisteredAt, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (db *DB) GetRepoBySlug(slug string) (*Repo, error) {
	var r Repo
	err := db.readerDB.QueryRow("SELECT id, slug, name, provider, owner, remote_url, default_branch, description, registered_at, updated_at FROM repos WHERE slug = ?", slug).
		Scan(&r.ID, &r.Slug, &r.Name, &r.Provider, &r.Owner, &r.RemoteURL, &r.DefaultBranch, &r.Description, &r.RegisteredAt, &r.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (db *DB) ListClones(repoID string) ([]Clone, error) {
	rows, err := db.readerDB.Query("SELECT id, repo_id, path, status, last_seen_at, registered_at FROM clones WHERE repo_id = ? ORDER BY path", repoID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var clones []Clone
	for rows.Next() {
		var c Clone
		if err := rows.Scan(&c.ID, &c.RepoID, &c.Path, &c.Status, &c.LastSeenAt, &c.RegisteredAt); err != nil {
			return nil, err
		}
		clones = append(clones, c)
	}
	return clones, rows.Err()
}

func (db *DB) ListAllClones() ([]Clone, error) {
	rows, err := db.readerDB.Query("SELECT id, repo_id, path, status, last_seen_at, registered_at FROM clones ORDER BY path")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var clones []Clone
	for rows.Next() {
		var c Clone
		if err := rows.Scan(&c.ID, &c.RepoID, &c.Path, &c.Status, &c.LastSeenAt, &c.RegisteredAt); err != nil {
			return nil, err
		}
		clones = append(clones, c)
	}
	return clones, rows.Err()
}

func (db *DB) GetClone(id string) (*Clone, error) {
	var c Clone
	err := db.readerDB.QueryRow("SELECT id, repo_id, path, status, last_seen_at, registered_at FROM clones WHERE id = ?", id).
		Scan(&c.ID, &c.RepoID, &c.Path, &c.Status, &c.LastSeenAt, &c.RegisteredAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (db *DB) ListWorktrees(cloneID string) ([]Worktree, error) {
	rows, err := db.readerDB.Query("SELECT path, clone_id, branch, head_ref, discovered_at FROM worktrees WHERE clone_id = ? ORDER BY branch", cloneID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var worktrees []Worktree
	for rows.Next() {
		var wt Worktree
		if err := rows.Scan(&wt.Path, &wt.CloneID, &wt.Branch, &wt.HeadRef, &wt.DiscoveredAt); err != nil {
			return nil, err
		}
		worktrees = append(worktrees, wt)
	}
	return worktrees, rows.Err()
}

func (db *DB) ListAllWorktrees() ([]Worktree, error) {
	rows, err := db.readerDB.Query("SELECT path, clone_id, branch, head_ref, discovered_at FROM worktrees ORDER BY branch")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var worktrees []Worktree
	for rows.Next() {
		var wt Worktree
		if err := rows.Scan(&wt.Path, &wt.CloneID, &wt.Branch, &wt.HeadRef, &wt.DiscoveredAt); err != nil {
			return nil, err
		}
		worktrees = append(worktrees, wt)
	}
	return worktrees, rows.Err()
}

// DeriveCloneID generates a stable 12-char hex ID from an absolute path.
func DeriveCloneID(absPath string) string {
	h := sha256.Sum256([]byte(absPath))
	return fmt.Sprintf("%x", h[:6])
}

// DBPath returns the path to the spawntree SQLite database.
func DBPath() string {
	return filepath.Join(SpawntreeHome(), "spawntree.db")
}
