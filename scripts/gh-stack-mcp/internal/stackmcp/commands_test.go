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
