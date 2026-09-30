package stackmcp

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const localViewFixture = `{
	"trunk": "main",
	"currentBranch": "feature-two",
	"branches": [
		{
			"name": "feature-one",
			"head": "1111111111111111111111111111111111111111",
			"base": "main",
			"isCurrent": false,
			"isMerged": true,
			"isQueued": false,
			"needsRebase": true,
			"pr": {
				"number": 41,
				"url": "https://github.com/owner/project/pull/41",
				"state": "MERGED"
			}
		},
		{
			"name": "feature-two",
			"isCurrent": true,
			"isMerged": false,
			"isQueued": true,
			"needsRebase": false,
			"pr": {
				"number": 42,
				"state": "OPEN"
			}
		},
		{
			"name": "feature-three",
			"head": "3333333333333333333333333333333333333333",
			"isCurrent": false,
			"isMerged": false,
			"isQueued": false,
			"needsRebase": false
		}
	]
}`

const canonicalLocalViewFixture = `{"trunk":"main","currentBranch":"feature-two","branches":[{"name":"feature-one","head":"1111111111111111111111111111111111111111","base":"main","isCurrent":false,"isMerged":true,"isQueued":false,"needsRebase":true,"pr":{"number":41,"url":"https://github.com/owner/project/pull/41","state":"MERGED"}},{"name":"feature-two","isCurrent":true,"isMerged":false,"isQueued":true,"needsRebase":false,"pr":{"number":42,"state":"OPEN"}},{"name":"feature-three","head":"3333333333333333333333333333333333333333","isCurrent":false,"isMerged":false,"isQueued":false,"needsRebase":false}]}`

func TestAdaptProcessResultReturnsCanonicalLocalView(t *testing.T) {
	target := newResultAdapterTarget(t)
	result := processResultWithExit(0, localViewFixture+"\n \t", "view diagnostic")

	outcome, err := AdaptProcessResult("stack_view", target, result, nil)
	if err != nil {
		t.Fatalf("AdaptProcessResult() error = %v", err)
	}
	if outcome.Status != OutcomeLocalObservation {
		t.Fatalf("outcome status = %q, want %q", outcome.Status, OutcomeLocalObservation)
	}
	if outcome.Stdout != canonicalLocalViewFixture {
		t.Errorf("canonical local view = %q, want %q", outcome.Stdout, canonicalLocalViewFixture)
	}
	if outcome.Stderr != "view diagnostic" {
		t.Errorf("stderr = %q, want preserved diagnostic", outcome.Stderr)
	}
	if outcome.Operation != "stack_view" || outcome.Repository != target.Repository {
		t.Errorf("operation/repository = %q/%q, want stack_view/%q", outcome.Operation, outcome.Repository, target.Repository)
	}
}

func TestAdaptProcessResultParsesViewWhenOnlyStderrWasTruncated(t *testing.T) {
	target := newResultAdapterTarget(t)
	result := processResultWithExit(0, localViewFixture, "bounded warning")
	result.Truncated = true
	result.StderrTruncated = true

	outcome, err := AdaptProcessResult("stack_view", target, result, nil)
	if err != nil {
		t.Fatalf("AdaptProcessResult() error = %v", err)
	}
	if outcome.Status != OutcomeLocalObservation || outcome.Stdout != canonicalLocalViewFixture {
		t.Errorf("truncated-stderr view outcome = %+v, want complete local observation", outcome)
	}
	if !outcome.Truncated {
		t.Error("outcome lost the stderr truncation indication")
	}
}

func TestAdaptProcessResultRejectsInvalidViewBranchRefs(t *testing.T) {
	target := newResultAdapterTarget(t)
	tests := []struct {
		name     string
		viewJSON string
	}{
		{
			name:     "invalid branches name",
			viewJSON: `{"trunk":"main","currentBranch":"main","branches":[{"name":"bad branch","isCurrent":true,"isMerged":false,"isQueued":false,"needsRebase":false}]}`,
		},
		{
			name:     "invalid trunk",
			viewJSON: `{"trunk":"bad branch","currentBranch":"main","branches":[]}`,
		},
		{
			name:     "invalid currentBranch",
			viewJSON: `{"trunk":"main","currentBranch":"bad branch","branches":[]}`,
		},
		{
			name:     "branch shorthand is not a ref",
			viewJSON: `{"trunk":"main","currentBranch":"main","branches":[{"name":"@{-1}","isCurrent":true,"isMerged":false,"isQueued":false,"needsRebase":false}]}`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result := processResultWithExit(0, test.viewJSON, "")
			outcome, err := AdaptProcessResult("stack_view", target, result, nil)
			if err == nil {
				t.Fatalf("AdaptProcessResult() error = nil, want invalid Git branch ref rejection; outcome = %+v", outcome)
			}
			if outcome.Status != OutcomeExitedUnverified {
				t.Errorf("invalid-ref view status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
			}
			if outcome.Stdout != test.viewJSON {
				t.Errorf("invalid-ref stdout = %q, want original JSON %q", outcome.Stdout, test.viewJSON)
			}
		})
	}
}

func TestAdaptProcessResultPreservesNumericOnlyLocalBranchRefs(t *testing.T) {
	target := newResultAdapterTarget(t)
	targetGit(t, target.Path, "config", "user.name", "Result Adapter Fixture")
	targetGit(t, target.Path, "config", "user.email", "result-adapter@example.invalid")
	targetGit(t, target.Path, "config", "commit.gpgsign", "false")
	targetGit(t, target.Path, "config", "core.hooksPath", "/dev/null")
	targetGit(t, target.Path, "commit", "--quiet", "--allow-empty", "-m", "initial")
	targetGit(t, target.Path, "branch", "trunk-fixture")
	targetGit(t, target.Path, "branch", "123")
	targetGit(t, target.Path, "checkout", "--quiet", "123")

	viewJSON := `{"trunk":"trunk-fixture","currentBranch":"123","branches":[{"name":"123","isCurrent":true,"isMerged":false,"isQueued":false,"needsRebase":false}]}`
	outcome, err := AdaptProcessResult("stack_view", target, processResultWithExit(0, viewJSON, ""), nil)
	if err != nil {
		t.Fatalf("AdaptProcessResult() rejected valid numeric-only local branch refs: %v", err)
	}
	if outcome.Status != OutcomeLocalObservation {
		t.Fatalf("numeric-only view status = %q, want %q", outcome.Status, OutcomeLocalObservation)
	}
	if outcome.Stdout != viewJSON {
		t.Errorf("numeric-only canonical view = %q, want %q", outcome.Stdout, viewJSON)
	}
}

func TestAdaptProcessResultDoesNotTreatIncompleteViewOutputAsAnObservation(t *testing.T) {
	target := newResultAdapterTarget(t)
	truncated := processResultWithExit(0, localViewFixture, "")
	truncated.Truncated = true
	truncated.StdoutTruncated = true

	legacyTruncated := processResultWithExit(0, localViewFixture, "")
	legacyTruncated.Truncated = true

	tests := []struct {
		name   string
		result ProcessResult
	}{
		{name: "truncated stdout", result: truncated},
		{name: "unspecified truncation stream", result: legacyTruncated},
		{name: "malformed JSON", result: processResultWithExit(0, "{", "")},
		{name: "trailing JSON value", result: processResultWithExit(0, localViewFixture+` {}`, "")},
		{name: "trailing non-JSON bytes", result: processResultWithExit(0, localViewFixture+" trailing", "")},
		{name: "missing required branch flags", result: processResultWithExit(0, `{"trunk":"main","currentBranch":"main","branches":[{"name":"feature-one"}]}`, "")},
		{name: "empty trunk", result: processResultWithExit(0, `{"trunk":"","currentBranch":"main","branches":[]}`, "")},
		{name: "empty currentBranch", result: processResultWithExit(0, `{"trunk":"main","currentBranch":"","branches":[]}`, "")},
		{name: "unknown field", result: processResultWithExit(0, `{"trunk":"main","currentBranch":"main","branches":[],"remoteStack":42}`, "")},
		{name: "null instead of view object", result: processResultWithExit(0, "null", "")},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			outcome, err := AdaptProcessResult("stack_view", target, test.result, nil)
			if err == nil {
				t.Fatal("AdaptProcessResult() error = nil, want incomplete-view error")
			}
			if outcome.Status == OutcomeLocalObservation {
				t.Fatalf("incomplete view was returned as a local observation: %+v", outcome)
			}
			if outcome.Spawned && outcome.Status != OutcomeExitedUnverified {
				t.Errorf("spawned incomplete view status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
			}
		})
	}
}

func TestAdaptProcessResultDoesNotInventAViewForNoLocalStack(t *testing.T) {
	result := processResultWithExit(1, "", "no local Stack is tracked in this worktree")

	outcome, err := AdaptProcessResult("stack_view", Target{Repository: "github.com/owner/project"}, result, nil)
	if err == nil {
		t.Fatal("AdaptProcessResult() error = nil, want the nonzero CLI result as an MCP error")
	}
	if outcome.Status != OutcomeExitedUnverified {
		t.Errorf("no-local-Stack status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
	}
	if outcome.Stdout != "" || outcome.Stderr != "no local Stack is tracked in this worktree" {
		t.Errorf("no-local-Stack output = stdout %q, stderr %q", outcome.Stdout, outcome.Stderr)
	}
	if outcome.ExitCode == nil || *outcome.ExitCode != 1 {
		t.Errorf("no-local-Stack exit code = %v, want 1", outcome.ExitCode)
	}
}

func TestAdaptProcessResultRequiresSpawnAndZeroExitForAView(t *testing.T) {
	failed := processResultWithExit(5, localViewFixture, "view failed")
	noSpawn := processResultWithExit(0, localViewFixture, "")
	noSpawn.Spawned = false

	tests := []struct {
		name       string
		result     ProcessResult
		processErr error
		wantStatus OutcomeStatus
	}{
		{name: "nonzero exit", result: failed, wantStatus: OutcomeExitedUnverified},
		{name: "not spawned", result: noSpawn, processErr: errors.New("launch rejected"), wantStatus: OutcomeRejected},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			outcome, err := AdaptProcessResult("stack_view", Target{}, test.result, test.processErr)
			if err == nil {
				t.Fatal("AdaptProcessResult() error = nil, want an unavailable view result")
			}
			if outcome.Status != test.wantStatus {
				t.Errorf("status = %q, want %q", outcome.Status, test.wantStatus)
			}
			if outcome.Status == OutcomeLocalObservation {
				t.Errorf("view was parsed despite spawn/exit requirements: %+v", outcome)
			}
		})
	}
}

func TestAdaptProcessResultPreservesSpawnedWriteEnvelopeAndReturnsError(t *testing.T) {
	target := Target{Repository: "github.com/owner/project"}
	result := processResultWithExit(7, "partial stdout", "partial stderr")
	result.Truncated = true
	result.StdoutTruncated = true

	outcome, err := AdaptProcessResult("stack_push", target, result, nil)
	if err == nil {
		t.Fatal("AdaptProcessResult() error = nil, want nonzero spawned write error")
	}
	if outcome.Operation != "stack_push" || outcome.Repository != target.Repository || !outcome.Spawned {
		t.Errorf("write envelope identity = %+v", outcome)
	}
	if outcome.ExitCode == nil || *outcome.ExitCode != 7 {
		t.Errorf("write exit code = %v, want 7", outcome.ExitCode)
	}
	if outcome.Status != OutcomeExitedUnverified {
		t.Errorf("write status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
	}
	if outcome.Stdout != "partial stdout" || outcome.Stderr != "partial stderr" || !outcome.Truncated {
		t.Errorf("write output/truncation envelope = stdout %q, stderr %q, truncated %t", outcome.Stdout, outcome.Stderr, outcome.Truncated)
	}
}

func TestAdaptProcessResultKeepsEveryExitZeroMutationUnverified(t *testing.T) {
	tests := []struct {
		operation string
		stdout    string
	}{
		{operation: "stack_init", stdout: "Initialized successfully"},
		{operation: "stack_add", stdout: "Added branch"},
		{operation: "stack_checkout", stdout: "Checked out branch"},
		{operation: "stack_rebase", stdout: "Rebased successfully"},
		{operation: "stack_sync", stdout: "No updates to synchronize"},
		{operation: "stack_push", stdout: "Published all branches"},
		{operation: "stack_submit", stdout: "Published branch one; branch two was skipped after sequential submission"},
		{operation: "stack_link", stdout: "Linked branch one; branch two base update was incomplete"},
		{operation: "stack_unstack", stdout: "Removed one member; a locked member remains grouped"},
	}

	for _, test := range tests {
		t.Run(test.operation, func(t *testing.T) {
			result := processResultWithExit(0, test.stdout, "")
			outcome, err := AdaptProcessResult(test.operation, Target{}, result, nil)
			if err != nil {
				t.Fatalf("AdaptProcessResult() error = %v", err)
			}
			if outcome.Status != OutcomeExitedUnverified {
				t.Errorf("exit-zero mutation status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
			}
			if outcome.Stdout != test.stdout {
				t.Errorf("mutation stdout = %q, want unchanged output %q", outcome.Stdout, test.stdout)
			}
		})
	}
}

func TestAdaptProcessResultUncertaintyPrecedesNormalClassification(t *testing.T) {
	viewTimedOut := processResultWithExit(0, localViewFixture, "")
	viewTimedOut.TimedOut = true

	writeCanceled := processResultWithExit(0, "write completed", "")
	writeCanceled.Canceled = true

	writeCleanupUnknown := processResultWithExit(3, "rebase conflict", "")
	writeCleanupUnknown.CleanupUnknown = true
	writeCleanupUnknown.TimedOut = true

	tests := []struct {
		name       string
		operation  string
		result     ProcessResult
		processErr error
		wantStatus OutcomeStatus
	}{
		{name: "timed out view", operation: "stack_view", result: viewTimedOut, processErr: errors.New("deadline exceeded"), wantStatus: OutcomeTimedOutUnknown},
		{name: "canceled write", operation: "stack_push", result: writeCanceled, processErr: errors.New("interrupted"), wantStatus: OutcomeTimedOutUnknown},
		{name: "cleanup uncertainty before timeout", operation: "stack_rebase", result: writeCleanupUnknown, processErr: errors.New("cleanup uncertain"), wantStatus: OutcomeCleanupUnknown},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			outcome, err := AdaptProcessResult(test.operation, Target{}, test.result, test.processErr)
			if err == nil {
				t.Fatal("AdaptProcessResult() error = nil, want uncertain execution error")
			}
			if outcome.Status != test.wantStatus {
				t.Errorf("uncertain result status = %q, want %q", outcome.Status, test.wantStatus)
			}
			if outcome.Status == OutcomeLocalObservation || outcome.Status == OutcomeConflictPending {
				t.Errorf("uncertain execution was classified as a normal result: %+v", outcome)
			}
		})
	}
}

func TestAdaptProcessResultReturnsRejectedOutcomeBeforeLaunch(t *testing.T) {
	target := Target{Repository: "github.com/owner/project"}
	rejection := errors.New("selected worktree failed validation")

	outcome, err := AdaptProcessResult("stack_sync", target, ProcessResult{}, rejection)
	if !errors.Is(err, rejection) {
		t.Fatalf("AdaptProcessResult() error = %v, want original rejection %v", err, rejection)
	}
	if outcome.Status != OutcomeRejected || outcome.Spawned || outcome.ExitCode != nil {
		t.Errorf("before-launch outcome = %+v, want rejected and unspawned", outcome)
	}
	if outcome.Stderr != rejection.Error() {
		t.Errorf("rejection diagnostic = %q, want %q", outcome.Stderr, rejection.Error())
	}
}

func TestAdaptProcessResultClassifiesOnlyVerifiedRebaseConflicts(t *testing.T) {
	tests := []struct {
		name      string
		operation string
		exitCode  int
		setup     func(t *testing.T, target Target, trunk, commit string)
		want      OutcomeStatus
	}{
		{
			name:      "valid marker and active matching rebase",
			operation: "stack_rebase",
			exitCode:  3,
			setup: func(t *testing.T, target Target, trunk, commit string) {
				writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
			},
			want: OutcomeConflictPending,
		},
		{
			name:      "missing marker",
			operation: "stack_rebase",
			exitCode:  3,
			want:      OutcomeExitedUnverified,
		},
		{
			name:      "stale active rebase branch",
			operation: "stack_rebase",
			exitCode:  3,
			setup: func(t *testing.T, target Target, trunk, commit string) {
				writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
				writeTargetStateBytes(t, filepath.Join(target.GitDir, "rebase-merge", "head-name"), []byte("refs/heads/feature-one\n"))
			},
			want: OutcomeExitedUnverified,
		},
		{
			name:      "marker without active Git rebase",
			operation: "stack_rebase",
			exitCode:  3,
			setup: func(t *testing.T, target Target, trunk, commit string) {
				writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
				if err := os.RemoveAll(filepath.Join(target.GitDir, "rebase-merge")); err != nil {
					t.Fatalf("remove active rebase fixture: %v", err)
				}
				if err := os.Remove(filepath.Join(target.GitDir, "REBASE_HEAD")); err != nil {
					t.Fatalf("remove active REBASE_HEAD fixture: %v", err)
				}
			},
			want: OutcomeExitedUnverified,
		},
		{
			name:      "same exit code from a different operation",
			operation: "stack_sync",
			exitCode:  3,
			setup: func(t *testing.T, target Target, trunk, commit string) {
				writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
			},
			want: OutcomeExitedUnverified,
		},
		{
			name:      "different rebase exit code",
			operation: "stack_rebase",
			exitCode:  2,
			setup: func(t *testing.T, target Target, trunk, commit string) {
				writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
			},
			want: OutcomeExitedUnverified,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			target, trunk, commit := newTargetRecoveryFixture(t)
			if test.setup != nil {
				test.setup(t, target, trunk, commit)
			}
			result := processResultWithExit(test.exitCode, "conflict reported by the CLI", "rebase diagnostic")

			outcome, err := AdaptProcessResult(test.operation, target, result, nil)
			if err == nil {
				t.Fatal("AdaptProcessResult() error = nil, want the nonzero rebase/CLI result")
			}
			if outcome.Status != test.want {
				t.Errorf("conflict outcome status = %q, want %q", outcome.Status, test.want)
			}
			if outcome.Stdout != "conflict reported by the CLI" || outcome.Stderr != "rebase diagnostic" {
				t.Errorf("conflict result did not preserve captured output: %+v", outcome)
			}
		})
	}
}

func TestAdaptProcessResultUsesExitAndRecoveryStateInsteadOfConflictText(t *testing.T) {
	target, trunk, commit := newTargetRecoveryFixture(t)
	writeValidRecoveryFixture(t, target, trunk, commit, 1, "feature-two", "feature-three")
	result := processResultWithExit(0, "CONFLICT: success-looking text", "")

	outcome, err := AdaptProcessResult("stack_rebase", target, result, nil)
	if err != nil {
		t.Fatalf("AdaptProcessResult() error = %v", err)
	}
	if outcome.Status != OutcomeExitedUnverified {
		t.Errorf("success exit with conflict-looking text status = %q, want %q", outcome.Status, OutcomeExitedUnverified)
	}
}

func processResultWithExit(exitCode int, stdout, stderr string) ProcessResult {
	return ProcessResult{
		Spawned:  true,
		ExitCode: &exitCode,
		Stdout:   []byte(stdout),
		Stderr:   []byte(stderr),
	}
}

func newResultAdapterTarget(t *testing.T) Target {
	t.Helper()
	return Target{
		Path:       newTargetRepository(t),
		Repository: "github.com/owner/project",
	}
}
