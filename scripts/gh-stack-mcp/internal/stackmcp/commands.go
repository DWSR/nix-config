package stackmcp

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

// CommandSpec contains only arguments for the fixed gh-stack executable.
type CommandSpec struct {
	Args []string
}

func BuildCommand(typedInput any, target Target) (CommandSpec, error) {
	switch input := typedInput.(type) {
	case ViewInput:
		return CommandSpec{Args: []string{"view", "--json"}}, nil
	case InitInput:
		return buildInitCommand(input, target)
	case AddInput:
		return buildAddCommand(input, target)
	case CheckoutInput:
		if err := validateCommandBranch(target, "checkout", input.Branch); err != nil {
			return CommandSpec{}, err
		}
		return CommandSpec{Args: []string{"checkout", input.Branch}}, nil
	default:
		return CommandSpec{}, fmt.Errorf("unsupported Stack command input type %T", typedInput)
	}
}

func buildInitCommand(input InitInput, target Target) (CommandSpec, error) {
	if err := validateCommandBranch(target, "init trunk", input.Trunk); err != nil {
		return CommandSpec{}, err
	}
	if len(input.Branches) == 0 {
		return CommandSpec{}, fmt.Errorf("init requires at least one branch")
	}

	args := make([]string, 0, 3+len(input.Branches))
	args = append(args, "init", "--base", input.Trunk)
	for _, branch := range input.Branches {
		if err := validateCommandBranch(target, "init branch", branch); err != nil {
			return CommandSpec{}, err
		}
		args = append(args, branch)
	}
	return CommandSpec{Args: args}, nil
}

func buildAddCommand(input AddInput, target Target) (CommandSpec, error) {
	stage := input.Stage
	if stage == "" {
		stage = StageNone
	}

	if input.Branch != "" {
		if err := validateCommandBranch(target, "add branch", input.Branch); err != nil {
			return CommandSpec{}, err
		}
	}

	if strings.IndexByte(input.Message, 0) >= 0 {
		return CommandSpec{}, fmt.Errorf("add message cannot contain a NUL byte")
	}

	var args []string
	switch stage {
	case StageNone:
		if input.Message != "" {
			return CommandSpec{}, fmt.Errorf("add message requires stage mode index, tracked, or all")
		}
		if input.Branch == "" {
			return CommandSpec{}, fmt.Errorf("add requires a branch or an explicit commit mode")
		}
		args = []string{"add", input.Branch}
	case StageIndex, StageTracked, StageAll:
		if strings.TrimSpace(input.Message) == "" {
			return CommandSpec{}, fmt.Errorf("add stage mode %q requires a nonblank commit message", stage)
		}
		args = []string{"add"}
		switch stage {
		case StageTracked:
			args = append(args, "-u")
		case StageAll:
			args = append(args, "-A")
		}
		args = append(args, "-m", input.Message)
		if input.Branch != "" {
			args = append(args, input.Branch)
		}
	default:
		return CommandSpec{}, fmt.Errorf("unsupported add stage mode %q", stage)
	}

	return CommandSpec{Args: args}, nil
}

func validateCommandBranch(target Target, description, branch string) error {
	if branch == "" || strings.TrimSpace(branch) == "" {
		return fmt.Errorf("%s requires a branch name", description)
	}
	if strings.HasPrefix(branch, "-") {
		return fmt.Errorf("%s cannot be a flag-like value", description)
	}
	if isNumericCommandBranch(branch) {
		return fmt.Errorf("%s must be a nonnumeric Git branch name", description)
	}
	if isURLCommandBranch(branch) {
		return fmt.Errorf("%s cannot be a URL", description)
	}
	if strings.Contains(branch, "@{-") {
		return fmt.Errorf("%s must be an explicit Git branch name", description)
	}
	if target.Path == "" || !filepath.IsAbs(target.Path) {
		return fmt.Errorf("%s requires a validated absolute worktree path", description)
	}
	if _, err := runTargetGit(target.Path, "validate "+description+" branch", "check-ref-format", "--branch", branch); err != nil {
		return fmt.Errorf("%s must be a valid Git branch name: %w", description, err)
	}
	return nil
}

func isNumericCommandBranch(branch string) bool {
	if branch == "" {
		return false
	}
	for _, character := range branch {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func isURLCommandBranch(branch string) bool {
	if strings.HasPrefix(branch, "//") || strings.Contains(branch, "://") {
		return true
	}
	parsed, err := url.Parse(branch)
	if err == nil && parsed.Scheme != "" {
		return true
	}
	return isGitHubPullRequestURL(branch)
}

func isGitHubPullRequestURL(branch string) bool {
	parsed, err := url.Parse("//" + branch)
	if err != nil || !strings.EqualFold(parsed.Hostname(), "github.com") {
		return false
	}
	path := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(path) < 4 || path[0] == "" || path[1] == "" || !strings.EqualFold(path[2], "pull") {
		return false
	}
	pullRequestNumber := path[3]
	lowerPullRequestNumber := strings.ToLower(pullRequestNumber)
	switch {
	case strings.HasSuffix(lowerPullRequestNumber, ".patch"):
		pullRequestNumber = pullRequestNumber[:len(pullRequestNumber)-len(".patch")]
	case strings.HasSuffix(lowerPullRequestNumber, ".diff"):
		pullRequestNumber = pullRequestNumber[:len(pullRequestNumber)-len(".diff")]
	}
	return isNumericCommandBranch(pullRequestNumber)
}
