package stackmcp

import (
	"os"
	"slices"
	"testing"
)

func TestBuildCommandUsesFixedArgumentVectors(t *testing.T) {
	target := newCommandTarget(t)
	message := "  preserve leading/trailing bytes \nsecond line  "
	cases := []struct {
		name  string
		input any
		want  []string
	}{
		{
			name:  "view requests JSON only",
			input: ViewInput{Path: target.Path, Remote: target.Remote},
			want:  []string{"view", "--json"},
		},
		{
			name: "init preserves ordered branches",
			input: InitInput{
				Path:     target.Path,
				Remote:   target.Remote,
				Trunk:    "main",
				Branches: []string{"feature/z", "feature/a"},
			},
			want: []string{"init", "--base", "main", "feature/z", "feature/a"},
		},
		{
			name: "init accepts dotted branch component",
			input: InitInput{
				Path: target.Path, Remote: target.Remote, Trunk: "main", Branches: []string{"release.v1/feature"},
			},
			want: []string{"init", "--base", "main", "release.v1/feature"},
		},
		{
			name:  "add branch with default stage",
			input: AddInput{Path: target.Path, Remote: target.Remote, Branch: "feature/branch"},
			want:  []string{"add", "feature/branch"},
		},
		{
			name:  "add accepts dotted branch component",
			input: AddInput{Path: target.Path, Remote: target.Remote, Branch: "release.v1/feature", Stage: StageNone},
			want:  []string{"add", "release.v1/feature"},
		},
		{
			name:  "add branch with explicit none stage",
			input: AddInput{Path: target.Path, Remote: target.Remote, Branch: "feature/branch", Stage: StageNone},
			want:  []string{"add", "feature/branch"},
		},
		{
			name: "add staged index message and generated branch",
			input: AddInput{
				Path: target.Path, Remote: target.Remote, Stage: StageIndex, Message: message,
			},
			want: []string{"add", "-m", message},
		},
		{
			name: "add staged index message and explicit branch",
			input: AddInput{
				Path: target.Path, Remote: target.Remote, Branch: "feature/index", Stage: StageIndex, Message: message,
			},
			want: []string{"add", "-m", message, "feature/index"},
		},
		{
			name: "add tracked changes and generated branch",
			input: AddInput{
				Path: target.Path, Remote: target.Remote, Stage: StageTracked, Message: "tracked changes",
			},
			want: []string{"add", "-u", "-m", "tracked changes"},
		},
		{
			name: "add tracked changes and explicit branch",
			input: AddInput{
				Path: target.Path, Remote: target.Remote, Branch: "feature/tracked", Stage: StageTracked, Message: "tracked changes",
			},
			want: []string{"add", "-u", "-m", "tracked changes", "feature/tracked"},
		},
		{
			name: "add all changes and generated branch",
			input: AddInput{
				Path: target.Path, Remote: target.Remote, Stage: StageAll, Message: "all changes",
			},
			want: []string{"add", "-A", "-m", "all changes"},
		},
		{
			name: "add all changes and explicit branch",
			input: AddInput{
				Path: target.Path, Remote: target.Remote, Branch: "feature/all", Stage: StageAll, Message: "all changes",
			},
			want: []string{"add", "-A", "-m", "all changes", "feature/all"},
		},
		{
			name:  "checkout explicit branch",
			input: CheckoutInput{Path: target.Path, Remote: target.Remote, Branch: "feature/checkout"},
			want:  []string{"checkout", "feature/checkout"},
		},
		{
			name:  "checkout accepts dotted branch component",
			input: CheckoutInput{Path: target.Path, Remote: target.Remote, Branch: "release.v1/feature"},
			want:  []string{"checkout", "release.v1/feature"},
		},
		{
			name: "rebase full Stack scope",
			input: RebaseInput{
				Path: target.Path, Remote: target.Remote, Action: RebaseStart, Scope: RebaseFull,
			},
			want: []string{"rebase", "--remote", target.Remote},
		},
		{
			name: "rebase upstack scope",
			input: RebaseInput{
				Path: target.Path, Remote: target.Remote, Action: RebaseStart, Scope: RebaseUpstack,
			},
			want: []string{"rebase", "--remote", target.Remote, "--upstack"},
		},
		{
			name: "rebase downstack scope",
			input: RebaseInput{
				Path: target.Path, Remote: target.Remote, Action: RebaseStart, Scope: RebaseDownstack,
			},
			want: []string{"rebase", "--remote", target.Remote, "--downstack"},
		},
		{
			name: "rebase without trunk scope",
			input: RebaseInput{
				Path: target.Path, Remote: target.Remote, Action: RebaseStart, Scope: RebaseNoTrunk,
			},
			want: []string{"rebase", "--remote", target.Remote, "--no-trunk"},
		},
		{
			name:  "rebase continue uses only the guarded continuation flag",
			input: RebaseInput{Path: target.Path, Remote: target.Remote, Action: RebaseContinue},
			want:  []string{"rebase", "--continue"},
		},
		{
			name:  "sync defaults to no prune",
			input: SyncInput{Path: target.Path, Remote: target.Remote},
			want:  []string{"sync", "--remote", target.Remote},
		},
		{
			name:  "sync explicitly opts in to prune",
			input: SyncInput{Path: target.Path, Remote: target.Remote, Prune: true},
			want:  []string{"sync", "--remote", target.Remote, "--prune"},
		},
		{
			name:  "push uses the validated remote",
			input: PushInput{Path: target.Path, Remote: target.Remote},
			want:  []string{"push", "--remote", target.Remote},
		},
		{
			name:  "submit defaults to noninteractive without opening pull requests",
			input: SubmitInput{Path: target.Path, Remote: target.Remote},
			want:  []string{"submit", "--auto", "--remote", target.Remote},
		},
		{
			name:  "submit opts in to opening pull requests",
			input: SubmitInput{Path: target.Path, Remote: target.Remote, Open: true},
			want:  []string{"submit", "--auto", "--remote", target.Remote, "--open"},
		},
		{
			name: "link preserves bottom-to-top branch order",
			input: LinkInput{
				Path: target.Path, Remote: target.Remote,
				Branches: []string{"feature/bottom", "feature/middle", "feature/top"},
			},
			want: []string{"link", "--remote", target.Remote, "feature/bottom", "feature/middle", "feature/top"},
		},
		{
			name: "link accepts an explicit base",
			input: LinkInput{
				Path: target.Path, Remote: target.Remote, Branches: []string{"feature/bottom", "feature/top"}, Base: "main",
			},
			want: []string{"link", "--remote", target.Remote, "--base", "main", "feature/bottom", "feature/top"},
		},
		{
			name: "link opts in to opening pull requests",
			input: LinkInput{
				Path: target.Path, Remote: target.Remote, Branches: []string{"feature/bottom", "feature/top"}, Open: true,
			},
			want: []string{"link", "--remote", target.Remote, "--open", "feature/bottom", "feature/top"},
		},
		{
			name: "link orders base and open options before ordered branches",
			input: LinkInput{
				Path: target.Path, Remote: target.Remote, Branches: []string{"feature/bottom", "feature/top"}, Base: "main", Open: true,
			},
			want: []string{"link", "--remote", target.Remote, "--base", "main", "--open", "feature/bottom", "feature/top"},
		},
		{
			name: "unstack removes the numbered remote and local grouping",
			input: UnstackInput{
				Path: target.Path, Remote: target.Remote, StackNumber: 42, Mode: UnstackRemoteAndLocal,
			},
			want: []string{"unstack", "42"},
		},
		{
			name: "unstack local-only keeps remote grouping unchanged",
			input: UnstackInput{
				Path: target.Path, Remote: target.Remote, StackNumber: 42, Mode: UnstackLocalOnly,
			},
			want: []string{"unstack", "42", "--local"},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := BuildCommand(testCase.input, target)
			if err != nil {
				t.Fatalf("BuildCommand(%T): %v", testCase.input, err)
			}
			if !slices.Equal(got.Args, testCase.want) {
				t.Errorf("arguments = %#v, want exactly %#v", got.Args, testCase.want)
			}
		})
	}
}

func TestBuildCommandRejectsImplicitOrMismatchedRemote(t *testing.T) {
	target := newCommandTarget(t)
	operations := []struct {
		name  string
		build func(string) any
	}{
		{
			name: "rebase",
			build: func(remote string) any {
				return RebaseInput{
					Path: target.Path, Remote: remote, Action: RebaseStart, Scope: RebaseFull,
				}
			},
		},
		{
			name: "sync",
			build: func(remote string) any {
				return SyncInput{Path: target.Path, Remote: remote}
			},
		},
		{
			name: "push",
			build: func(remote string) any {
				return PushInput{Path: target.Path, Remote: remote}
			},
		},
		{
			name: "submit",
			build: func(remote string) any {
				return SubmitInput{Path: target.Path, Remote: remote}
			},
		},
		{
			name: "link",
			build: func(remote string) any {
				return LinkInput{Path: target.Path, Remote: remote, Branches: []string{"feature/bottom", "feature/top"}}
			},
		},
		{
			name: "unstack",
			build: func(remote string) any {
				return UnstackInput{
					Path: target.Path, Remote: remote, StackNumber: 42, Mode: UnstackRemoteAndLocal,
				}
			},
		},
	}
	remoteCases := []struct {
		name          string
		requestRemote string
		targetRemote  string
	}{
		{name: "missing request remote", requestRemote: "", targetRemote: target.Remote},
		{name: "mismatched request remote", requestRemote: "other", targetRemote: target.Remote},
		{name: "missing validated target remote", requestRemote: target.Remote, targetRemote: ""},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			for _, remoteCase := range remoteCases {
				t.Run(remoteCase.name, func(t *testing.T) {
					commandTarget := target
					commandTarget.Remote = remoteCase.targetRemote
					if _, err := BuildCommand(operation.build(remoteCase.requestRemote), commandTarget); err == nil {
						t.Fatalf("BuildCommand accepted request remote %q with validated target remote %q", remoteCase.requestRemote, commandTarget.Remote)
					}
				})
			}
		})
	}
}

func TestBuildCommandRejectsInvalidRebaseInputs(t *testing.T) {
	target := newCommandTarget(t)
	base := RebaseInput{Path: target.Path, Remote: target.Remote}
	cases := []struct {
		name  string
		input RebaseInput
	}{
		{name: "missing action", input: base},
		{name: "abort is not exposed", input: RebaseInput{Path: target.Path, Remote: target.Remote, Action: RebaseAction("abort"), Scope: RebaseFull}},
		{name: "unknown action", input: RebaseInput{Path: target.Path, Remote: target.Remote, Action: RebaseAction("force"), Scope: RebaseFull}},
		{name: "start requires explicit scope", input: RebaseInput{Path: target.Path, Remote: target.Remote, Action: RebaseStart}},
		{name: "start rejects unknown scope", input: RebaseInput{Path: target.Path, Remote: target.Remote, Action: RebaseStart, Scope: RebaseScope("current")}},
		{name: "continue rejects scope", input: RebaseInput{Path: target.Path, Remote: target.Remote, Action: RebaseContinue, Scope: RebaseFull}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := BuildCommand(testCase.input, target); err == nil {
				t.Fatalf("BuildCommand accepted invalid rebase input %#v", testCase.input)
			}
		})
	}
}

func TestBuildCommandRejectsInvalidBranchTargets(t *testing.T) {
	target := newCommandTarget(t)
	invalidTargets := []struct {
		name   string
		branch string
	}{
		{name: "empty", branch: ""},
		{name: "numeric only", branch: "482"},
		{name: "pull request URL", branch: "https://github.com/owner/repository/pull/482"},
		{name: "other URL", branch: "ssh://git@github.com/owner/repository.git"},
		{name: "protocol-relative URL", branch: "//github.com/owner/repository/pull/482"},
		{name: "host-style URL", branch: "github.com/owner/repository/pull/482"},
		{name: "host-style pull request patch URL", branch: "github.com/owner/repository/pull/482.patch"},
		{name: "host-style pull request diff URL", branch: "github.com/owner/repository/pull/482.diff"},
		{name: "flag-like", branch: "--force"},
		{name: "invalid Git ref", branch: "feature..name"},
		{name: "space in branch", branch: "feature name"},
		{name: "NUL in branch", branch: "feature\x00name"},
	}
	operations := []struct {
		name  string
		build func(string) any
	}{
		{
			name: "init trunk",
			build: func(branch string) any {
				return InitInput{Path: target.Path, Remote: target.Remote, Trunk: branch, Branches: []string{"feature/valid"}}
			},
		},
		{
			name: "init branch",
			build: func(branch string) any {
				return InitInput{Path: target.Path, Remote: target.Remote, Trunk: "main", Branches: []string{branch}}
			},
		},
		{
			name: "add branch",
			build: func(branch string) any {
				return AddInput{Path: target.Path, Remote: target.Remote, Branch: branch, Stage: StageNone}
			},
		},
		{
			name: "checkout branch",
			build: func(branch string) any {
				return CheckoutInput{Path: target.Path, Remote: target.Remote, Branch: branch}
			},
		},
		{
			name: "link branch",
			build: func(branch string) any {
				return LinkInput{
					Path: target.Path, Remote: target.Remote, Branches: []string{branch, "feature/valid"},
				}
			},
		},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			for _, invalid := range invalidTargets {
				t.Run(invalid.name, func(t *testing.T) {
					if _, err := BuildCommand(operation.build(invalid.branch), target); err == nil {
						t.Fatalf("BuildCommand accepted invalid branch target %q", invalid.name)
					}
				})
			}
		})
	}
}

func TestBuildCommandRejectsInvalidLinkBase(t *testing.T) {
	target := newCommandTarget(t)
	invalidBases := []struct {
		name string
		base string
	}{
		{name: "numeric only", base: "482"},
		{name: "pull request URL", base: "https://github.com/owner/repository/pull/482"},
		{name: "other URL", base: "ssh://git@github.com/owner/repository.git"},
		{name: "protocol-relative URL", base: "//github.com/owner/repository/pull/482"},
		{name: "host-style URL", base: "github.com/owner/repository/pull/482"},
		{name: "flag-like", base: "--force"},
		{name: "invalid Git ref", base: "feature..name"},
		{name: "space in branch", base: "feature base"},
		{name: "whitespace-only", base: " \t\n"},
		{name: "NUL in branch", base: "feature\x00name"},
	}

	for _, invalid := range invalidBases {
		t.Run(invalid.name, func(t *testing.T) {
			input := LinkInput{
				Path: target.Path, Remote: target.Remote,
				Branches: []string{"feature/bottom", "feature/top"}, Base: invalid.base,
			}
			if _, err := BuildCommand(input, target); err == nil {
				t.Fatalf("BuildCommand accepted invalid link base %q", invalid.base)
			}
		})
	}
}

func TestBuildCommandRejectsInvalidLinkBranchCounts(t *testing.T) {
	target := newCommandTarget(t)
	cases := []struct {
		name     string
		branches []string
	}{
		{name: "missing branches"},
		{name: "empty branches", branches: []string{}},
		{name: "one branch", branches: []string{"feature/only"}},
		{name: "empty branch among two", branches: []string{"feature/bottom", ""}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			input := LinkInput{Path: target.Path, Remote: target.Remote, Branches: testCase.branches}
			if _, err := BuildCommand(input, target); err == nil {
				t.Fatalf("BuildCommand accepted link branch list %#v", testCase.branches)
			}
		})
	}
}

func TestBuildCommandRejectsInvalidUnstackInputs(t *testing.T) {
	target := newCommandTarget(t)
	cases := []struct {
		name  string
		input UnstackInput
	}{
		{
			name: "remote and local mode requires a positive Stack number",
			input: UnstackInput{
				Path: target.Path, Remote: target.Remote, StackNumber: 0, Mode: UnstackRemoteAndLocal,
			},
		},
		{
			name: "local-only mode requires a positive Stack number",
			input: UnstackInput{
				Path: target.Path, Remote: target.Remote, StackNumber: -1, Mode: UnstackLocalOnly,
			},
		},
		{
			name:  "mode is required",
			input: UnstackInput{Path: target.Path, Remote: target.Remote, StackNumber: 42},
		},
		{
			name: "merge is not an unstack mode",
			input: UnstackInput{
				Path: target.Path, Remote: target.Remote, StackNumber: 42, Mode: UnstackMode("merge"),
			},
		},
		{
			name: "unknown cleanup mode is not exposed",
			input: UnstackInput{
				Path: target.Path, Remote: target.Remote, StackNumber: 42, Mode: UnstackMode("cleanup"),
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := BuildCommand(testCase.input, target); err == nil {
				t.Fatalf("BuildCommand accepted invalid unstack input %#v", testCase.input)
			}
		})
	}
}

func TestBuildCommandRejectsMalformedOperationInputs(t *testing.T) {
	target := newCommandTarget(t)
	cases := []struct {
		name  string
		input any
	}{
		{name: "init missing trunk", input: InitInput{Branches: []string{"feature/a"}}},
		{name: "init missing branches", input: InitInput{Trunk: "main"}},
		{name: "init empty branches", input: InitInput{Trunk: "main", Branches: []string{}}},
		{name: "init empty branch element", input: InitInput{Trunk: "main", Branches: []string{"feature/a", ""}}},
		{name: "add missing branch or commit mode", input: AddInput{}},
		{name: "add none stage without branch", input: AddInput{Stage: StageNone}},
		{name: "add index stage without message", input: AddInput{Branch: "feature/a", Stage: StageIndex}},
		{name: "add tracked stage without message", input: AddInput{Branch: "feature/a", Stage: StageTracked}},
		{name: "add all stage without message", input: AddInput{Branch: "feature/a", Stage: StageAll}},
		{name: "add none stage with message", input: AddInput{Branch: "feature/a", Stage: StageNone, Message: "commit"}},
		{name: "add unknown stage", input: AddInput{Branch: "feature/a", Stage: StageMode("force")}},
		{name: "add empty message", input: AddInput{Stage: StageIndex, Message: ""}},
		{name: "add whitespace-only message", input: AddInput{Stage: StageIndex, Message: " \t\n"}},
		{name: "add NUL message", input: AddInput{Stage: StageIndex, Message: "message\x00body"}},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := BuildCommand(testCase.input, target); err == nil {
				t.Fatalf("BuildCommand(%T) accepted malformed input", testCase.input)
			}
		})
	}
}

func TestBuildCommandRejectsGenericCommandPassthrough(t *testing.T) {
	target := newCommandTarget(t)
	inputs := []struct {
		name  string
		input any
	}{
		{name: "string command", input: "view --json"},
		{name: "raw argv", input: []string{"--help", "--force"}},
		{name: "command field", input: struct{ Command string }{Command: "rm -rf"}},
		{name: "pointer to typed input", input: &ViewInput{Path: target.Path, Remote: target.Remote}},
		{name: "nil", input: nil},
	}

	for _, testCase := range inputs {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := BuildCommand(testCase.input, target); err == nil {
				t.Fatalf("BuildCommand(%T) accepted a non-value request", testCase.input)
			}
		})
	}
}

func TestBuildCommandUsesAbsoluteTargetWithoutChangingProcessDirectory(t *testing.T) {
	target := newCommandTarget(t)
	workingDirectoryBefore, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory before mapping: %v", err)
	}

	if _, err := BuildCommand(CheckoutInput{Branch: "feature/checkout"}, target); err != nil {
		t.Fatalf("BuildCommand(checkout): %v", err)
	}

	workingDirectoryAfter, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory after mapping: %v", err)
	}
	if workingDirectoryAfter != workingDirectoryBefore {
		t.Errorf("command mapping changed process directory from %q to %q", workingDirectoryBefore, workingDirectoryAfter)
	}
}

func TestBuildCommandRejectsRelativeTargetForBranchValidation(t *testing.T) {
	if _, err := BuildCommand(CheckoutInput{Branch: "feature/checkout"}, Target{Path: "."}); err == nil {
		t.Fatal("BuildCommand accepted a relative target path for local branch validation")
	}
}

func newCommandTarget(t *testing.T) Target {
	t.Helper()
	worktree := newTargetRepository(t)
	addTargetRemote(t, worktree, "selected", "https://github.com/owner/repository.git", "")
	target, err := ValidateTarget(worktree, "selected")
	if err != nil {
		t.Fatalf("validate command target: %v", err)
	}
	return target
}
