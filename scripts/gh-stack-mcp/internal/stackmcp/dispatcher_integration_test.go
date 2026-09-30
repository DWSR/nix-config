package stackmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	fixtureExtensionPathEnv = "GH_STACK_MCP_EXTENSION_PATH"
	fixtureGitPathEnv       = "GH_STACK_MCP_GIT_PATH"
	fixtureGHPathEnv        = "GH_STACK_MCP_GH_PATH"
)

type validatedDispatchFixture struct {
	worktree      string
	gitDir        string
	commit        string
	extensionPath string
	gitPath       string
	ghPath        string
	invocations   string
	conflictFlag  string
	cancelFlag    string
	cancelStarted string
	cancelPID     string
}

func TestValidatedStackHandlersDispatchEveryOperationOverStdio(t *testing.T) {
	fixture := newValidatedDispatchFixture(t)
	client := startValidatedFixtureClient(t, fixture)

	cases := []struct {
		name string
		args map[string]any
	}{
		{name: "stack_view"},
		{name: "stack_init", args: map[string]any{"trunk": "main", "branches": []string{"feature-one"}}},
		{name: "stack_add", args: map[string]any{"branch": "feature-one", "stage": "none"}},
		{name: "stack_checkout", args: map[string]any{"branch": "feature-one"}},
		{name: "stack_rebase", args: map[string]any{"action": "start", "scope": "full"}},
		{name: "stack_sync", args: map[string]any{"prune": false}},
		{name: "stack_push"},
		{name: "stack_submit", args: map[string]any{"open": false}},
		{name: "stack_link", args: map[string]any{"branches": []string{"feature-one", "feature-two"}, "open": false}},
		{name: "stack_unstack", args: map[string]any{"stackNumber": 1, "mode": "localOnly"}},
	}
	wantInvocations := []string{
		"view|--json",
		"init|--base|main|feature-one",
		"add|feature-one",
		"checkout|feature-one",
		"rebase|--remote|origin",
		"sync|--remote|origin",
		"push|--remote|origin",
		"submit|--auto|--remote|origin",
		"link|--remote|origin|feature-one|feature-two",
		"unstack|1|--local",
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result, outcome := callValidatedTool(t, client, fixture, testCase.name, testCase.args)
			if result.IsError {
				t.Fatalf("CallTool(%s) returned an error: %v", testCase.name, result.Content)
			}
			if outcome.Operation != testCase.name || outcome.Repository != "github.com/owner/project" || !outcome.Spawned {
				t.Fatalf("typed outcome = %+v, want spawned %s outcome for the validated repository", outcome, testCase.name)
			}
			if outcome.ExitCode == nil || *outcome.ExitCode != 0 {
				t.Fatalf("typed outcome exit code = %v, want zero", outcome.ExitCode)
			}
			if outcome.Truncated {
				t.Fatalf("typed outcome unexpectedly reports truncation: %+v", outcome)
			}
			if testCase.name == "stack_view" {
				if outcome.Status != OutcomeLocalObservation {
					t.Fatalf("view status = %q, want %q", outcome.Status, OutcomeLocalObservation)
				}
				var view LocalView
				if err := json.Unmarshal([]byte(outcome.Stdout), &view); err != nil {
					t.Fatalf("decode normalized local view from Outcome.Stdout: %v", err)
				}
				if view.Trunk != "main" || view.CurrentBranch != "main" || len(view.Branches) != 1 || view.Branches[0].Name != "feature-one" {
					t.Errorf("local view = %+v, want local main/feature-one observations", view)
				}
				encodedOutcome, err := json.Marshal(outcome)
				if err != nil {
					t.Fatalf("marshal outcome: %v", err)
				}
				if strings.Contains(string(encodedOutcome), `"view"`) {
					t.Error("Outcome added a view property instead of using its existing Stdout contract")
				}
				return
			}
			if outcome.Status != OutcomeExitedUnverified {
				t.Errorf("mutation status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
			}
			if !strings.Contains(outcome.Stdout, "FAKE_EXTENSION_STDOUT:") {
				t.Errorf("captured fake extension stdout = %q", outcome.Stdout)
			}
		})
		if t.Failed() {
			return
		}
	}

	if got := readValidatedInvocations(t, fixture); !slices.Equal(got, wantInvocations) {
		t.Errorf("fake extension argv = %v, want fixed command vectors %v", got, wantInvocations)
	}
}

func TestValidatedDispatcherRejectsBeforeLaunchAndPreservesMCPErrorEnvelope(t *testing.T) {
	fixture := newValidatedDispatchFixture(t)
	client := startValidatedFixtureClient(t, fixture)
	call := func(name string, args map[string]any) (*mcp.CallToolResult, Outcome) {
		t.Helper()
		return callValidatedTool(t, client, fixture, name, args)
	}
	baseArgs := map[string]any{"path": fixture.worktree, "remote": "origin"}
	args := func(extra map[string]any) map[string]any {
		result := make(map[string]any, len(baseArgs)+len(extra))
		for key, value := range baseArgs {
			result[key] = value
		}
		for key, value := range extra {
			result[key] = value
		}
		return result
	}
	assertRejected := func(name, diagnostic string, result *mcp.CallToolResult, outcome Outcome) {
		t.Helper()
		if !result.IsError {
			t.Fatalf("CallTool(%s) did not set isError: %+v", name, result)
		}
		if outcome.Operation != name || outcome.Status != OutcomeRejected || outcome.Spawned || outcome.ExitCode != nil {
			t.Fatalf("CallTool(%s) typed error outcome = %+v, want rejected/unspawned", name, outcome)
		}
		if !strings.Contains(outcome.Stderr, diagnostic) {
			t.Errorf("CallTool(%s) outcome diagnostic = %q, want %q", name, outcome.Stderr, diagnostic)
		}
		if len(result.Content) == 0 {
			t.Fatalf("CallTool(%s) error envelope has no text content", name)
		}
		text, ok := result.Content[0].(*mcp.TextContent)
		if !ok || !strings.Contains(text.Text, diagnostic) {
			t.Errorf("CallTool(%s) error content = %#v, want diagnostic %q", name, result.Content[0], diagnostic)
		}
	}

	badPath := args(nil)
	badPath["path"] = "relative-worktree"
	result, outcome := call("stack_view", badPath)
	assertRejected("stack_view", "absolute", result, outcome)

	result, outcome = call("stack_checkout", args(map[string]any{"branch": "not a branch"}))
	assertRejected("stack_checkout", "valid Git branch name", result, outcome)

	result, outcome = call("stack_rebase", args(map[string]any{"action": "continue"}))
	assertRejected("stack_rebase", "rebase recovery marker is missing", result, outcome)

	if err := os.WriteFile(filepath.Join(fixture.gitDir, "gh-stack-modify-state"), []byte(`{"phase":"pending_submit","prior_remote_stack_id":"123"}`), 0o600); err != nil {
		t.Fatalf("write pending-submit guard fixture: %v", err)
	}
	result, outcome = call("stack_submit", args(map[string]any{"open": false}))
	assertRejected("stack_submit", "pending_submit", result, outcome)

	if _, err := exec.Command(fixture.gitPath, "-C", fixture.worktree, "config", "remote.pushDefault", "upstream").CombinedOutput(); err != nil {
		t.Fatalf("configure mismatching implicit remote: %v", err)
	}
	result, outcome = call("stack_checkout", args(map[string]any{"branch": "feature-one"}))
	assertRejected("stack_checkout", "automatic Git remote selection", result, outcome)
	result, outcome = call("stack_init", args(map[string]any{"trunk": "remote-trunk", "branches": []string{"feature-one"}}))
	assertRejected("stack_init", "automatic Git remote selection", result, outcome)

	if got := readValidatedInvocations(t, fixture); len(got) != 0 {
		t.Errorf("fake extension ran before a guard or command rejection: %v", got)
	}
}

func TestValidatedRebaseContinueConflictAndErrorEnvelopeOverStdio(t *testing.T) {
	fixture := newValidatedDispatchFixture(t)
	client := startValidatedFixtureClient(t, fixture)
	args := func(extra map[string]any) map[string]any {
		result := map[string]any{"path": fixture.worktree, "remote": "origin"}
		for key, value := range extra {
			result[key] = value
		}
		return result
	}

	result, outcome := callValidatedTool(t, client, fixture, "stack_rebase", map[string]any{
		"path": fixture.worktree, "remote": "origin", "action": "continue",
	})
	assertDispatchErrorOutcome(t, "stack_rebase", "rebase recovery marker is missing", result, outcome, OutcomeRejected, false)
	if got := readValidatedInvocations(t, fixture); len(got) != 0 {
		t.Fatalf("rebase --continue reached the extension without recovery state: %v", got)
	}

	target := fixture.target()
	writeValidRecoveryFixture(t, target, "main", fixture.commit, 1, "feature-two", "feature-three")
	result, outcome = callValidatedTool(t, client, fixture, "stack_rebase", args(map[string]any{"action": "continue"}))
	if result.IsError || outcome.Status != OutcomeExitedUnverified || !outcome.Spawned {
		t.Fatalf("guarded rebase continue = result=%+v outcome=%+v, want typed spawned unverified outcome", result, outcome)
	}

	if err := os.WriteFile(fixture.conflictFlag, nil, 0o600); err != nil {
		t.Fatalf("enable fake conflict response: %v", err)
	}
	result, outcome = callValidatedTool(t, client, fixture, "stack_rebase", args(map[string]any{"action": "start", "scope": "full"}))
	assertDispatchErrorOutcome(t, "stack_rebase", "controlled conflict", result, outcome, OutcomeConflictPending, true)
	if outcome.ExitCode == nil || *outcome.ExitCode != 3 {
		t.Errorf("conflict exit code = %v, want 3", outcome.ExitCode)
	}

	if err := os.Remove(filepath.Join(fixture.gitDir, "gh-stack-rebase-state")); err != nil {
		t.Fatalf("remove valid recovery marker: %v", err)
	}
	result, outcome = callValidatedTool(t, client, fixture, "stack_rebase", args(map[string]any{"action": "start", "scope": "full"}))
	assertDispatchErrorOutcome(t, "stack_rebase", "controlled conflict", result, outcome, OutcomeExitedUnverified, true)
	if got := readValidatedInvocations(t, fixture); len(got) != 3 {
		t.Errorf("fake extension invocations = %v, want only guarded continue and two starts", got)
	}
}

func TestValidatedCancellationOverStdioStopsTheChildWithoutRetry(t *testing.T) {
	fixture := newValidatedDispatchFixture(t)
	client := startValidatedFixtureClient(t, fixture)
	if err := os.WriteFile(fixture.cancelFlag, nil, 0o600); err != nil {
		t.Fatalf("enable fake long-running push: %v", err)
	}

	ctx, cancel := context.WithCancel(client.ctx)
	defer cancel()
	callDone := make(chan struct {
		result *mcp.CallToolResult
		err    error
	}, 1)
	go func() {
		result, err := client.session.CallTool(ctx, &mcp.CallToolParams{
			Name:      "stack_push",
			Arguments: map[string]any{"path": fixture.worktree, "remote": "origin"},
		})
		callDone <- struct {
			result *mcp.CallToolResult
			err    error
		}{result: result, err: err}
	}()

	if !waitForRunnerFile(fixture.cancelStarted, 5*time.Second) {
		cancel()
		t.Fatal("fake push did not start before the cancellation bound")
	}
	processID, err := readRunnerPID(fixture.cancelPID)
	if err != nil {
		cancel()
		t.Fatalf("read fake push process id: %v", err)
	}
	t.Cleanup(func() {
		if alive, _ := processGroupAlive(processID); alive {
			_ = syscall.Kill(-processID, syscall.SIGKILL)
		}
	})

	cancel()
	select {
	case call := <-callDone:
		if call.err != nil && !errors.Is(call.err, context.Canceled) {
			t.Errorf("canceled CallTool error = %v, want context cancellation", call.err)
		}
		if call.result != nil {
			if !call.result.IsError {
				t.Errorf("canceled CallTool result did not set isError: %+v", call.result)
			}
			var outcome Outcome
			decodeStructuredContent(t, call.result.StructuredContent, &outcome)
			if outcome.Status != OutcomeTimedOutUnknown || !outcome.Spawned {
				t.Errorf("canceled typed outcome = %+v, want spawned uncertain result", outcome)
			}
		}
	case <-time.After(3 * time.Second):
		t.Fatal("CallTool did not return after request cancellation")
	}

	if !waitForProcessGroupTermination(processID, 3*time.Second) {
		t.Errorf("runner left canceled child process group %d alive", processID)
	}
	if got := readValidatedInvocations(t, fixture); !slices.Equal(got, []string{"push|--remote|origin"}) {
		t.Errorf("canceled fake extension invocations = %v, want exactly one push and no retry", got)
	}
}

func TestValidatedRunnerTimeoutReturnsTypedUncertainOutcomeOverStdio(t *testing.T) {
	fixture := newValidatedDispatchFixture(t)
	if err := os.WriteFile(fixture.cancelFlag, nil, 0o600); err != nil {
		t.Fatalf("enable fake long-running push: %v", err)
	}
	client := startValidatedFixtureClientWithRole(t, fixture, "validated-timeout-server")
	result, outcome := callValidatedTool(t, client, fixture, "stack_push", nil)
	if !result.IsError {
		t.Fatalf("timed-out push did not set isError: %+v", result)
	}
	if outcome.Operation != "stack_push" || outcome.Status != OutcomeTimedOutUnknown || !outcome.Spawned {
		t.Fatalf("timed-out push outcome = %+v, want spawned timed_out_unknown", outcome)
	}
	if !strings.Contains(outcome.Stderr, "FAKE_EXTENSION_STDERR:push waiting") {
		t.Errorf("timed-out push lost captured child diagnostic: %q", outcome.Stderr)
	}
	if len(result.Content) == 0 {
		t.Fatal("timed-out push error envelope has no text content")
	}
	text, ok := result.Content[0].(*mcp.TextContent)
	if !ok || !strings.Contains(text.Text, "bounded time budget") {
		t.Errorf("timed-out push error content = %#v, want bounded-time diagnostic", result.Content[0])
	}
	processID, err := readRunnerPID(fixture.cancelPID)
	if err != nil {
		t.Fatalf("read fake timed-out push process id: %v", err)
	}
	if !waitForProcessGroupTermination(processID, 3*time.Second) {
		t.Errorf("runner left timed-out child process group %d alive", processID)
	}
	if got := readValidatedInvocations(t, fixture); !slices.Equal(got, []string{"push|--remote|origin"}) {
		t.Errorf("timed-out fake extension invocations = %v, want exactly one push and no retry", got)
	}
}

func TestNewServerRequiresFixedExecutablePaths(t *testing.T) {
	environment := withoutEnvironment(os.Environ(), fixtureExtensionPathEnv, fixtureGitPathEnv, fixtureGHPathEnv)
	environment = setEnv(environment, fixtureRoleEnv, "validated-server")
	err, serverStderr := connectToFixtureServerStartup(t, environment)
	if err == nil {
		t.Fatal("NewServer started without fixed extension, Git, and gh executable paths")
	}
	if !strings.Contains(serverStderr, "gh-stack-mcp") || !strings.Contains(serverStderr, fixtureExtensionPathEnv) {
		t.Fatalf("startup stderr = %q, want Stack-MCP-specific diagnostic naming %s", serverStderr, fixtureExtensionPathEnv)
	}
}

func TestNewServerRejectsRelativeExecutablePaths(t *testing.T) {
	environment := withoutEnvironment(os.Environ(), fixtureExtensionPathEnv, fixtureGitPathEnv, fixtureGHPathEnv)
	environment = setEnv(environment, fixtureRoleEnv, "validated-server")
	environment = setEnv(environment, fixtureExtensionPathEnv, "gh-stack")
	environment = setEnv(environment, fixtureGitPathEnv, "/bin/sh")
	environment = setEnv(environment, fixtureGHPathEnv, "/bin/sh")
	err, serverStderr := connectToFixtureServerStartup(t, environment)
	if err == nil {
		t.Fatal("NewServer accepted a relative extension executable path")
	}
	if !strings.Contains(serverStderr, "gh-stack-mcp") || !strings.Contains(serverStderr, fixtureExtensionPathEnv) {
		t.Fatalf("startup stderr = %q, want Stack-MCP-specific diagnostic naming %s", serverStderr, fixtureExtensionPathEnv)
	}
}

func connectToFixtureServerStartup(t *testing.T, environment []string) (error, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
	command.Env = environment
	var serverStderr bytes.Buffer
	command.Stderr = &serverStderr
	client := mcp.NewClient(&mcp.Implementation{Name: "startup-path-fixture", Version: "test"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if session != nil {
		if closeErr := session.Close(); err == nil {
			err = closeErr
		}
	}
	return err, serverStderr.String()
}

func newValidatedDispatchFixture(t *testing.T) validatedDispatchFixture {
	t.Helper()
	root := t.TempDir()
	worktree := filepath.Join(root, "worktree")
	if err := os.Mkdir(worktree, 0o755); err != nil {
		t.Fatalf("create validated dispatch worktree: %v", err)
	}
	targetGit(t, worktree, "init", "--quiet", "--initial-branch=main")
	configureTargetCommit(t, worktree)
	targetGit(t, worktree, "commit", "--quiet", "--allow-empty", "-m", "fixture")
	commit := targetGit(t, worktree, "rev-parse", "HEAD")
	for _, branch := range []string{"feature-one", "feature-two", "feature-three"} {
		targetGit(t, worktree, "branch", branch)
	}
	addTargetRemote(t, worktree, "origin", "https://github.com/owner/project.git", "")

	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatalf("locate Git for local fixture: %v", err)
	}
	extensionPath := filepath.Join(root, "bin", "gh-stack")
	ghPath := filepath.Join(root, "bin", "gh")
	invocations := filepath.Join(root, "extension-argv.log")
	conflictFlag := filepath.Join(root, "extension-conflict")
	cancelFlag := filepath.Join(root, "extension-cancel")
	cancelStarted := filepath.Join(root, "extension-cancel-started")
	cancelPID := filepath.Join(root, "extension-cancel-pid")
	viewJSON := `{"trunk":"main","currentBranch":"main","branches":[{"name":"feature-one","isCurrent":false,"isMerged":false,"isQueued":false,"needsRebase":false}]}`
	extension := fmt.Sprintf(`
operation="$1"
first_argument="${2-}"
printf '%%s' "$operation" >> %s
shift
for argument in "$@"; do printf '|%%s' "$argument" >> %s; done
printf '\n' >> %s
if [ "$operation" = "view" ]; then
  printf '%%s\n' %s
  printf 'FAKE_EXTENSION_STDERR:view\n' >&2
  exit 0
fi
if [ "$operation" = "rebase" ] && [ "$first_argument" != "--continue" ] && [ -f %s ]; then
  printf 'FAKE_EXTENSION_STDOUT:rebase conflict\n'
  printf 'controlled conflict\n' >&2
  exit 3
fi
if [ "$operation" = "push" ] && [ -f %s ]; then
  printf '%%s\n' "$$" > %s
  : > %s
  printf 'FAKE_EXTENSION_STDERR:push waiting\n' >&2
  exec /bin/sleep 30
fi
printf 'FAKE_EXTENSION_STDOUT:%%s\n' "$operation"
printf 'FAKE_EXTENSION_STDERR:%%s controlled fixture diagnostic\n' "$operation" >&2
exit 0
`, shellQuote(invocations), shellQuote(invocations), shellQuote(invocations), shellQuote(viewJSON), shellQuote(conflictFlag), shellQuote(cancelFlag), shellQuote(cancelPID), shellQuote(cancelStarted))
	writeRunnerExecutable(t, extensionPath, extension)
	writeRunnerExecutable(t, ghPath, ":")

	resolvedWorktree, err := filepath.EvalSymlinks(worktree)
	if err != nil {
		t.Fatalf("resolve validated dispatch worktree: %v", err)
	}
	gitDir, err := filepath.EvalSymlinks(filepath.Join(resolvedWorktree, ".git"))
	if err != nil {
		t.Fatalf("resolve validated dispatch Git directory: %v", err)
	}
	return validatedDispatchFixture{
		worktree:      resolvedWorktree,
		gitDir:        gitDir,
		commit:        commit,
		extensionPath: extensionPath,
		gitPath:       gitPath,
		ghPath:        ghPath,
		invocations:   invocations,
		conflictFlag:  conflictFlag,
		cancelFlag:    cancelFlag,
		cancelStarted: cancelStarted,
		cancelPID:     cancelPID,
	}
}

func (fixture validatedDispatchFixture) target() Target {
	return Target{
		Path:       fixture.worktree,
		GitDir:     fixture.gitDir,
		CommonDir:  fixture.gitDir,
		Remote:     "origin",
		Repository: "github.com/owner/project",
	}
}

func startValidatedFixtureClient(t *testing.T, fixture validatedDispatchFixture) fixtureClient {
	return startValidatedFixtureClientWithRole(t, fixture, "validated-server")
}

func startValidatedFixtureClientWithRole(t *testing.T, fixture validatedDispatchFixture, role string) fixtureClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)

	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^$")
	command.Env = setEnv(os.Environ(), fixtureRoleEnv, role)
	command.Env = setEnv(command.Env, fixtureExtensionPathEnv, fixture.extensionPath)
	command.Env = setEnv(command.Env, fixtureGitPathEnv, fixture.gitPath)
	command.Env = setEnv(command.Env, fixtureGHPathEnv, fixture.ghPath)
	command.Env = setEnv(command.Env, "PATH", t.TempDir())
	var serverStderr bytes.Buffer
	command.Stderr = &serverStderr
	client := mcp.NewClient(&mcp.Implementation{Name: "validated-stack-fixture", Version: "test"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect validated fixture client over stdio: %v; server stderr: %s", err, serverStderr.String())
	}
	t.Cleanup(func() {
		if err := session.Close(); err != nil {
			t.Errorf("close validated fixture session: %v; server stderr: %s", err, serverStderr.String())
		}
	})
	return fixtureClient{ctx: ctx, session: session}
}

func callValidatedTool(t *testing.T, client fixtureClient, fixture validatedDispatchFixture, name string, extra map[string]any) (*mcp.CallToolResult, Outcome) {
	t.Helper()
	arguments := map[string]any{"path": fixture.worktree, "remote": "origin"}
	for key, value := range extra {
		arguments[key] = value
	}
	result, err := client.session.CallTool(client.ctx, &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatalf("CallTool(%s) over validated stdio server: %v", name, err)
	}
	if result == nil {
		t.Fatalf("CallTool(%s) returned a nil result", name)
	}
	var outcome Outcome
	decodeStructuredContent(t, result.StructuredContent, &outcome)
	return result, outcome
}

func assertDispatchErrorOutcome(t *testing.T, operation, diagnostic string, result *mcp.CallToolResult, outcome Outcome, status OutcomeStatus, spawned bool) {
	t.Helper()
	if result == nil || !result.IsError {
		t.Fatalf("CallTool(%s) result = %+v, want isError=true", operation, result)
	}
	if outcome.Operation != operation || outcome.Status != status || outcome.Spawned != spawned {
		t.Fatalf("CallTool(%s) typed error outcome = %+v, want status %q and spawned=%t", operation, outcome, status, spawned)
	}
	if !strings.Contains(outcome.Stderr, diagnostic) {
		t.Errorf("CallTool(%s) typed diagnostic = %q, want %q", operation, outcome.Stderr, diagnostic)
	}
	if len(result.Content) == 0 {
		t.Fatalf("CallTool(%s) error envelope has no text content", operation)
	}
	text, ok := result.Content[0].(*mcp.TextContent)
	wantText := diagnostic
	if status != OutcomeRejected {
		wantText = operation + " exited with status 3"
	}
	if !ok || !strings.Contains(text.Text, wantText) {
		t.Errorf("CallTool(%s) error content = %#v, want %q", operation, result.Content[0], wantText)
	}
}

func readValidatedInvocations(t *testing.T, fixture validatedDispatchFixture) []string {
	t.Helper()
	data, err := os.ReadFile(fixture.invocations)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatalf("read fake extension argv log: %v", err)
	}
	text := strings.TrimSuffix(string(data), "\n")
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func waitForProcessGroupTermination(processGroupID int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		alive, err := processGroupAlive(processGroupID)
		if err == nil && !alive {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	alive, err := processGroupAlive(processGroupID)
	return err == nil && !alive
}

func withoutEnvironment(environment []string, names ...string) []string {
	removed := make(map[string]struct{}, len(names))
	for _, name := range names {
		removed[name] = struct{}{}
	}
	filtered := make([]string, 0, len(environment))
	for _, entry := range environment {
		name, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if _, skip := removed[name]; skip {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}
