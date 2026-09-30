package stackmcp

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateTargetAcceptsHTTPSAndSSHRemotes(t *testing.T) {
	cases := []struct {
		name     string
		fetchURL string
		pushURL  string
	}{
		{
			name:     "HTTPS",
			fetchURL: "https://GitHub.com/Shopify/GitHub-MCP-Server.git",
			pushURL:  "https://github.com/shopify/github-mcp-server",
		},
		{
			name:     "SSH scp and URI forms",
			fetchURL: "git@GitHub.com:Shopify/GitHub-MCP-Server.git",
			pushURL:  "ssh://git@github.com/shopify/github-mcp-server",
		},
		{
			name:     "HTTPS fetch and SSH push",
			fetchURL: "https://github.com/Shopify/GitHub-MCP-Server.git",
			pushURL:  "git@github.com:shopify/github-mcp-server.git",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			worktree := newTargetRepository(t)
			addTargetRemote(t, worktree, "origin", testCase.fetchURL, testCase.pushURL)
			t.Setenv("GH_REPO", "inherited/wrong-repository")

			workingDirectoryBefore, err := os.Getwd()
			if err != nil {
				t.Fatalf("get working directory before validation: %v", err)
			}

			got, err := ValidateTarget(worktree, "origin")
			if err != nil {
				t.Fatalf("ValidateTarget(%q, origin): %v", worktree, err)
			}

			canonicalWorktree, err := filepath.EvalSymlinks(worktree)
			if err != nil {
				t.Fatalf("resolve fixture worktree: %v", err)
			}
			canonicalGitDir, err := filepath.EvalSymlinks(filepath.Join(canonicalWorktree, ".git"))
			if err != nil {
				t.Fatalf("resolve fixture Git directory: %v", err)
			}
			if got.Path != canonicalWorktree {
				t.Errorf("target path = %q, want canonical worktree %q", got.Path, canonicalWorktree)
			}
			if got.GitDir != canonicalGitDir {
				t.Errorf("target Git directory = %q, want %q", got.GitDir, canonicalGitDir)
			}
			if got.CommonDir != canonicalGitDir {
				t.Errorf("target common directory = %q, want %q", got.CommonDir, canonicalGitDir)
			}
			if got.Remote != "origin" {
				t.Errorf("target remote = %q, want origin", got.Remote)
			}
			if got.Repository != "github.com/shopify/github-mcp-server" {
				t.Errorf("target repository = %q, want github.com/shopify/github-mcp-server", got.Repository)
			}

			workingDirectoryAfter, err := os.Getwd()
			if err != nil {
				t.Fatalf("get working directory after validation: %v", err)
			}
			if workingDirectoryAfter != workingDirectoryBefore {
				t.Errorf("validation changed process working directory from %q to %q", workingDirectoryBefore, workingDirectoryAfter)
			}
		})
	}
}

func TestValidateTargetUsesTheExplicitRemote(t *testing.T) {
	worktree := newTargetRepository(t)
	addTargetRemote(t, worktree, "origin", "https://github.com/fork/project.git", "")
	addTargetRemote(t, worktree, "upstream", "https://github.com/owner/project.git", "")

	got, err := ValidateTarget(worktree, "upstream")
	if err != nil {
		t.Fatalf("ValidateTarget with explicit upstream: %v", err)
	}
	if got.Remote != "upstream" || got.Repository != "github.com/owner/project" {
		t.Errorf("target = {remote:%q repository:%q}, want upstream github.com/owner/project", got.Remote, got.Repository)
	}
}

func TestValidateTargetCanonicalizesSymlinkPath(t *testing.T) {
	worktree := newTargetRepository(t)
	addTargetRemote(t, worktree, "origin", "https://github.com/owner/project.git", "")
	alias := filepath.Join(t.TempDir(), "worktree-alias")
	if err := os.Symlink(worktree, alias); err != nil {
		t.Fatalf("symlink worktree fixture: %v", err)
	}
	want, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		t.Fatalf("resolve fixture worktree: %v", err)
	}

	got, err := ValidateTarget(alias, "origin")
	if err != nil {
		t.Fatalf("ValidateTarget through symlink: %v", err)
	}
	if got.Path != want {
		t.Errorf("target path = %q, want resolved worktree %q", got.Path, want)
	}
}

func TestValidateTargetResolvesLinkedWorktreeDirectories(t *testing.T) {
	mainWorktree := newTargetRepository(t)
	addTargetRemote(t, mainWorktree, "origin", "https://github.com/owner/project.git", "")
	targetGit(t, mainWorktree, "config", "user.name", "Target Fixture")
	targetGit(t, mainWorktree, "config", "user.email", "target-fixture@example.invalid")
	targetGit(t, mainWorktree, "config", "commit.gpgsign", "false")
	targetGit(t, mainWorktree, "config", "core.hooksPath", "/dev/null")
	targetGit(t, mainWorktree, "commit", "--quiet", "--allow-empty", "-m", "initial")

	linkedWorktree := filepath.Join(t.TempDir(), "linked")
	targetGit(t, mainWorktree, "worktree", "add", "--quiet", "-b", "feature", linkedWorktree, "HEAD")
	got, err := ValidateTarget(linkedWorktree, "origin")
	if err != nil {
		t.Fatalf("ValidateTarget linked worktree: %v", err)
	}

	wantWorktree, err := filepath.EvalSymlinks(linkedWorktree)
	if err != nil {
		t.Fatalf("resolve linked worktree: %v", err)
	}
	wantGitDir, err := filepath.EvalSymlinks(targetGit(t, linkedWorktree, "rev-parse", "--absolute-git-dir"))
	if err != nil {
		t.Fatalf("resolve linked Git directory: %v", err)
	}
	wantCommonDir, err := filepath.EvalSymlinks(targetGit(t, linkedWorktree, "rev-parse", "--path-format=absolute", "--git-common-dir"))
	if err != nil {
		t.Fatalf("resolve linked common directory: %v", err)
	}
	if got.Path != wantWorktree {
		t.Errorf("target path = %q, want %q", got.Path, wantWorktree)
	}
	if got.GitDir != wantGitDir {
		t.Errorf("target Git directory = %q, want per-worktree directory %q", got.GitDir, wantGitDir)
	}
	if got.CommonDir != wantCommonDir {
		t.Errorf("target common directory = %q, want shared directory %q", got.CommonDir, wantCommonDir)
	}
	if got.GitDir == got.CommonDir {
		t.Errorf("linked worktree Git directory %q unexpectedly equals common directory", got.GitDir)
	}
}

func TestValidateTargetRejectsInvalidPaths(t *testing.T) {
	missingPath := filepath.Join(t.TempDir(), "missing-worktree")
	nonGitDirectory := t.TempDir()
	cases := []struct {
		name string
		path string
	}{
		{name: "empty path", path: ""},
		{name: "relative path", path: "relative-worktree"},
		{name: "missing absolute path", path: missingPath},
		{name: "directory that is not a repository", path: nonGitDirectory},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := ValidateTarget(testCase.path, "origin"); err == nil {
				t.Fatalf("ValidateTarget(%q, origin) succeeded; want rejection", testCase.path)
			}
		})
	}
}

func TestValidateTargetRequiresAnExplicitExistingRemote(t *testing.T) {
	worktree := newTargetRepository(t)
	for _, remote := range []string{"", "missing"} {
		if _, err := ValidateTarget(worktree, remote); err == nil {
			t.Errorf("ValidateTarget with remote %q succeeded; want rejection", remote)
		}
	}
}

func TestValidateTargetIgnoresInheritedGitRepositoryOverrides(t *testing.T) {
	worktree := newTargetRepository(t)
	addTargetRemote(t, worktree, "origin", "https://github.com/owner/project.git", "")
	otherRepository := newTargetRepository(t)
	addTargetRemote(t, otherRepository, "origin", "https://github.com/other/wrong.git", "")
	t.Setenv("GIT_DIR", filepath.Join(otherRepository, ".git"))
	t.Setenv("GIT_WORK_TREE", otherRepository)
	t.Setenv("GH_REPO", "other/wrong")

	got, err := ValidateTarget(worktree, "origin")
	if err != nil {
		t.Fatalf("ValidateTarget with inherited overrides: %v", err)
	}
	wantWorktree, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		t.Fatalf("resolve explicit fixture worktree: %v", err)
	}
	if got.Path != wantWorktree || got.Repository != "github.com/owner/project" {
		t.Errorf("target = {path:%q repository:%q}, want explicit worktree and remote", got.Path, got.Repository)
	}
}

func TestValidateTargetRejectsCredentialAndUnsupportedURLs(t *testing.T) {
	cases := []struct {
		name     string
		fetchURL string
		pushURL  string
		secrets  []string
	}{
		{
			name:     "HTTPS credentials in fetch URL",
			fetchURL: "https://user:fetch-secret@github.com/owner/project.git",
			secrets:  []string{"user", "fetch-secret"},
		},
		{
			name:     "HTTPS credentials in push URL",
			fetchURL: "https://github.com/owner/project.git",
			pushURL:  "https://push-secret@github.com/owner/project.git",
			secrets:  []string{"push-secret"},
		},
		{
			name:     "SSH password credentials",
			fetchURL: "ssh://git:ssh-secret@github.com/owner/project.git",
			secrets:  []string{"ssh-secret"},
		},
		{
			name:     "HTTP is not an accepted repository scheme",
			fetchURL: "http://github.com/owner/project.git",
		},
		{
			name:     "unknown scheme",
			fetchURL: "ftp://github.com/owner/project.git",
		},
		{
			name:     "malformed repository URL",
			fetchURL: "https://github.com/owner",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			worktree := newTargetRepository(t)
			addTargetRemote(t, worktree, "origin", testCase.fetchURL, testCase.pushURL)

			_, err := ValidateTarget(worktree, "origin")
			if err == nil {
				t.Fatal("ValidateTarget succeeded; want URL rejection")
			}
			for _, secret := range testCase.secrets {
				if strings.Contains(err.Error(), secret) {
					t.Errorf("rejection error leaked credential %q: %v", secret, err)
				}
			}
		})
	}
}

func TestValidateTargetRejectsFetchAndPushIdentityMismatches(t *testing.T) {
	cases := []struct {
		name     string
		fetchURL string
		pushURL  string
	}{
		{
			name:     "fork fetch and upstream push",
			fetchURL: "git@github.com:fork/project.git",
			pushURL:  "git@github.com:upstream/project.git",
		},
		{
			name:     "different repositories",
			fetchURL: "https://github.com/owner/first.git",
			pushURL:  "https://github.com/owner/second.git",
		},
		{
			name:     "different hosts",
			fetchURL: "https://github.com/owner/project.git",
			pushURL:  "https://git.example.invalid/owner/project.git",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			worktree := newTargetRepository(t)
			addTargetRemote(t, worktree, "origin", testCase.fetchURL, testCase.pushURL)
			if _, err := ValidateTarget(worktree, "origin"); err == nil {
				t.Fatal("ValidateTarget succeeded; want fetch/push identity rejection")
			}
		})
	}
}

func TestValidateTargetRejectsMultiplePushDestinations(t *testing.T) {
	worktree := newTargetRepository(t)
	targetGit(t, worktree, "remote", "add", "origin", "https://github.com/owner/project.git")
	targetGit(t, worktree, "remote", "set-url", "--add", "--push", "origin", "https://github.com/owner/project.git")
	targetGit(t, worktree, "remote", "set-url", "--add", "--push", "origin", "git@github.com:owner/project.git")

	if _, err := ValidateTarget(worktree, "origin"); err == nil {
		t.Fatal("ValidateTarget succeeded with multiple push URLs; want rejection")
	}
}

func newTargetRepository(t *testing.T) string {
	t.Helper()
	worktree := filepath.Join(t.TempDir(), "repository")
	if err := os.Mkdir(worktree, 0o755); err != nil {
		t.Fatalf("create repository fixture: %v", err)
	}
	targetGit(t, worktree, "init", "--quiet")
	return worktree
}

func addTargetRemote(t *testing.T, worktree, name, fetchURL, pushURL string) {
	t.Helper()
	targetGit(t, worktree, "remote", "add", name, fetchURL)
	if pushURL != "" {
		targetGit(t, worktree, "remote", "set-url", "--push", name, pushURL)
	}
}

func targetGit(t *testing.T, worktree string, args ...string) string {
	t.Helper()
	commandArgs := append([]string{"-C", worktree}, args...)
	command := exec.Command("git", commandArgs...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git -C %q %s: %v\n%s", worktree, strings.Join(args, " "), err, output)
	}
	return strings.TrimSuffix(string(output), "\n")
}
