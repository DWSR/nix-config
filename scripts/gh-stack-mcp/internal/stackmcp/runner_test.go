package stackmcp

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
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
	result, err := runner.Run(context.Background(), fixture.target, CommandSpec{Args: []string{"fixture"}})
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

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
