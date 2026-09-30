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
