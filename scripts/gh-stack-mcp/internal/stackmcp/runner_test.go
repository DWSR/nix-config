package stackmcp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

type processRunnerFixture struct {
	root   string
	config ProcessRunnerConfig
	target Target
}

func newProcessRunnerFixture(t *testing.T, extensionScript, gitScript, ghScript string) processRunnerFixture {
	t.Helper()
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	if err := os.MkdirAll(worktree, 0o700); err != nil {
		t.Fatalf("create fake worktree: %v", err)
	}
	resolvedWorktree, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		t.Fatalf("resolve fake worktree: %v", err)
	}

	config := ProcessRunnerConfig{
		ExtensionPath: filepath.Join(root, "extension", "bin", "gh-stack"),
		GitPath:       filepath.Join(root, "git", "bin", "git"),
		GHPath:        filepath.Join(root, "gh", "bin", "gh"),
	}
	writeRunnerExecutable(t, config.ExtensionPath, extensionScript)
	writeRunnerExecutable(t, config.GitPath, gitScript)
	writeRunnerExecutable(t, config.GHPath, ghScript)

	return processRunnerFixture{
		root:   root,
		config: config,
		target: Target{
			Path:       resolvedWorktree,
			GitDir:     filepath.Join(resolvedWorktree, ".git"),
			CommonDir:  filepath.Join(resolvedWorktree, ".git"),
			Remote:     "origin",
			Repository: "github.com/octo/stack",
		},
	}
}

func writeRunnerExecutable(t *testing.T, path, script string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("create fake executable directory: %v", err)
	}
	contents := "#!/bin/sh\n" + script + "\n"
	if err := os.WriteFile(path, []byte(contents), 0o700); err != nil {
		t.Fatalf("write fake executable: %v", err)
	}
}

func newTestProcessRunner(t *testing.T, config ProcessRunnerConfig) *ProcessRunner {
	t.Helper()
	runner, err := NewProcessRunner(config)
	if err != nil {
		t.Fatalf("NewProcessRunner() error = %v", err)
	}
	return runner
}

func TestProcessRunnerUsesFixedExecutableAndIsolatedEnvironment(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "shell-injection-marker")
	fixture := newProcessRunnerFixture(t, `
printf 'cwd=<%s>\n' "$(pwd)"
printf 'arg=<%s>\n' "$@"
printf 'repo=<%s>\n' "${GH_REPO-}"
printf 'ghpath=<%s>\n' "${GH_PATH-}"
printf 'path=<%s>\n' "${PATH-}"
printf 'home=<%s>\n' "${HOME-}"
printf 'xdgconfig=<%s>\n' "${XDG_CONFIG_HOME-}"
printf 'xdgdata=<%s>\n' "${XDG_DATA_HOME-}"
printf 'xdgstate=<%s>\n' "${XDG_STATE_HOME-}"
printf 'xdgcache=<%s>\n' "${XDG_CACHE_HOME-}"
printf 'ghconfig=<%s>\n' "${GH_CONFIG_DIR-}"
printf 'ssh=<%s>\n' "${SSH_AUTH_SOCK-}"
printf 'sshpid=<%s>\n' "${SSH_AGENT_PID-}"
printf 'gnupghome=<%s>\n' "${GNUPGHOME-}"
if [ -t 0 ]; then printf 'stdin=tty\n'; else printf 'stdin=not-tty\n'; fi
if IFS= read -r input; then printf 'stdin=not-eof\n'; else printf 'stdin=eof\n'; fi
export -p
printf 'extension stdout\n'
printf 'extension stderr\n' >&2
`, ":", ":")
	fixedExtensionPath := filepath.Join(filepath.Dir(fixture.config.ExtensionPath), "pinned-extension")
	if err := os.Rename(fixture.config.ExtensionPath, fixedExtensionPath); err != nil {
		t.Fatalf("rename fake extension to a non-PATH command name: %v", err)
	}
	fixture.config.ExtensionPath = fixedExtensionPath

	home := filepath.Join(fixture.root, "host-home")
	xdgConfig := filepath.Join(fixture.root, "xdg-config")
	xdgData := filepath.Join(fixture.root, "xdg-data")
	xdgState := filepath.Join(fixture.root, "xdg-state")
	xdgCache := filepath.Join(fixture.root, "xdg-cache")
	ghConfig := filepath.Join(fixture.root, "gh-config")
	gnupgHome := filepath.Join(fixture.root, "gnupg")
	tmp := filepath.Join(fixture.root, "tmp")
	for _, path := range []string{home, xdgConfig, xdgData, xdgState, xdgCache, ghConfig, gnupgHome, tmp} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			t.Fatalf("create allowed runtime directory: %v", err)
		}
	}

	allowedEnvironment := map[string]string{
		"HOME":            home,
		"XDG_CONFIG_HOME": xdgConfig,
		"XDG_DATA_HOME":   xdgData,
		"XDG_STATE_HOME":  xdgState,
		"XDG_CACHE_HOME":  xdgCache,
		"GH_CONFIG_DIR":   ghConfig,
		"GNUPGHOME":       gnupgHome,
		"GPG_AGENT_INFO":  filepath.Join(fixture.root, "gpg-agent") + ":123:1",
		"SSH_AUTH_SOCK":   filepath.Join(fixture.root, "ssh-agent.sock"),
		"SSH_AGENT_PID":   "4312",
		"TMPDIR":          tmp,
		"USER":            "runner-fixture",
		"LANG":            "C.UTF-8",
		"PATH":            "ambient-path-sentinel",
	}
	for name, value := range allowedEnvironment {
		t.Setenv(name, value)
	}

	deniedEnvironment := map[string]string{
		"GH_TOKEN":                "runner-gh-token-sentinel",
		"GITHUB_TOKEN":            "runner-github-token-sentinel",
		"GH_ENTERPRISE_TOKEN":     "runner-enterprise-token-sentinel",
		"MCP_GITHUB_TOKEN":        "runner-mcp-github-token-sentinel",
		"MCP_PROXY_AUTH_TOKEN":    "runner-mcp-proxy-token-sentinel",
		"MCPROXY_BEARER_TOKEN":    "runner-proxy-bearer-sentinel",
		"GH_HOST":                 "runner-inherited-host-sentinel",
		"GH_REPO":                 "wrong.example/attacker/repository",
		"HTTP_PROXY":              "http://proxy:runner-proxy-sentinel@proxy.invalid:8080",
		"HTTPS_PROXY":             "https://proxy:runner-https-proxy-sentinel@proxy.invalid:8443",
		"ALL_PROXY":               "socks5://runner-all-proxy-sentinel@proxy.invalid:1080",
		"http_proxy":              "http://runner-lower-proxy-sentinel@proxy.invalid:8080",
		"GIT_DIR":                 filepath.Join(fixture.root, "runner-git-dir-sentinel"),
		"GIT_WORK_TREE":           filepath.Join(fixture.root, "runner-work-tree-sentinel"),
		"GIT_INDEX_FILE":          filepath.Join(fixture.root, "runner-index-sentinel"),
		"GIT_COMMON_DIR":          filepath.Join(fixture.root, "runner-common-dir-sentinel"),
		"GIT_CONFIG_GLOBAL":       filepath.Join(fixture.root, "runner-global-config-sentinel"),
		"GIT_CONFIG_SYSTEM":       filepath.Join(fixture.root, "runner-system-config-sentinel"),
		"GIT_CONFIG_NOSYSTEM":     "runner-git-nosystem-sentinel",
		"GIT_CONFIG_COUNT":        "runner-git-config-count-sentinel",
		"GIT_CONFIG_KEY_0":        "commit.gpgsign",
		"GIT_CONFIG_VALUE_0":      "false",
		"GIT_CONFIG_PARAMETERS":   "commit.gpgsign=false",
		"GIT_SSH_COMMAND":         "ssh runner-git-ssh-sentinel",
		"GIT_ASKPASS":             "runner-git-askpass-sentinel",
		"MCP_PROXY_BEARER_SECRET": "runner-proxy-secret-sentinel",
	}
	for name, value := range deniedEnvironment {
		t.Setenv(name, value)
	}

	args := []string{
		"view",
		"--json",
		"argument with spaces",
		"; echo not-a-shell-command",
		"$(touch " + marker + ")",
		"*",
	}
	runner := newTestProcessRunner(t, fixture.config)
	var result ProcessResult
	var runErr error
	var serverStdout []byte
	result, runErr, serverStdout = runCapturingServerStdout(t, func() (ProcessResult, error) {
		return runner.Run(context.Background(), fixture.target, CommandSpec{Args: args})
	})
	if runErr != nil {
		t.Fatalf("Run() error = %v", runErr)
	}
	if len(serverStdout) != 0 {
		t.Errorf("runner wrote child bytes to server stdout: %q", serverStdout)
	}
	if !result.Spawned {
		t.Fatal("Run() did not report that the extension was spawned")
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("Run() exit code = %v, want 0", result.ExitCode)
	}
	if result.Truncated || result.StdoutTruncated || result.StderrTruncated {
		t.Fatal("small fixture output was reported as truncated")
	}

	stdout := string(result.Stdout)
	stderr := string(result.Stderr)
	if !strings.Contains(stdout, "cwd=<"+fixture.target.Path+">\n") {
		t.Errorf("child working directory was not Target.Path; stdout = %q", stdout)
	}
	var expectedArgs strings.Builder
	for _, arg := range args {
		fmt.Fprintf(&expectedArgs, "arg=<%s>\n", arg)
	}
	if !strings.Contains(stdout, expectedArgs.String()) {
		t.Errorf("extension argv was not passed literally; stdout = %q", stdout)
	}
	expectedPath := strings.Join([]string{
		filepath.Dir(fixture.config.ExtensionPath),
		filepath.Dir(fixture.config.GitPath),
		filepath.Dir(fixture.config.GHPath),
	}, string(os.PathListSeparator))
	for _, expected := range []string{
		"repo=<github.com/octo/stack>\n",
		"ghpath=<" + fixture.config.GHPath + ">\n",
		"path=<" + expectedPath + ">\n",
		"home=<" + home + ">\n",
		"xdgconfig=<" + xdgConfig + ">\n",
		"xdgdata=<" + xdgData + ">\n",
		"xdgstate=<" + xdgState + ">\n",
		"xdgcache=<" + xdgCache + ">\n",
		"ghconfig=<" + ghConfig + ">\n",
		"ssh=<" + allowedEnvironment["SSH_AUTH_SOCK"] + ">\n",
		"sshpid=<4312>\n",
		"gnupghome=<" + gnupgHome + ">\n",
		"stdin=not-tty\n",
		"stdin=eof\n",
		"extension stdout\n",
	} {
		if !strings.Contains(stdout, expected) {
			t.Errorf("child output is missing %q; stdout = %q", expected, stdout)
		}
	}
	if stderr != "extension stderr\n" {
		t.Errorf("stderr = %q, want only the child's stderr", stderr)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Errorf("shell metacharacter argument created a file: stat error = %v", err)
	}

	combinedOutput := stdout + stderr + string(serverStdout)
	for name, sentinel := range deniedEnvironment {
		if strings.Contains(combinedOutput, sentinel) {
			t.Errorf("child output exposed denied value from %s", name)
		}
	}
	for _, name := range []string{
		"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "MCP_GITHUB_TOKEN", "MCP_PROXY_AUTH_TOKEN",
		"MCPROXY_BEARER_TOKEN", "GH_HOST", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy",
		"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0",
		"GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "GIT_ASKPASS",
		"MCP_PROXY_BEARER_SECRET",
	} {
		if strings.Contains(stdout, "export "+name+"=") {
			t.Errorf("child inherited forbidden environment variable %s", name)
		}
	}
}

const (
	processRunnerTTYHelperEnv    = "GH_STACK_MCP_RUNNER_TTY_HELPER"
	processRunnerTTYHelperPassed = "PROCESS_RUNNER_TTY_HELPER_PASS"
)

func TestProcessRunnerCannotOpenControllingTTY(t *testing.T) {
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatalf("resolve test binary: %v", err)
	}

	command := exec.Command("/usr/bin/script", "-q", "/dev/null", testBinary,
		"-test.run=^TestProcessRunnerControllingTTYHelper$", "-test.v")
	command.Env = make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		name, _, ok := strings.Cut(entry, "=")
		if ok && name == processRunnerTTYHelperEnv {
			continue
		}
		command.Env = append(command.Env, entry)
	}
	command.Env = append(command.Env, processRunnerTTYHelperEnv+"=1")

	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run pseudo-TTY helper: %v\noutput:\n%s", err, output)
	}
	if !strings.Contains(string(output), processRunnerTTYHelperPassed) {
		t.Fatalf("pseudo-TTY helper did not report success; output:\n%s", output)
	}
}

func TestProcessRunnerControllingTTYHelper(t *testing.T) {
	if os.Getenv(processRunnerTTYHelperEnv) != "1" {
		t.Skip("runs only under the pseudo-TTY fixture")
	}

	tty, err := os.OpenFile("/dev/tty", os.O_RDONLY, 0)
	if err != nil {
		t.Fatalf("pseudo-TTY helper has no controlling terminal: %v", err)
	}
	if err := tty.Close(); err != nil {
		t.Fatalf("close helper controlling terminal: %v", err)
	}

	fixture := newProcessRunnerFixture(t, `
if ( : </dev/tty ) 2>/dev/null; then
	printf 'controlling-tty=opened\n'
else
	printf 'controlling-tty=denied\n'
fi
printf 'child stdout marker\n'
printf 'child stderr marker\n' >&2
`, ":", ":")
	runner := newTestProcessRunner(t, fixture.config)
	result, runErr, serverStdout := runCapturingServerStdout(t, func() (ProcessResult, error) {
		return runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"view"}})
	})
	if runErr != nil {
		t.Fatalf("Run() error = %v", runErr)
	}
	if !result.Spawned || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("Run() result = %+v, want spawned exit 0", result)
	}
	if got, want := string(result.Stdout), "controlling-tty=denied\nchild stdout marker\n"; got != want {
		t.Errorf("captured stdout = %q, want %q", got, want)
	}
	if got, want := string(result.Stderr), "child stderr marker\n"; got != want {
		t.Errorf("captured stderr = %q, want %q", got, want)
	}
	if len(serverStdout) != 0 {
		t.Errorf("runner wrote child bytes to server stdout: %q", serverStdout)
	}
	if t.Failed() {
		return
	}
	fmt.Fprintln(os.Stdout, processRunnerTTYHelperPassed)
}

func TestProcessRunnerBoundsBothStreamsAndPreservesNonzeroExit(t *testing.T) {
	fixture := newProcessRunnerFixture(t, `
printf '%131072s' ''
printf '%131072s' '' >&2
printf 'stdout-after-cap\n'
printf 'stderr-after-cap\n' >&2
exit 7
`, ":", ":")
	runner := newTestProcessRunner(t, fixture.config)
	result, err := runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"view"}})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !result.Spawned {
		t.Fatal("Run() did not report that the extension was spawned")
	}
	if result.ExitCode == nil || *result.ExitCode != 7 {
		t.Fatalf("Run() exit code = %v, want 7", result.ExitCode)
	}
	if got := len(result.Stdout); got != maxCapturedOutputBytes {
		t.Errorf("captured stdout bytes = %d, want %d", got, maxCapturedOutputBytes)
	}
	if got := len(result.Stderr); got != maxCapturedOutputBytes {
		t.Errorf("captured stderr bytes = %d, want %d", got, maxCapturedOutputBytes)
	}
	if !result.StdoutTruncated || !result.StderrTruncated || !result.Truncated {
		t.Errorf("truncation flags = stdout %t, stderr %t, overall %t; want all true",
			result.StdoutTruncated, result.StderrTruncated, result.Truncated)
	}
	if strings.Contains(string(result.Stdout), "stdout-after-cap") || strings.Contains(string(result.Stderr), "stderr-after-cap") {
		t.Error("captured output contains bytes beyond the per-stream cap")
	}
}

func TestProcessRunnerReturnsActionableAuthenticationFailureWithoutCredentials(t *testing.T) {
	fixture := newProcessRunnerFixture(t, `
"$GH_PATH" auth status
status=$?
exit "$status"
`, ":", `
if [ "${GH_TOKEN+x}" = x ] || [ "${GITHUB_TOKEN+x}" = x ] || [ "${MCP_GITHUB_TOKEN+x}" = x ]; then
	printf 'authentication leaked token: %s %s %s\n' "${GH_TOKEN-}" "${GITHUB_TOKEN-}" "${MCP_GITHUB_TOKEN-}" >&2
	exit 99
fi
printf 'not authenticated; run gh auth login\n' >&2
exit 17
`)
	t.Setenv("GH_TOKEN", "runner-auth-token-sentinel")
	t.Setenv("GITHUB_TOKEN", "runner-auth-github-sentinel")
	t.Setenv("MCP_GITHUB_TOKEN", "runner-auth-mcp-sentinel")

	runner := newTestProcessRunner(t, fixture.config)
	result, err := runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"view", "--json"}})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !result.Spawned || result.ExitCode == nil || *result.ExitCode != 17 {
		t.Fatalf("Run() result = %+v, want spawned exit 17", result)
	}
	if !strings.Contains(string(result.Stderr), "run gh auth login") {
		t.Errorf("authentication diagnostic is not actionable: %q", result.Stderr)
	}
	for _, sentinel := range []string{
		"runner-auth-token-sentinel", "runner-auth-github-sentinel", "runner-auth-mcp-sentinel",
	} {
		if strings.Contains(string(result.Stdout)+string(result.Stderr), sentinel) {
			t.Errorf("authentication output exposed credential sentinel %q", sentinel)
		}
	}
}

func TestProcessRunnerPreservesHostSigningFailureWithoutCredentialOverrides(t *testing.T) {
	fixture := newProcessRunnerFixture(t, `
git commit -m fixture
status=$?
exit "$status"
`, ":", ":")
	home := filepath.Join(fixture.root, "signing-home")
	xdgConfig := filepath.Join(fixture.root, "signing-xdg-config")
	if err := os.MkdirAll(filepath.Join(xdgConfig, "git"), 0o700); err != nil {
		t.Fatalf("create XDG Git config directory: %v", err)
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatalf("create signing HOME: %v", err)
	}
	if err := os.WriteFile(filepath.Join(xdgConfig, "git", "config"), []byte("[user]\n\tname = Fixture User\n"), 0o600); err != nil {
		t.Fatalf("write XDG Git config: %v", err)
	}
	signerPath := filepath.Join(fixture.root, "host-signer", "bin", "fake-signer")
	writeRunnerExecutable(t, signerPath, `
printf 'host signing failed; check the configured signing key and agent\n' >&2
exit 42
`)
	globalGitConfig := fmt.Sprintf("[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[gpg \"ssh\"]\n\tprogram = %s\n", signerPath)
	if err := os.WriteFile(filepath.Join(home, ".gitconfig"), []byte(globalGitConfig), 0o600); err != nil {
		t.Fatalf("write host-style global Git config: %v", err)
	}
	gitScript := `
if [ "${GIT_CONFIG_GLOBAL+x}" = x ] || [ "${GIT_CONFIG_SYSTEM+x}" = x ] ||
   [ "${GIT_CONFIG_NOSYSTEM+x}" = x ] || [ "${GIT_CONFIG_COUNT+x}" = x ] ||
   [ "${GIT_CONFIG_KEY_0+x}" = x ] || [ "${GIT_CONFIG_VALUE_0+x}" = x ] ||
   [ "${GIT_CONFIG_PARAMETERS+x}" = x ]; then
	printf 'Git config override unexpectedly reached the child\n' >&2
	exit 70
fi
if [ ! -r "$HOME/.gitconfig" ] || [ ! -r "$XDG_CONFIG_HOME/git/config" ]; then
	printf 'normal HOME/XDG Git config is unavailable\n' >&2
	exit 71
fi
signing_enabled=false
signer=
while IFS= read -r line; do
	case "$line" in
		*"gpgsign = true"*) signing_enabled=true ;;
		*"program = "*) signer=${line#*program = } ;;
	esac
done < "$HOME/.gitconfig"
if [ "$signing_enabled" != true ] || [ -z "$signer" ]; then
	printf 'host Git signing configuration was not preserved\n' >&2
	exit 72
fi
"$signer"
status=$?
exit "$status"
`
	writeRunnerExecutable(t, fixture.config.GitPath, gitScript)

	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", xdgConfig)
	t.Setenv("GH_TOKEN", "runner-signing-token-sentinel")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(fixture.root, "override-config-sentinel"))
	t.Setenv("GIT_CONFIG_SYSTEM", filepath.Join(fixture.root, "system-config-sentinel"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_COUNT", "1")
	t.Setenv("GIT_CONFIG_KEY_0", "commit.gpgsign")
	t.Setenv("GIT_CONFIG_VALUE_0", "false")
	t.Setenv("GIT_CONFIG_PARAMETERS", "commit.gpgsign=false")
	t.Setenv("GIT_DIR", filepath.Join(fixture.root, "override-git-dir-sentinel"))
	t.Setenv("GIT_WORK_TREE", filepath.Join(fixture.root, "override-worktree-sentinel"))
	t.Setenv("GIT_SSH_COMMAND", "ssh runner-signing-ssh-sentinel")

	runner := newTestProcessRunner(t, fixture.config)
	result, err := runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"add", "-m", "fixture"}})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !result.Spawned || result.ExitCode == nil || *result.ExitCode != 42 {
		t.Fatalf("Run() result = %+v, want spawned signer exit 42", result)
	}
	if !strings.Contains(string(result.Stderr), "host signing failed") || !strings.Contains(string(result.Stderr), "configured signing key") {
		t.Errorf("host signing failure diagnostic was not preserved: %q", result.Stderr)
	}
	if strings.Contains(string(result.Stderr), "override unexpectedly") {
		t.Errorf("inherited Git config override reached the child: %q", result.Stderr)
	}
	if strings.Contains(string(result.Stdout)+string(result.Stderr), "runner-signing-token-sentinel") {
		t.Error("signing failure exposed an inherited credential")
	}
}

func TestProcessRunnerReportsMissingFixedDependenciesBeforeSpawn(t *testing.T) {
	tests := []struct {
		name               string
		dependency         string
		missingPath        func(processRunnerFixture) string
		expectedDiagnostic string
	}{
		{
			name:               "extension",
			dependency:         "gh-stack",
			missingPath:        func(fixture processRunnerFixture) string { return filepath.Join(fixture.root, "missing", "gh-stack") },
			expectedDiagnostic: "gh-stack",
		},
		{
			name:               "Git",
			dependency:         "Git",
			missingPath:        func(fixture processRunnerFixture) string { return filepath.Join(fixture.root, "missing", "git") },
			expectedDiagnostic: "Git",
		},
		{
			name:               "gh",
			dependency:         "gh",
			missingPath:        func(fixture processRunnerFixture) string { return filepath.Join(fixture.root, "missing", "gh") },
			expectedDiagnostic: "gh",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			marker := filepath.Join(t.TempDir(), "extension-was-invoked")
			fixture := newProcessRunnerFixture(t,
				"printf 'invoked\\n' > "+shellQuote(marker),
				":", ":")
			config := fixture.config
			switch test.dependency {
			case "gh-stack":
				config.ExtensionPath = test.missingPath(fixture)
			case "Git":
				config.GitPath = test.missingPath(fixture)
			case "gh":
				config.GHPath = test.missingPath(fixture)
			}
			t.Setenv("GH_TOKEN", "runner-missing-token-sentinel")

			runner := newTestProcessRunner(t, config)
			result, err := runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"view", "--json"}})
			if err == nil {
				t.Fatal("Run() error = nil, want a missing dependency diagnostic")
			}
			if result.Spawned || result.ExitCode != nil {
				t.Errorf("missing dependency returned spawned result: %+v", result)
			}
			if !strings.Contains(err.Error(), test.expectedDiagnostic) ||
				!strings.Contains(err.Error(), "restore") && !strings.Contains(err.Error(), "rebuild") {
				t.Errorf("missing dependency error is not actionable: %v", err)
			}
			if strings.Contains(err.Error(), "runner-missing-token-sentinel") {
				t.Error("missing dependency error exposed an inherited credential")
			}
			if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
				t.Errorf("extension was invoked despite missing %s: stat error = %v", test.dependency, statErr)
			}
		})
	}
}

func TestProcessRunnerSelectsFixedBudgetFromFirstCommandArgument(t *testing.T) {
	timing := defaultProcessRunnerTiming()
	want := map[string]time.Duration{
		"view":     45 * time.Second,
		"init":     5 * time.Minute,
		"add":      5 * time.Minute,
		"checkout": 5 * time.Minute,
		"rebase":   15 * time.Minute,
		"sync":     15 * time.Minute,
		"push":     15 * time.Minute,
		"submit":   15 * time.Minute,
		"link":     15 * time.Minute,
		"unstack":  15 * time.Minute,
	}
	for operation, expected := range want {
		budget, err := timing.operationBudget(CommandSpec{Args: []string{operation, "ignored-by-budget-selection"}})
		if err != nil {
			t.Errorf("operationBudget(%q) error = %v", operation, err)
			continue
		}
		if budget != expected {
			t.Errorf("operationBudget(%q) = %s, want %s", operation, budget, expected)
		}
	}
	if _, err := timing.operationBudget(CommandSpec{Args: []string{"unknown"}}); err == nil {
		t.Error("operationBudget accepted an unknown operation")
	}
}

func TestProcessRunnerRejectsIncomingDeadlineWithoutMarginsBeforeSpawn(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "extension-was-invoked")
	fixture := newProcessRunnerFixture(t, "printf 'invoked\\n' > "+shellQuote(marker), ":", ":")
	runner := newTestProcessRunner(t, fixture.config)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(10*time.Second))
	defer cancel()

	result, err := runner.Run(ctx, fixture.target, CommandSpec{Args: []string{"push", "--remote", "origin"}})
	if err == nil {
		t.Fatal("Run() error = nil, want insufficient request-deadline budget")
	}
	if result.Spawned {
		t.Errorf("Run() reported a spawn despite insufficient deadline margins: %+v", result)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Errorf("extension was invoked despite insufficient deadline margins: stat error = %v", statErr)
	}
}

func TestProcessRunnerReservesCleanupAndDeliveryMargins(t *testing.T) {
	started := filepath.Join(t.TempDir(), "extension-started")
	fixture := newProcessRunnerFixture(t, ": > "+shellQuote(started)+"\nexec /bin/sleep 30", ":", ":")
	timing := shortProcessRunnerTiming()
	timing.cleanupTimeout = 100 * time.Millisecond
	timing.deliveryMargin = 150 * time.Millisecond
	timing.operationBudgets["view"] = 2 * time.Second
	runner := newTestProcessRunnerWithTiming(t, fixture.config, timing)
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()

	startedAt := time.Now()
	result, err := runner.Run(ctx, fixture.target, CommandSpec{Args: []string{"view", "--json"}})
	elapsed := time.Since(startedAt)
	if err == nil {
		t.Fatal("Run() error = nil, want the reserved execution deadline to stop the child")
	}
	if !result.Spawned || !result.TimedOut || result.CleanupUnknown {
		t.Errorf("Run() result = %+v, want spawned timeout with confirmed cleanup", result)
	}
	if !waitForRunnerFile(started, time.Second) {
		t.Fatal("fake extension did not start")
	}
	if elapsed >= 500*time.Millisecond {
		t.Errorf("Run() elapsed %s, want execution to stop before the request delivery margin", elapsed)
	}
}

func TestProcessRunnerRejectsDeadlineWithNoPositiveWorkWindow(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "extension-was-invoked")
	fixture := newProcessRunnerFixture(t, "printf 'invoked\\n' > "+shellQuote(marker), ":", ":")
	timing := shortProcessRunnerTiming()
	timing.cleanupTimeout = 70 * time.Millisecond
	timing.deliveryMargin = 80 * time.Millisecond
	runner := newTestProcessRunnerWithTiming(t, fixture.config, timing)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(100*time.Millisecond))
	defer cancel()

	result, err := runner.Run(ctx, fixture.target, CommandSpec{Args: []string{"view", "--json"}})
	if err == nil {
		t.Fatal("Run() error = nil, want a request deadline rejected before launch")
	}
	if result.Spawned {
		t.Errorf("Run() reported a spawn with no work window: %+v", result)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Errorf("extension was invoked with no work window: stat error = %v", statErr)
	}
}

func TestProcessRunnerEnforcesShortenedOperationBudget(t *testing.T) {
	started := filepath.Join(t.TempDir(), "extension-started")
	fixture := newProcessRunnerFixture(t, ": > "+shellQuote(started)+"\nexec /bin/sleep 30", ":", ":")
	timing := shortProcessRunnerTiming()
	timing.operationBudgets["view"] = 120 * time.Millisecond
	runner := newTestProcessRunnerWithTiming(t, fixture.config, timing)
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()

	startedAt := time.Now()
	result, err := runner.Run(ctx, fixture.target, CommandSpec{Args: []string{"view", "--json"}})
	elapsed := time.Since(startedAt)
	if err == nil {
		t.Fatal("Run() error = nil, want the operation budget to stop the child")
	}
	if !result.Spawned || !result.TimedOut || result.CleanupUnknown {
		t.Errorf("Run() result = %+v, want spawned timeout with confirmed cleanup", result)
	}
	if !waitForRunnerFile(started, time.Second) {
		t.Fatal("fake extension did not start")
	}
	if elapsed >= 400*time.Millisecond {
		t.Errorf("Run() elapsed %s, want the shortened operation budget plus bounded cleanup", elapsed)
	}
}

func TestProcessRunnerTreatsChildExitAfterShortenedDeadlineAsUncertain(t *testing.T) {
	started := filepath.Join(t.TempDir(), "extension-started")
	invocations := filepath.Join(t.TempDir(), "write-invocations")
	fixture := newProcessRunnerFixture(t, fmt.Sprintf(`
printf 'invoked\n' >> %s
: > %s
trap '' TERM
exec /bin/sleep 0.25
`, shellQuote(invocations), shellQuote(started)), ":", ":")
	timing := shortProcessRunnerTiming()
	timing.operationBudgets["push"] = 100 * time.Millisecond
	timing.cleanupTimeout = 1200 * time.Millisecond
	runner := newTestProcessRunnerWithTiming(t, fixture.config, timing)

	result, err := runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"push", "--remote", "origin"}})
	if err == nil {
		t.Fatal("Run() error = nil, want an uncertain result after the execution deadline")
	}
	if !waitForRunnerFile(started, time.Second) {
		t.Fatal("fake extension did not start")
	}
	if !result.Spawned || result.ExitCode == nil || *result.ExitCode != 0 || !result.TimedOut || result.Canceled || result.CleanupUnknown {
		t.Errorf("late child result = %+v, %v; want exit 0 marked timed out with confirmed cleanup", result, err)
	}
	invocationData, err := os.ReadFile(invocations)
	if err != nil {
		t.Fatalf("read write invocation count: %v", err)
	}
	if got := strings.Count(string(invocationData), "invoked\n"); got != 1 {
		t.Errorf("uncertain write invocation count = %d, want exactly 1", got)
	}
}

func TestProcessRunnerArbitratesReadyCompletionAgainstExpiredContext(t *testing.T) {
	tests := []struct {
		name         string
		makeContexts func() (context.Context, context.Context, func())
	}{
		{
			name: "request cancellation",
			makeContexts: func() (context.Context, context.Context, func()) {
				requestContext, cancelRequest := context.WithCancel(context.Background())
				executionContext, cancelExecution := context.WithCancel(requestContext)
				cancelRequest()
				return requestContext, executionContext, func() {
					cancelExecution()
					cancelRequest()
				}
			},
		},
		{
			name: "effective execution deadline",
			makeContexts: func() (context.Context, context.Context, func()) {
				requestContext, cancelRequest := context.WithCancel(context.Background())
				executionContext, cancelExecution := context.WithDeadline(requestContext, time.Now().Add(-time.Second))
				return requestContext, executionContext, func() {
					cancelExecution()
					cancelRequest()
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			requestContext, executionContext, cleanup := test.makeContexts()
			t.Cleanup(cleanup)

			waitResults := make(chan error, 1)
			waitErr := errors.New("fake child exited")
			waitResults <- waitErr
			if len(waitResults) != 1 {
				t.Fatal("wait result was not ready before arbitration")
			}
			select {
			case <-requestContext.Done():
			case <-executionContext.Done():
			default:
				t.Fatal("execution cancellation was not ready before arbitration")
			}

			waitResult, completed := arbitrateProcessCompletion(requestContext, executionContext, waitResults)
			if completed {
				t.Fatal("arbitration accepted an ordinary completion while cancellation or the effective deadline was ready")
			}
			if !waitResult.waited {
				t.Fatal("arbitration did not preserve the ready wait result for cleanup")
			}
			if waitResult.err != waitErr {
				t.Errorf("arbitration wait error = %v, want %v", waitResult.err, waitErr)
			}
		})
	}
}

func TestProcessRunnerSerializesLinkedWorktreesByCommonDirectory(t *testing.T) {
	stateDirectory := filepath.Join(t.TempDir(), "runner-overlap")
	overlap := filepath.Join(t.TempDir(), "overlap-detected")
	script := fmt.Sprintf(`
if ! /bin/mkdir %s 2>/dev/null; then
	printf 'overlap\n' > %s
fi
/bin/sleep 0.15
/bin/rmdir %s 2>/dev/null || true
`, shellQuote(stateDirectory), shellQuote(overlap), shellQuote(stateDirectory))
	fixture := newProcessRunnerFixture(t, script, ":", ":")
	first, second := linkedWorktreeTargets(t, fixture)
	runner := newTestProcessRunnerWithTiming(t, fixture.config, shortProcessRunnerTiming())

	start := make(chan struct{})
	results := make(chan runnerCall, 2)
	var wait sync.WaitGroup
	for _, target := range []Target{first, second} {
		wait.Add(1)
		go func(target Target) {
			defer wait.Done()
			<-start
			result, err := runner.Run(context.Background(), target, CommandSpec{Args: []string{"push", "--remote", "origin"}})
			results <- runnerCall{result: result, err: err}
		}(target)
	}
	close(start)
	wait.Wait()
	close(results)

	for call := range results {
		if call.err != nil || !call.result.Spawned || call.result.ExitCode == nil || *call.result.ExitCode != 0 {
			t.Errorf("linked-worktree Run() = %+v, %v; want spawned exit 0", call.result, call.err)
		}
	}
	if _, err := os.Stat(overlap); !os.IsNotExist(err) {
		t.Errorf("runner allowed same-common-dir worktree operations to overlap: stat error = %v", err)
	}
}

func TestProcessRunnerCancellationAndBudgetWhileWaitingForCommonDirectoryLock(t *testing.T) {
	holderStarted := filepath.Join(t.TempDir(), "holder-started")
	holderPIDPath := filepath.Join(t.TempDir(), "holder-pid")
	canceledWaiter := filepath.Join(t.TempDir(), "canceled-waiter-invoked")
	budgetWaiter := filepath.Join(t.TempDir(), "budget-waiter-invoked")
	script := fmt.Sprintf(`
case "$2" in
holder)
	printf '%%s\\n' "$$" > %s
	: > %s
	exec /bin/sleep 30
	;;
waiter-cancel)
	: > %s
	exec /bin/sleep 30
	;;
waiter-budget)
	: > %s
	exec /bin/sleep 30
	;;
esac
`, shellQuote(holderPIDPath), shellQuote(holderStarted), shellQuote(canceledWaiter), shellQuote(budgetWaiter))
	fixture := newProcessRunnerFixture(t, script, ":", ":")
	first, second := linkedWorktreeTargets(t, fixture)
	timing := shortProcessRunnerTiming()
	timing.operationBudgets["view"] = 150 * time.Millisecond
	timing.operationBudgets["push"] = 3 * time.Second
	runner := newTestProcessRunnerWithTiming(t, fixture.config, timing)

	holderContext, cancelHolder := context.WithCancel(context.Background())
	holderDone := make(chan runnerCall, 1)
	go func() {
		result, err := runner.Run(holderContext, first, CommandSpec{Args: []string{"push", "holder"}})
		holderDone <- runnerCall{result: result, err: err}
	}()
	defer cancelHolder()
	if !waitForRunnerFile(holderStarted, 2*time.Second) {
		cancelHolder()
		select {
		case call := <-holderDone:
			t.Fatalf("lock-holding fake extension exited before signaling start: result = %+v, error = %v", call.result, call.err)
		case <-time.After(time.Second):
		}
		t.Fatal("lock-holding fake extension did not start")
	}

	waiterContext, cancelWaiter := context.WithCancel(context.Background())
	waiterDone := make(chan runnerCall, 1)
	go func() {
		result, err := runner.Run(waiterContext, second, CommandSpec{Args: []string{"push", "waiter-cancel"}})
		waiterDone <- runnerCall{result: result, err: err}
	}()
	time.Sleep(75 * time.Millisecond)
	cancelWaiter()
	select {
	case call := <-waiterDone:
		if call.err == nil || call.result.Spawned || !call.result.Canceled {
			t.Errorf("canceled lock waiter = %+v, %v; want an unspawned cancellation", call.result, call.err)
		}
	case <-time.After(time.Second):
		t.Error("Run() remained blocked after cancellation while waiting for the repository lock")
	}
	if _, err := os.Stat(canceledWaiter); !os.IsNotExist(err) {
		t.Errorf("canceled lock waiter launched the extension: stat error = %v", err)
	}

	budgetDone := make(chan runnerCall, 1)
	budgetContext, cancelBudgetWaiter := context.WithCancel(context.Background())
	go func() {
		result, err := runner.Run(budgetContext, second, CommandSpec{Args: []string{"view", "waiter-budget"}})
		budgetDone <- runnerCall{result: result, err: err}
	}()
	select {
	case call := <-budgetDone:
		if call.err == nil || call.result.Spawned || !call.result.TimedOut {
			t.Errorf("budget-expired lock waiter = %+v, %v; want timeout before spawn", call.result, call.err)
		}
	case <-time.After(300 * time.Millisecond):
		cancelBudgetWaiter()
		select {
		case call := <-budgetDone:
			if call.err == nil || call.result.Spawned || !call.result.TimedOut {
				t.Errorf("budget-expired lock waiter = %+v, %v; want timeout before spawn", call.result, call.err)
			}
		case <-time.After(time.Second):
			t.Error("Run() exceeded its operation budget while waiting for the repository lock")
		}
	}
	cancelBudgetWaiter()
	if _, err := os.Stat(budgetWaiter); !os.IsNotExist(err) {
		t.Errorf("budget-expired lock waiter launched the extension: stat error = %v", err)
	}

	cancelHolder()
	select {
	case <-holderDone:
	case <-time.After(time.Second):
		if leaderPID, err := readRunnerPID(holderPIDPath); err == nil {
			_ = syscall.Kill(-leaderPID, syscall.SIGKILL)
		}
		t.Error("lock-holding process did not terminate after cancellation")
	}
}

func TestProcessRunnerTimesOutForkedWriteOnceAndReapsProcessGroup(t *testing.T) {
	invocations := filepath.Join(t.TempDir(), "write-invocations")
	leaderPIDPath := filepath.Join(t.TempDir(), "leader-pid")
	childPIDPath := filepath.Join(t.TempDir(), "child-pid")
	started := filepath.Join(t.TempDir(), "extension-started")
	script := fmt.Sprintf(`
printf 'invoked\n' >> %s
printf '%%s\n' "$$" > %s
(trap '' TERM; exec /bin/sleep 30) &
child=$!
printf '%%s\n' "$child" > %s
: > %s
wait "$child"
`, shellQuote(invocations), shellQuote(leaderPIDPath), shellQuote(childPIDPath), shellQuote(started))
	fixture := newProcessRunnerFixture(t, script, ":", ":")
	timing := shortProcessRunnerTiming()
	timing.cleanupTimeout = 250 * time.Millisecond
	timing.deliveryMargin = 80 * time.Millisecond
	runner := newTestProcessRunnerWithTiming(t, fixture.config, timing)
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	done := make(chan runnerCall, 1)
	go func() {
		result, err := runner.Run(ctx, fixture.target, CommandSpec{Args: []string{"push", "--remote", "origin"}})
		done <- runnerCall{result: result, err: err}
	}()

	if !waitForRunnerFile(started, time.Second) {
		cancel()
		if leaderPID, err := readRunnerPID(leaderPIDPath); err == nil {
			_ = syscall.Kill(-leaderPID, syscall.SIGKILL)
		}
		t.Fatal("forking fake extension did not start")
	}
	leaderPID, err := readRunnerPID(leaderPIDPath)
	if err != nil {
		cancel()
		t.Fatalf("read fake extension pid: %v", err)
	}
	childPID, err := readRunnerPID(childPIDPath)
	if err != nil {
		cancel()
		_ = syscall.Kill(-leaderPID, syscall.SIGKILL)
		t.Fatalf("read forked child pid: %v", err)
	}

	startedAt := time.Now()
	var call runnerCall
	returned := false
	select {
	case call = <-done:
		returned = true
	case <-time.After(timing.cleanupTimeout + 250*time.Millisecond):
		t.Error("Run() did not finish within its bounded process-group cleanup interval")
		_ = syscall.Kill(-leaderPID, syscall.SIGKILL)
		select {
		case call = <-done:
			returned = true
		case <-time.After(time.Second):
			t.Fatal("Run() remained blocked after test cleanup killed the fixture process group")
		}
	}
	if returned {
		if call.err == nil || !call.result.Spawned || call.result.Canceled || !call.result.TimedOut || call.result.CleanupUnknown {
			t.Errorf("timed-out write result = %+v, %v; want one spawned timeout with confirmed cleanup", call.result, call.err)
		}
		if elapsed := time.Since(startedAt); elapsed > timing.cleanupTimeout+250*time.Millisecond {
			t.Errorf("cancellation cleanup took %s, beyond its configured bound", elapsed)
		}
	}
	if err := syscall.Kill(-leaderPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("child process group still exists after Run(): kill(-%d, 0) = %v", leaderPID, err)
	}
	if childPID <= 0 {
		t.Errorf("forked child pid = %d, want a positive pid", childPID)
	}
	data, readErr := os.ReadFile(invocations)
	if readErr != nil {
		t.Fatalf("read write invocation count: %v", readErr)
	}
	if got := strings.Count(string(data), "invoked\n"); got != 1 {
		t.Errorf("uncertain write invocation count = %d, want exactly 1", got)
	}
}

func TestNewProcessRunnerRequiresAbsoluteExecutablePaths(t *testing.T) {
	fixture := newProcessRunnerFixture(t, ":", ":", ":")
	config := fixture.config
	config.ExtensionPath = "gh-stack"
	if _, err := NewProcessRunner(config); err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Errorf("NewProcessRunner() error = %v, want an absolute-path diagnostic", err)
	}
}

func runCapturingServerStdout(t *testing.T, run func() (ProcessResult, error)) (ProcessResult, error, []byte) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdout capture pipe: %v", err)
	}
	previousStdout := os.Stdout
	os.Stdout = writer
	var result ProcessResult
	var runErr error
	func() {
		defer func() { os.Stdout = previousStdout }()
		result, runErr = run()
	}()
	if err := writer.Close(); err != nil {
		t.Errorf("close stdout capture writer: %v", err)
	}
	serverStdout, readErr := io.ReadAll(reader)
	if err := reader.Close(); err != nil {
		t.Errorf("close stdout capture reader: %v", err)
	}
	if readErr != nil {
		t.Errorf("read captured server stdout: %v", readErr)
	}
	return result, runErr, serverStdout
}

type runnerCall struct {
	result ProcessResult
	err    error
}

func shortProcessRunnerTiming() processRunnerTiming {
	timing := defaultProcessRunnerTiming()
	for operation := range timing.operationBudgets {
		timing.operationBudgets[operation] = 3 * time.Second
	}
	timing.cleanupTimeout = 300 * time.Millisecond
	timing.deliveryMargin = 100 * time.Millisecond
	return timing
}

func newTestProcessRunnerWithTiming(t *testing.T, config ProcessRunnerConfig, timing processRunnerTiming) *ProcessRunner {
	t.Helper()
	runner, err := newProcessRunnerWithTiming(config, timing)
	if err != nil {
		t.Fatalf("newProcessRunnerWithTiming() error = %v", err)
	}
	return runner
}

func linkedWorktreeTargets(t *testing.T, fixture processRunnerFixture) (Target, Target) {
	t.Helper()
	commonDir := filepath.Join(fixture.root, "shared-common-git-dir")
	if err := os.MkdirAll(commonDir, 0o700); err != nil {
		t.Fatalf("create linked-worktree common directory: %v", err)
	}
	resolvedCommonDir, err := filepath.EvalSymlinks(commonDir)
	if err != nil {
		t.Fatalf("resolve linked-worktree common directory: %v", err)
	}

	first := fixture.target
	first.CommonDir = resolvedCommonDir
	secondPath := filepath.Join(fixture.root, "linked-worktree")
	if err := os.MkdirAll(secondPath, 0o700); err != nil {
		t.Fatalf("create linked worktree path: %v", err)
	}
	resolvedSecondPath, err := filepath.EvalSymlinks(secondPath)
	if err != nil {
		t.Fatalf("resolve linked worktree path: %v", err)
	}
	second := first
	second.Path = resolvedSecondPath
	second.GitDir = filepath.Join(fixture.root, "linked-worktree.git")
	return first, second
}

func waitForRunnerFile(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	_, err := os.Stat(path)
	return err == nil
}

func readRunnerPID(path string) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return 0, fmt.Errorf("invalid process ID file")
	}
	return pid, nil
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
