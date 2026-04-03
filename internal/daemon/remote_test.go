package daemon

import (
	"testing"
)

func TestParseRemoteURL(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		provider string
		owner    string
		repo     string
		id       string
	}{
		{
			name:     "GitHub HTTPS",
			url:      "https://github.com/ziahamza/spawntree.git",
			provider: "github",
			owner:    "ziahamza",
			repo:     "spawntree",
			id:       "github/ziahamza/spawntree",
		},
		{
			name:     "GitHub HTTPS without .git",
			url:      "https://github.com/ziahamza/spawntree",
			provider: "github",
			owner:    "ziahamza",
			repo:     "spawntree",
			id:       "github/ziahamza/spawntree",
		},
		{
			name:     "GitHub SSH",
			url:      "git@github.com:ziahamza/spawntree.git",
			provider: "github",
			owner:    "ziahamza",
			repo:     "spawntree",
			id:       "github/ziahamza/spawntree",
		},
		{
			name:     "GitHub SSH without .git",
			url:      "git@github.com:ziahamza/spawntree",
			provider: "github",
			owner:    "ziahamza",
			repo:     "spawntree",
			id:       "github/ziahamza/spawntree",
		},
		{
			name:     "GitLab HTTPS",
			url:      "https://gitlab.com/company/backend.git",
			provider: "gitlab",
			owner:    "company",
			repo:     "backend",
			id:       "gitlab/company/backend",
		},
		{
			name:     "GitLab SSH",
			url:      "git@gitlab.com:company/backend.git",
			provider: "gitlab",
			owner:    "company",
			repo:     "backend",
			id:       "gitlab/company/backend",
		},
		{
			name:     "Bitbucket HTTPS",
			url:      "https://bitbucket.org/team/project.git",
			provider: "bitbucket",
			owner:    "team",
			repo:     "project",
			id:       "bitbucket/team/project",
		},
		{
			name:     "Unknown host",
			url:      "https://git.internal.corp/team/repo.git",
			provider: "git",
			owner:    "team",
			repo:     "repo",
			id:       "git/team/repo",
		},
		{
			name:     "Empty URL",
			url:      "",
			provider: "local",
			id:       "local/",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			info := ParseRemoteURL(tt.url)
			if info.Provider != tt.provider {
				t.Errorf("Provider = %q, want %q", info.Provider, tt.provider)
			}
			if tt.owner != "" && info.Owner != tt.owner {
				t.Errorf("Owner = %q, want %q", info.Owner, tt.owner)
			}
			if tt.repo != "" && info.Repo != tt.repo {
				t.Errorf("Repo = %q, want %q", info.Repo, tt.repo)
			}
			if tt.id != "" && info.CanonicalID() != tt.id {
				t.Errorf("CanonicalID = %q, want %q", info.CanonicalID(), tt.id)
			}
		})
	}
}

func TestRemoteInfoSlug(t *testing.T) {
	info := ParseRemoteURL("https://github.com/ziahamza/spawntree.git")
	slug := info.Slug()
	if slug != "github-ziahamza-spawntree" {
		t.Errorf("Slug = %q, want %q", slug, "github-ziahamza-spawntree")
	}
}

func TestDeriveCloneID(t *testing.T) {
	id := DeriveCloneID("/Users/hzia/repos/spawntree")
	if len(id) != 12 {
		t.Errorf("DeriveCloneID length = %d, want 12", len(id))
	}
	// Same path should produce same ID
	id2 := DeriveCloneID("/Users/hzia/repos/spawntree")
	if id != id2 {
		t.Errorf("DeriveCloneID not deterministic: %q != %q", id, id2)
	}
	// Different path should produce different ID
	id3 := DeriveCloneID("/Users/hzia/repos/other")
	if id == id3 {
		t.Errorf("DeriveCloneID collision for different paths")
	}
}
