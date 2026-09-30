package stackmcp

import (
	"encoding/json"
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

func TestValidateCheckoutRemoteSelectionUsesEffectivePreferences(t *testing.T) {
	cases := []struct {
		name       string
		configure  func(t *testing.T, worktree string)
		wantReject bool
	}{
		{name: "sole remote fallback"},
		{
			name: "matching branch push remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "branch.main.pushRemote", "origin")
			},
		},
		{
			name: "mismatching branch push remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "branch.main.pushRemote", "upstream")
			},
			wantReject: true,
		},
		{
			name: "matching default remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "remote.pushDefault", "origin")
			},
		},
		{
			name: "mismatching default remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "remote.pushDefault", "upstream")
			},
			wantReject: true,
		},
		{
			name: "matching branch remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "branch.main.remote", "origin")
			},
		},
		{
			name: "mismatching branch remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "branch.main.remote", "upstream")
			},
			wantReject: true,
		},
		{
			name: "matching saved remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "gh-stack.remote", "origin")
			},
		},
		{
			name: "mismatching saved remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "gh-stack.remote", "upstream")
			},
			wantReject: true,
		},
		{
			name: "default remote precedes branch remote and saved remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "remote.pushDefault", "origin")
				setTargetGitConfig(t, worktree, "branch.main.remote", "upstream")
				setTargetGitConfig(t, worktree, "gh-stack.remote", "upstream")
			},
		},
		{
			name: "branch push remote precedes default remote",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "branch.main.pushRemote", "upstream")
				setTargetGitConfig(t, worktree, "remote.pushDefault", "origin")
			},
			wantReject: true,
		},
		{
			name: "matching branch push remote cannot hide mismatching default for another trunk",
			configure: func(t *testing.T, worktree string) {
				setTargetGitConfig(t, worktree, "branch.main.pushRemote", "origin")
				setTargetGitConfig(t, worktree, "remote.pushDefault", "upstream")
			},
			wantReject: true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			target, worktree, _ := newTargetRemoteSelectionFixture(t)
			if testCase.configure != nil {
				testCase.configure(t, worktree)
			}

			err := ValidateCheckoutRemoteSelection(target)
			if testCase.wantReject && err == nil {
				t.Fatal("ValidateCheckoutRemoteSelection succeeded; want remote-selection rejection")
			}
			if !testCase.wantReject && err != nil {
				t.Fatalf("ValidateCheckoutRemoteSelection rejected matching selection: %v", err)
			}
		})
	}
}

func TestValidateCheckoutRemoteSelectionRequiresOneRemote(t *testing.T) {
	target, _, _ := newTargetRemoteSelectionFixture(t, "upstream")
	if err := ValidateCheckoutRemoteSelection(target); err == nil || !strings.Contains(err.Error(), "exactly one Git remote") {
		t.Fatalf("ValidateCheckoutRemoteSelection error = %v, want sole-remote rejection", err)
	}
}

func TestValidateCheckoutRemoteSelectionRejectsMismatchWithoutFetchingOrInvokingExtension(t *testing.T) {
	target, worktree, _ := newTargetRemoteSelectionFixture(t)
	setTargetGitConfig(t, worktree, "remote.pushDefault", "upstream")
	gitAudit, extensionAudit := installTargetCommandAudit(t)

	if err := ValidateCheckoutRemoteSelection(target); err == nil {
		t.Fatal("ValidateCheckoutRemoteSelection succeeded; want mismatching default-remote rejection")
	}
	assertNoFetchOrExtensionExecution(t, gitAudit, extensionAudit)
}

func TestValidateInitRemoteSelectionUsesEffectivePreferencesWhenTrunkIsMissing(t *testing.T) {
	cases := []struct {
		name       string
		configure  func(t *testing.T, worktree, currentBranch, trunk string)
		wantReject bool
	}{
		{name: "sole remote fallback"},
		{
			name: "matching current branch push remote",
			configure: func(t *testing.T, worktree, currentBranch, _ string) {
				setTargetGitConfig(t, worktree, "branch."+currentBranch+".pushRemote", "origin")
			},
		},
		{
			name: "mismatching current branch push remote",
			configure: func(t *testing.T, worktree, currentBranch, _ string) {
				setTargetGitConfig(t, worktree, "branch."+currentBranch+".pushRemote", "upstream")
			},
			wantReject: true,
		},
		{
			name: "matching missing trunk remote preference",
			configure: func(t *testing.T, worktree, _, trunk string) {
				setTargetGitConfig(t, worktree, "branch."+trunk+".remote", "origin")
			},
		},
		{
			name: "mismatching missing trunk remote preference",
			configure: func(t *testing.T, worktree, _, trunk string) {
				setTargetGitConfig(t, worktree, "branch."+trunk+".remote", "upstream")
			},
			wantReject: true,
		},
		{
			name: "matching default remote",
			configure: func(t *testing.T, worktree, _, _ string) {
				setTargetGitConfig(t, worktree, "remote.pushDefault", "origin")
			},
		},
		{
			name: "mismatching default remote",
			configure: func(t *testing.T, worktree, _, _ string) {
				setTargetGitConfig(t, worktree, "remote.pushDefault", "upstream")
			},
			wantReject: true,
		},
		{
			name: "matching saved remote",
			configure: func(t *testing.T, worktree, _, _ string) {
				setTargetGitConfig(t, worktree, "gh-stack.remote", "origin")
			},
		},
		{
			name: "mismatching saved remote",
			configure: func(t *testing.T, worktree, _, _ string) {
				setTargetGitConfig(t, worktree, "gh-stack.remote", "upstream")
			},
			wantReject: true,
		},
		{
			name: "current and trunk branch push remotes precede mismatching defaults",
			configure: func(t *testing.T, worktree, currentBranch, trunk string) {
				setTargetGitConfig(t, worktree, "branch."+currentBranch+".pushRemote", "origin")
				setTargetGitConfig(t, worktree, "branch."+trunk+".pushRemote", "origin")
				setTargetGitConfig(t, worktree, "remote.pushDefault", "upstream")
				setTargetGitConfig(t, worktree, "gh-stack.remote", "upstream")
			},
		},
		{
			name: "default remote precedes branch remote",
			configure: func(t *testing.T, worktree, currentBranch, trunk string) {
				setTargetGitConfig(t, worktree, "branch."+currentBranch+".remote", "upstream")
				setTargetGitConfig(t, worktree, "branch."+trunk+".remote", "upstream")
				setTargetGitConfig(t, worktree, "remote.pushDefault", "origin")
			},
		},
		{
			name: "branch remote precedes saved remote",
			configure: func(t *testing.T, worktree, currentBranch, trunk string) {
				setTargetGitConfig(t, worktree, "branch."+currentBranch+".remote", "origin")
				setTargetGitConfig(t, worktree, "branch."+trunk+".remote", "origin")
				setTargetGitConfig(t, worktree, "gh-stack.remote", "upstream")
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			target, worktree, currentBranch := newTargetRemoteSelectionFixture(t)
			trunk := "stack-trunk"
			if testCase.configure != nil {
				testCase.configure(t, worktree, currentBranch, trunk)
			}

			err := ValidateInitRemoteSelection(target, trunk)
			if testCase.wantReject && err == nil {
				t.Fatal("ValidateInitRemoteSelection succeeded; want remote-selection rejection")
			}
			if !testCase.wantReject && err != nil {
				t.Fatalf("ValidateInitRemoteSelection rejected matching selection: %v", err)
			}
		})
	}
}

func TestValidateInitRemoteSelectionRequiresOneRemoteWhenTrunkIsMissing(t *testing.T) {
	target, _, _ := newTargetRemoteSelectionFixture(t, "upstream")
	if err := ValidateInitRemoteSelection(target, "stack-trunk"); err == nil || !strings.Contains(err.Error(), "exactly one Git remote") {
		t.Fatalf("ValidateInitRemoteSelection error = %v, want sole-remote rejection", err)
	}
}

func TestValidateInitRemoteSelectionRejectsMismatchWithoutFetchingOrInvokingExtension(t *testing.T) {
	target, worktree, currentBranch := newTargetRemoteSelectionFixture(t)
	setTargetGitConfig(t, worktree, "branch."+currentBranch+".pushRemote", "upstream")
	gitAudit, extensionAudit := installTargetCommandAudit(t)

	if err := ValidateInitRemoteSelection(target, "stack-trunk"); err == nil {
		t.Fatal("ValidateInitRemoteSelection succeeded; want mismatching branch-remote rejection")
	}
	assertNoFetchOrExtensionExecution(t, gitAudit, extensionAudit)
}

func TestValidateInitRemoteSelectionSkipsFetchGuardForLocalTrunk(t *testing.T) {
	target, worktree, currentBranch := newTargetRemoteSelectionFixture(t, "upstream")
	targetGit(t, worktree, "config", "user.name", "Target Fixture")
	targetGit(t, worktree, "config", "user.email", "target-fixture@example.invalid")
	targetGit(t, worktree, "config", "commit.gpgsign", "false")
	targetGit(t, worktree, "config", "core.hooksPath", "/dev/null")
	targetGit(t, worktree, "commit", "--quiet", "--allow-empty", "-m", "initial")
	targetGit(t, worktree, "branch", "stack-trunk")
	setTargetGitConfig(t, worktree, "branch."+currentBranch+".pushRemote", "upstream")
	setTargetGitConfig(t, worktree, "remote.pushDefault", "upstream")
	setTargetGitConfig(t, worktree, "gh-stack.remote", "upstream")

	if err := ValidateInitRemoteSelection(target, "stack-trunk"); err != nil {
		t.Fatalf("ValidateInitRemoteSelection rejected local trunk without fetch guard: %v", err)
	}
}

func newTargetRemoteSelectionFixture(t *testing.T, additionalRemotes ...string) (Target, string, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, "xdg-config"))

	worktree := newTargetRepository(t)
	addTargetRemote(t, worktree, "origin", "https://github.com/owner/project.git", "")
	for _, remote := range additionalRemotes {
		addTargetRemote(t, worktree, remote, "https://github.com/owner/project.git", "")
	}
	setTargetGitConfig(t, worktree, "remote.pushDefault", "")
	setTargetGitConfig(t, worktree, "gh-stack.remote", "")

	target, err := ValidateTarget(worktree, "origin")
	if err != nil {
		t.Fatalf("ValidateTarget remote-selection fixture: %v", err)
	}
	currentBranch := targetGit(t, worktree, "branch", "--show-current")
	if currentBranch == "" {
		t.Fatal("fixture repository has no current branch")
	}
	return target, worktree, currentBranch
}

func setTargetGitConfig(t *testing.T, worktree, key, value string) {
	t.Helper()
	targetGit(t, worktree, "config", key, value)
}

func installTargetCommandAudit(t *testing.T) (string, string) {
	t.Helper()
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatalf("locate real Git executable: %v", err)
	}
	binDir := t.TempDir()
	gitAudit := filepath.Join(t.TempDir(), "git-commands.log")
	extensionAudit := filepath.Join(t.TempDir(), "extension-commands.log")
	t.Setenv("STACKMCP_REAL_GIT", realGit)
	t.Setenv("STACKMCP_GIT_AUDIT_FILE", gitAudit)
	t.Setenv("STACKMCP_EXTENSION_AUDIT_FILE", extensionAudit)
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	gitWrapper := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$STACKMCP_GIT_AUDIT_FILE\"\nexec \"$STACKMCP_REAL_GIT\" \"$@\"\n"
	if err := os.WriteFile(filepath.Join(binDir, "git"), []byte(gitWrapper), 0o755); err != nil {
		t.Fatalf("write Git audit wrapper: %v", err)
	}
	for _, extension := range []string{"gh", "gh-stack"} {
		extensionWrapper := "#!/bin/sh\nprintf '%s\\n' \"$0 $*\" >> \"$STACKMCP_EXTENSION_AUDIT_FILE\"\nexit 99\n"
		if err := os.WriteFile(filepath.Join(binDir, extension), []byte(extensionWrapper), 0o755); err != nil {
			t.Fatalf("write %s audit wrapper: %v", extension, err)
		}
	}
	return gitAudit, extensionAudit
}

func assertNoFetchOrExtensionExecution(t *testing.T, gitAudit, extensionAudit string) {
	t.Helper()
	gitCommands, err := os.ReadFile(gitAudit)
	if err != nil {
		t.Fatalf("read Git audit log: %v", err)
	}
	for _, command := range strings.Split(string(gitCommands), "\n") {
		for _, argument := range strings.Fields(command) {
			if argument == "fetch" {
				t.Errorf("remote fetch executed before guard rejection: %q", command)
			}
		}
	}
	if _, err := os.Stat(extensionAudit); err == nil {
		output, readErr := os.ReadFile(extensionAudit)
		if readErr != nil {
			t.Fatalf("read extension audit log: %v", readErr)
		}
		t.Errorf("extension process executed before guard rejection: %s", output)
	} else if !os.IsNotExist(err) {
		t.Fatalf("inspect extension audit log: %v", err)
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

func TestValidateRebaseContinueStateAcceptsValidRecovery(t *testing.T) {
	cases := []struct {
		name               string
		currentBranchIndex int
		conflictBranch     string
		originalBranch     string
		useTrackedTrunk    bool
	}{
		{
			name:               "zero is a valid branch index",
			currentBranchIndex: 0,
			conflictBranch:     "feature-one",
			originalBranch:     "feature-three",
		},
		{
			name:               "middle branch index",
			currentBranchIndex: 1,
			conflictBranch:     "feature-two",
			originalBranch:     "feature-three",
		},
		{
			name:               "original branch may be the tracked trunk",
			currentBranchIndex: 1,
			conflictBranch:     "feature-two",
			useTrackedTrunk:    true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			target, trunk, commit := newTargetRecoveryFixture(t)
			originalBranch := testCase.originalBranch
			if testCase.useTrackedTrunk {
				originalBranch = trunk
			}
			writeValidRecoveryFixture(t, target, trunk, commit, testCase.currentBranchIndex, testCase.conflictBranch, originalBranch)

			if err := ValidateRebaseContinueState(target); err != nil {
				t.Fatalf("ValidateRebaseContinueState rejected valid recovery: %v", err)
			}
		})
	}
}

func TestValidateRebaseContinueStateAcceptsUpstreamMarkerWithoutTrunkRef(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")

	markerData, err := os.ReadFile(filepath.Join(target.GitDir, "gh-stack-rebase-state"))
	if err != nil {
		t.Fatalf("read synthetic rebase marker: %v", err)
	}
	var marker map[string]any
	if err := json.Unmarshal(markerData, &marker); err != nil {
		t.Fatalf("decode synthetic rebase marker: %v", err)
	}
	originalRefs := marker["originalRefs"].(map[string]any)
	if _, hasTrunk := originalRefs[trunk]; hasTrunk {
		t.Fatalf("upstream-shaped originalRefs unexpectedly contain trunk %q", trunk)
	}
	wantBranches := []string{"feature-one", "feature-two", "feature-three"}
	if len(originalRefs) != len(wantBranches) {
		t.Fatalf("upstream-shaped originalRefs = %#v, want exactly refs for %v", originalRefs, wantBranches)
	}
	for _, branch := range wantBranches {
		if got := originalRefs[branch]; got != commit {
			t.Errorf("upstream-shaped originalRefs[%q] = %v, want tracked branch ref %q", branch, got, commit)
		}
	}

	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected branch-only originalRefs: %v", err)
	}
}

func TestValidateRebaseContinueStateAcceptsDeletedMergedBranchHeadFallback(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	targetGit(t, target.Path, "branch", "-D", "feature-three")

	stack := recoveryStackFileWithMergedBranches(
		trunk,
		commit,
		[]string{"feature-one", "feature-two", "feature-three"},
		map[string]bool{"feature-three": true},
	)
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), stack)
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", trunk)
	if got := marker["originalRefs"].(map[string]string)["feature-three"]; got != commit {
		t.Fatalf("deleted merged branch fallback ref = %q, want BranchRef.Head %q", got, commit)
	}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
	writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")

	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected a deleted merged branch's Head fallback: %v", err)
	}
}

func TestValidateRebaseContinueStateAcceptsOmittedDeletedMergedBranchWithoutHead(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	targetGit(t, target.Path, "branch", "-D", "feature-three")

	stack := recoveryStackFileWithMergedBranches(
		trunk,
		commit,
		[]string{"feature-one", "feature-two", "feature-three"},
		map[string]bool{"feature-three": true},
	)
	if !setRecoveryStackBranchHead(stack, "feature-three", "") {
		t.Fatal("fixture did not contain merged feature-three")
	}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), stack)
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", trunk)
	delete(marker["originalRefs"].(map[string]string), "feature-three")
	marker["remainingBranches"] = []string{}
	marker["endIndex"] = 2
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
	writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")

	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected an omitted deleted merged branch with empty Head: %v", err)
	}
}

func TestValidateRebaseContinueStateRejectsMissingOriginalRefForLocalBranchBeforeLaunch(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
	delete(marker["originalRefs"].(map[string]string), "feature-one")
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
	_, extensionAudit := installTargetCommandAudit(t)

	guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateRebaseContinueState, "rebase", "--continue")
	if guardErr == nil || !strings.Contains(guardErr.Error(), "local branch ref") {
		t.Errorf("ValidateRebaseContinueState error = %v, want missing local branch ref rejection", guardErr)
	}
	if launchErr != nil {
		t.Errorf("Stack extension launched before local-ref rejection: %v", launchErr)
	}
	assertNoTargetExtensionInvocation(t, extensionAudit)
}

func TestValidateRebaseContinueStateRejectsMissingOrMismatchedHeadFallbackBeforeLaunch(t *testing.T) {
	tests := []struct {
		name           string
		omitRef        bool
		emptyHead      bool
		markerID       string
		wantErrorMatch string
	}{
		{name: "wrong fallback value", markerID: strings.Repeat("a", 40), wantErrorMatch: "tracked Head fallback"},
		{name: "omitted fallback", omitRef: true, wantErrorMatch: "tracked Head fallback"},
		{name: "marker entry without local ref or Head source", emptyHead: true, wantErrorMatch: "no local ref or tracked Head source"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			target, trunk, commit := newTargetRecoveryFixture(t)
			targetGit(t, target.Path, "branch", "-D", "feature-three")
			stack := recoveryStackFileWithMergedBranches(
				trunk,
				commit,
				[]string{"feature-one", "feature-two", "feature-three"},
				map[string]bool{"feature-three": true},
			)
			if testCase.emptyHead && !setRecoveryStackBranchHead(stack, "feature-three", "") {
				t.Fatal("fixture did not contain feature-three")
			}
			writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), stack)
			marker := validRebaseMarker(trunk, commit, 1, "feature-two", trunk)
			originalRefs := marker["originalRefs"].(map[string]string)
			if testCase.omitRef {
				delete(originalRefs, "feature-three")
			} else if testCase.markerID != "" {
				originalRefs["feature-three"] = testCase.markerID
			}
			writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")
			_, extensionAudit := installTargetCommandAudit(t)

			guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateRebaseContinueState, "rebase", "--continue")
			if guardErr == nil || !strings.Contains(guardErr.Error(), testCase.wantErrorMatch) {
				t.Errorf("ValidateRebaseContinueState error = %v, want rejection containing %q; launch error = %v", guardErr, testCase.wantErrorMatch, launchErr)
			}
			if launchErr != nil {
				t.Errorf("Stack extension launched before Head-fallback rejection: %v", launchErr)
			}
			assertNoTargetExtensionInvocation(t, extensionAudit)
		})
	}
}

func TestValidateRebaseContinueStateAcceptsOmittedDeletedBranchWithoutHeadWithStaleMergeStatus(t *testing.T) {
	tests := []struct {
		name        string
		pullRequest map[string]any
	}{
		{
			name:        "stale unmerged status",
			pullRequest: map[string]any{"number": 42, "merged": false},
		},
		{name: "absent persisted merge status"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			target, trunk, commit := newTargetRecoveryFixture(t)
			targetGit(t, target.Path, "branch", "-D", "feature-three")
			stack := recoveryStackFile(trunk, commit, []string{"feature-one", "feature-two", "feature-three"})
			if !setRecoveryStackBranchHead(stack, "feature-three", "") {
				t.Fatal("fixture did not contain feature-three")
			}
			if !setRecoveryStackBranchPullRequest(stack, "feature-three", testCase.pullRequest) {
				t.Fatal("fixture did not contain feature-three")
			}
			writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), stack)
			marker := validRebaseMarker(trunk, commit, 1, "feature-two", trunk)
			delete(marker["originalRefs"].(map[string]string), "feature-three")
			marker["remainingBranches"] = []string{}
			marker["endIndex"] = 2
			writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")

			if err := ValidateRebaseContinueState(target); err != nil {
				t.Fatalf("ValidateRebaseContinueState rejected an omitted deleted branch with empty Head and %s: %v", testCase.name, err)
			}
		})
	}
}

func TestValidateRebaseContinueStateAcceptsApplyBackendRecovery(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), recoveryStackFile(trunk, commit, []string{"feature-one", "feature-two", "feature-three"}))
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three"))
	writeActiveRebaseApplyFixture(t, target.GitDir, commit, "feature-two")

	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected valid apply-backend recovery: %v", err)
	}
}

func TestValidateRebaseContinueStateRejectsInvalidRecoveryBeforeLaunch(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(t *testing.T, target Target, trunk, commit string)
	}{
		{
			name: "missing marker",
			mutate: func(t *testing.T, target Target, _, _ string) {
				if err := os.Remove(filepath.Join(target.GitDir, "gh-stack-rebase-state")); err != nil {
					t.Fatalf("remove synthetic recovery marker: %v", err)
				}
			},
		},
		{
			name: "malformed marker",
			mutate: func(t *testing.T, target Target, _, _ string) {
				writeTargetStateBytes(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), []byte("{"))
			},
		},
		{
			name: "missing current branch index",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				delete(marker, "currentBranchIndex")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "negative current branch index",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				marker["currentBranchIndex"] = -1
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "missing end index",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				delete(marker, "endIndex")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "start index follows conflict branch",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				marker["startIndex"] = 2
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "negative start index",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				marker["startIndex"] = -1
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "end index does not include conflict branch",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				marker["endIndex"] = 1
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "end index exceeds stack branches",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				marker["endIndex"] = 4
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "missing original branch",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				delete(marker, "originalBranch")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "missing original refs",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				delete(marker, "originalRefs")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "original refs contain the tracked trunk",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				marker["originalRefs"].(map[string]string)[trunk] = commit
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "conflict branch is no longer tracked",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), validRebaseMarker(trunk, commit, 1, "removed-branch", "feature-three"))
			},
		},
		{
			name: "branch index no longer identifies conflict branch",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), validRebaseMarker(trunk, commit, 2, "feature-two", "feature-three"))
			},
		},
		{
			name: "original branch is not tracked",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), validRebaseMarker(trunk, commit, 1, "feature-two", "removed-branch"))
			},
		},
		{
			name: "original refs omit a tracked branch",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				refs := marker["originalRefs"].(map[string]string)
				delete(refs, "feature-one")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "omitted deleted merged branch with Head fallback",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				targetGit(t, target.Path, "branch", "-D", "feature-three")
				stack := recoveryStackFileWithMergedBranches(
					trunk,
					commit,
					[]string{"feature-one", "feature-two", "feature-three"},
					map[string]bool{"feature-three": true},
				)
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), stack)
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				delete(marker["originalRefs"].(map[string]string), "feature-three")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "missing remaining branches",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				delete(marker, "remainingBranches")
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "original refs contain an untracked branch",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				refs := marker["originalRefs"].(map[string]string)
				refs["removed-branch"] = commit
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "malformed original ref",
			mutate: func(t *testing.T, target Target, trunk, commit string) {
				marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
				refs := marker["originalRefs"].(map[string]string)
				refs["feature-two"] = "not-an-object-id"
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			},
		},
		{
			name: "marker without active rebase",
			mutate: func(t *testing.T, target Target, _, _ string) {
				if err := os.RemoveAll(filepath.Join(target.GitDir, "rebase-merge")); err != nil {
					t.Fatalf("remove synthetic rebase directory: %v", err)
				}
				if err := os.Remove(filepath.Join(target.GitDir, "REBASE_HEAD")); err != nil {
					t.Fatalf("remove synthetic REBASE_HEAD: %v", err)
				}
			},
		},
		{
			name: "empty rebase directory",
			mutate: func(t *testing.T, target Target, _, _ string) {
				for _, name := range []string{"head-name", "onto", "orig-head", "git-rebase-todo", "done"} {
					if err := os.Remove(filepath.Join(target.GitDir, "rebase-merge", name)); err != nil {
						t.Fatalf("remove synthetic rebase state %s: %v", name, err)
					}
				}
				if err := os.Remove(filepath.Join(target.GitDir, "REBASE_HEAD")); err != nil {
					t.Fatalf("remove synthetic REBASE_HEAD: %v", err)
				}
			},
		},
		{
			name: "missing rebase head name",
			mutate: func(t *testing.T, target Target, _, _ string) {
				if err := os.Remove(filepath.Join(target.GitDir, "rebase-merge", "head-name")); err != nil {
					t.Fatalf("remove synthetic rebase head-name: %v", err)
				}
			},
		},
		{
			name: "mismatched rebase head name",
			mutate: func(t *testing.T, target Target, _, commit string) {
				writeTargetStateBytes(t, filepath.Join(target.GitDir, "rebase-merge", "head-name"), []byte("refs/heads/feature-one\n"))
				writeTargetStateBytes(t, filepath.Join(target.GitDir, "rebase-merge", "orig-head"), []byte(commit+"\n"))
			},
		},
		{
			name: "rebase original head does not match marker refs",
			mutate: func(t *testing.T, target Target, _, _ string) {
				writeTargetStateBytes(t, filepath.Join(target.GitDir, "rebase-merge", "orig-head"), []byte(strings.Repeat("b", 40)+"\n"))
			},
		},
		{
			name: "incomplete rebase directory",
			mutate: func(t *testing.T, target Target, _, _ string) {
				if err := os.Remove(filepath.Join(target.GitDir, "rebase-merge", "onto")); err != nil {
					t.Fatalf("remove synthetic rebase onto: %v", err)
				}
			},
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			target, trunk, commit := newTargetRecoveryFixture(t)
			writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
			testCase.mutate(t, target, trunk, commit)
			_, extensionAudit := installTargetCommandAudit(t)

			guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateRebaseContinueState, "rebase", "--continue")
			if guardErr == nil {
				t.Fatalf("ValidateRebaseContinueState accepted invalid recovery; launch error = %v", launchErr)
			}
			if launchErr != nil {
				t.Errorf("Stack extension launched before recovery rejection: %v", launchErr)
			}
			assertNoTargetExtensionInvocation(t, extensionAudit)
		})
	}
}

func TestValidateRebaseContinueStateAcceptsEmptyRemainingBranches(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
	marker["remainingBranches"] = []string{}
	marker["endIndex"] = 2
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)

	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected an empty remainingBranches list at the selected range end: %v", err)
	}
}

func TestValidateRebaseContinueStateAcceptsFullScopedRemainingBranches(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	targetGit(t, target.Path, "branch", "feature-four")
	branches := []string{"feature-one", "feature-two", "feature-three", "feature-four"}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), recoveryStackFile(trunk, commit, branches))
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
	marker["startIndex"] = 1
	marker["endIndex"] = 3
	marker["originalRefs"].(map[string]string)["feature-four"] = commit
	marker["remainingBranches"] = []string{"feature-three"}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
	writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")

	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected the full suffix of the scoped rebase range: %v", err)
	}
}

func TestValidateRebaseContinueStateRejectsIncompleteRemainingBranchesBeforeLaunch(t *testing.T) {
	tests := []struct {
		name          string
		remaining     []string
		omitRemaining bool
	}{
		{name: "truncated suffix", remaining: []string{"feature-three"}},
		{name: "omitted suffix", omitRemaining: true},
		{name: "reordered suffix", remaining: []string{"feature-four", "feature-three"}},
		{name: "empty before selected range end", remaining: []string{}},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			target, trunk, commit := newTargetRecoveryFixture(t)
			targetGit(t, target.Path, "branch", "feature-four")
			branches := []string{"feature-one", "feature-two", "feature-three", "feature-four"}
			writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), recoveryStackFile(trunk, commit, branches))
			marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
			marker["endIndex"] = 4
			marker["originalRefs"].(map[string]string)["feature-four"] = commit
			if testCase.omitRemaining {
				delete(marker, "remainingBranches")
			} else {
				marker["remainingBranches"] = testCase.remaining
			}
			writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
			writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")
			_, extensionAudit := installTargetCommandAudit(t)

			guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateRebaseContinueState, "rebase", "--continue")
			if guardErr == nil || !strings.Contains(guardErr.Error(), "remainingBranches") {
				t.Fatalf("ValidateRebaseContinueState error = %v, want incomplete remainingBranches rejection; launch error = %v", guardErr, launchErr)
			}
			if launchErr != nil {
				t.Errorf("Stack extension launched before incomplete-remainder rejection: %v", launchErr)
			}
			assertNoTargetExtensionInvocation(t, extensionAudit)
		})
	}
}

func TestValidateRebaseContinueStateRejectsMissingRemainingBranches(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
	delete(marker, "remainingBranches")
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)

	err := ValidateRebaseContinueState(target)
	if err == nil || !strings.Contains(err.Error(), "remainingBranches") {
		t.Fatalf("ValidateRebaseContinueState error = %v, want missing remainingBranches rejection", err)
	}
}

func TestValidateRebaseContinueStateRejectsStaleRemainingBranchesBeforeLaunch(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	targetGit(t, target.Path, "branch", "feature-four")
	stackBranches := []string{"feature-one", "feature-two", "feature-four", "feature-three"}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), recoveryStackFile(trunk, commit, stackBranches))
	marker := validRebaseMarker(trunk, commit, 1, "feature-two", "feature-three")
	originalRefs := marker["originalRefs"].(map[string]string)
	originalRefs["feature-four"] = commit
	marker["remainingBranches"] = []string{"feature-three", "feature-four"}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), marker)
	writeActiveRebaseFixture(t, target.GitDir, commit, "feature-two")
	_, extensionAudit := installTargetCommandAudit(t)

	guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateRebaseContinueState, "rebase", "--continue")
	if guardErr == nil || !strings.Contains(guardErr.Error(), "remainingBranches") {
		t.Fatalf("ValidateRebaseContinueState error = %v, want stale remainingBranches rejection; launch error = %v", guardErr, launchErr)
	}
	if launchErr != nil {
		t.Errorf("Stack extension launched before stale-remainder rejection: %v", launchErr)
	}
	assertNoTargetExtensionInvocation(t, extensionAudit)
}

func TestValidateSubmitStateRejectsPendingSubmitBeforeLaunch(t *testing.T) {
	target, _, _ := newTargetRecoveryFixture(t)
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-modify-state"), map[string]any{
		"schema_version":        1,
		"phase":                 "pending_submit",
		"prior_remote_stack_id": "123",
	})
	_, extensionAudit := installTargetCommandAudit(t)

	guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateSubmitState, "submit", "--auto")
	if guardErr == nil {
		t.Fatalf("ValidateSubmitState accepted pending_submit; launch error = %v", launchErr)
	}
	if launchErr != nil {
		t.Errorf("Stack extension launched before pending-submit rejection: %v", launchErr)
	}
	assertNoTargetExtensionInvocation(t, extensionAudit)
}

func TestValidateSubmitStateAllowsAbsentAndUnrelatedModifyStates(t *testing.T) {
	tests := []struct {
		name               string
		phase              string
		priorRemoteStackID string
	}{
		{name: "no modify state"},
		{name: "applying", phase: "applying"},
		{name: "conflict", phase: "conflict"},
		{name: "pending submit without a previous remote Stack", phase: "pending_submit"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			target, _, _ := newTargetRecoveryFixture(t)
			if testCase.phase != "" {
				writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-modify-state"), map[string]any{
					"phase":                 testCase.phase,
					"prior_remote_stack_id": testCase.priorRemoteStackID,
					"snapshot":              map[string]any{"branches": []any{}},
				})
			}

			if err := ValidateSubmitState(target); err != nil {
				t.Fatalf("ValidateSubmitState rejected %s state: %v", testCase.name, err)
			}
		})
	}
}

func TestValidateSubmitStateRejectsMalformedModifyState(t *testing.T) {
	target, _, _ := newTargetRecoveryFixture(t)
	writeTargetStateBytes(t, filepath.Join(target.GitDir, "gh-stack-modify-state"), []byte(`{"phase":`))
	_, extensionAudit := installTargetCommandAudit(t)

	guardErr, launchErr := runTargetStackTestCommandAfterGuard(target, ValidateSubmitState, "submit", "--auto")
	if guardErr == nil {
		t.Fatalf("ValidateSubmitState accepted malformed modify state; launch error = %v", launchErr)
	}
	if launchErr != nil {
		t.Errorf("Stack extension launched before malformed-state rejection: %v", launchErr)
	}
	assertNoTargetExtensionInvocation(t, extensionAudit)
}

func TestRecoveryGuardsUseTargetWorktreeGitDir(t *testing.T) {
	mainWorktree := newTargetRepository(t)
	addTargetRemote(t, mainWorktree, "origin", "https://github.com/owner/project.git", "")
	configureTargetCommit(t, mainWorktree)
	targetGit(t, mainWorktree, "commit", "--quiet", "--allow-empty", "-m", "initial")
	commit := targetGit(t, mainWorktree, "rev-parse", "HEAD")
	trunk := targetGit(t, mainWorktree, "branch", "--show-current")
	for _, branch := range []string{"feature-one", "feature-three"} {
		targetGit(t, mainWorktree, "branch", branch)
	}

	linkedWorktree := filepath.Join(t.TempDir(), "linked")
	targetGit(t, mainWorktree, "worktree", "add", "--quiet", "-b", "feature-two", linkedWorktree, "HEAD")
	target, err := ValidateTarget(linkedWorktree, "origin")
	if err != nil {
		t.Fatalf("ValidateTarget linked recovery fixture: %v", err)
	}
	if target.GitDir == target.CommonDir {
		t.Fatal("linked worktree fixture uses one directory for per-worktree and common Git state")
	}

	commonTarget := target
	commonTarget.GitDir = target.CommonDir
	writeValidRecoveryFixture(t, commonTarget, trunk, commit, 1, "feature-two", "feature-three")
	if err := ValidateRebaseContinueState(target); err == nil {
		t.Fatal("ValidateRebaseContinueState accepted recovery state stored only in the common Git directory")
	}
	if err := ValidateSubmitState(target); err != nil {
		t.Fatalf("ValidateSubmitState read modify state from the common Git directory: %v", err)
	}

	writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
	if err := ValidateRebaseContinueState(target); err != nil {
		t.Fatalf("ValidateRebaseContinueState rejected linked worktree state: %v", err)
	}
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-modify-state"), map[string]any{
		"phase":                 "pending_submit",
		"prior_remote_stack_id": "123",
	})
	if err := ValidateSubmitState(target); err == nil {
		t.Fatal("ValidateSubmitState accepted pending modify state from the linked worktree Git directory")
	}
}

func newTargetRecoveryFixture(t *testing.T) (Target, string, string) {
	t.Helper()
	worktree := newTargetRepository(t)
	addTargetRemote(t, worktree, "origin", "https://github.com/owner/project.git", "")
	configureTargetCommit(t, worktree)
	targetGit(t, worktree, "commit", "--quiet", "--allow-empty", "-m", "initial")
	commit := targetGit(t, worktree, "rev-parse", "HEAD")
	trunk := targetGit(t, worktree, "branch", "--show-current")
	for _, branch := range []string{"feature-one", "feature-two", "feature-three"} {
		targetGit(t, worktree, "branch", branch)
	}

	target, err := ValidateTarget(worktree, "origin")
	if err != nil {
		t.Fatalf("ValidateTarget recovery fixture: %v", err)
	}
	return target, trunk, commit
}

func configureTargetCommit(t *testing.T, worktree string) {
	t.Helper()
	targetGit(t, worktree, "config", "user.name", "Target Fixture")
	targetGit(t, worktree, "config", "user.email", "target-fixture@example.invalid")
	targetGit(t, worktree, "config", "commit.gpgsign", "false")
	targetGit(t, worktree, "config", "core.hooksPath", "/dev/null")
}

func writeValidRecoveryFixture(t *testing.T, target Target, trunk, commit string, branchIndex int, conflictBranch, originalBranch string) {
	t.Helper()
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack"), recoveryStackFile(trunk, commit, []string{"feature-one", "feature-two", "feature-three"}))
	writeTargetStateJSON(t, filepath.Join(target.GitDir, "gh-stack-rebase-state"), validRebaseMarker(trunk, commit, branchIndex, conflictBranch, originalBranch))
	writeActiveRebaseFixture(t, target.GitDir, commit, conflictBranch)
}

func recoveryStackFile(trunk, commit string, branches []string) map[string]any {
	stackBranches := make([]any, 0, len(branches))
	for _, branch := range branches {
		stackBranches = append(stackBranches, map[string]any{
			"branch": branch,
			"head":   commit,
			"base":   commit,
		})
	}
	return map[string]any{
		"schemaVersion": 1,
		"repository":    "github.com/owner/project",
		"stacks": []any{
			map[string]any{
				"id":     "123",
				"number": 7,
				"trunk": map[string]any{
					"branch": trunk,
					"head":   commit,
				},
				"branches": stackBranches,
			},
		},
	}
}

func recoveryStackFileWithMergedBranches(trunk, commit string, branches []string, mergedBranches map[string]bool) map[string]any {
	stack := recoveryStackFile(trunk, commit, branches)
	stackEntry := stack["stacks"].([]any)[0].(map[string]any)
	for _, rawBranch := range stackEntry["branches"].([]any) {
		branch := rawBranch.(map[string]any)
		if mergedBranches[branch["branch"].(string)] {
			branch["pullRequest"] = map[string]any{"number": 42, "merged": true}
		}
	}
	return stack
}

func setRecoveryStackBranchHead(stack map[string]any, branchName, head string) bool {
	stackEntry := stack["stacks"].([]any)[0].(map[string]any)
	for _, rawBranch := range stackEntry["branches"].([]any) {
		branch := rawBranch.(map[string]any)
		if branch["branch"] != branchName {
			continue
		}
		if head == "" {
			delete(branch, "head")
		} else {
			branch["head"] = head
		}
		return true
	}
	return false
}

func setRecoveryStackBranchPullRequest(stack map[string]any, branchName string, pullRequest map[string]any) bool {
	stackEntry := stack["stacks"].([]any)[0].(map[string]any)
	for _, rawBranch := range stackEntry["branches"].([]any) {
		branch := rawBranch.(map[string]any)
		if branch["branch"] != branchName {
			continue
		}
		if pullRequest == nil {
			delete(branch, "pullRequest")
		} else {
			branch["pullRequest"] = pullRequest
		}
		return true
	}
	return false
}

func validRebaseMarker(trunk, commit string, branchIndex int, conflictBranch, originalBranch string) map[string]any {
	branches := []string{"feature-one", "feature-two", "feature-three"}
	originalRefs := make(map[string]string, len(branches))
	for _, branch := range branches {
		originalRefs[branch] = commit
	}
	endIndex := len(branches)
	remainingBranches := append([]string(nil), branches[branchIndex+1:endIndex]...)
	return map[string]any{
		"currentBranchIndex":        branchIndex,
		"conflictBranch":            conflictBranch,
		"remainingBranches":         remainingBranches,
		"originalBranch":            originalBranch,
		"originalRefs":              originalRefs,
		"useOnto":                   false,
		"ontoOldBase":               "",
		"committerDateIsAuthorDate": false,
		"noTrunk":                   false,
		"trunkRef":                  trunk,
		"trunkSha":                  commit,
		"endIndex":                  endIndex,
	}
}

func writeActiveRebaseFixture(t *testing.T, gitDir, commit, conflictBranch string) {
	t.Helper()
	rebaseDir := filepath.Join(gitDir, "rebase-merge")
	if err := os.Mkdir(rebaseDir, 0o755); err != nil {
		t.Fatalf("create synthetic rebase directory: %v", err)
	}
	for path, contents := range map[string]string{
		"head-name":       "refs/heads/" + conflictBranch + "\n",
		"onto":            commit + "\n",
		"orig-head":       commit + "\n",
		"git-rebase-todo": "",
		"done":            "pick " + commit + " fixture\n",
	} {
		writeTargetStateBytes(t, filepath.Join(rebaseDir, path), []byte(contents))
	}
	writeTargetStateBytes(t, filepath.Join(gitDir, "REBASE_HEAD"), []byte(commit+"\n"))
}

func writeActiveRebaseApplyFixture(t *testing.T, gitDir, commit, conflictBranch string) {
	t.Helper()
	rebaseDir := filepath.Join(gitDir, "rebase-apply")
	if err := os.Mkdir(rebaseDir, 0o755); err != nil {
		t.Fatalf("create synthetic apply-backend rebase directory: %v", err)
	}
	for path, contents := range map[string]string{
		"head-name":       "refs/heads/" + conflictBranch + "\n",
		"onto":            commit + "\n",
		"orig-head":       commit + "\n",
		"next":            "1\n",
		"last":            "1\n",
		"original-commit": commit + "\n",
		"rebasing":        "",
	} {
		writeTargetStateBytes(t, filepath.Join(rebaseDir, path), []byte(contents))
	}
	writeTargetStateBytes(t, filepath.Join(gitDir, "REBASE_HEAD"), []byte(commit+"\n"))
}

func writeTargetStateJSON(t *testing.T, path string, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal synthetic target state: %v", err)
	}
	writeTargetStateBytes(t, path, data)
}

func writeTargetStateBytes(t *testing.T, path string, contents []byte) {
	t.Helper()
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatalf("write synthetic target state %s: %v", path, err)
	}
}

func runTargetStackTestCommandAfterGuard(target Target, guard func(Target) error, arguments ...string) (error, error) {
	if err := guard(target); err != nil {
		return err, nil
	}
	return nil, exec.Command("gh-stack", arguments...).Run()
}

func assertNoTargetExtensionInvocation(t *testing.T, extensionAudit string) {
	t.Helper()
	if _, err := os.Stat(extensionAudit); err == nil {
		output, readErr := os.ReadFile(extensionAudit)
		if readErr != nil {
			t.Fatalf("read extension audit log: %v", readErr)
		}
		t.Errorf("extension process executed before guard rejection: %s", output)
	} else if !os.IsNotExist(err) {
		t.Fatalf("inspect extension audit log: %v", err)
	}
}
