package stackmcp

import (
	"fmt"
	"net/url"
	"path/filepath"
	"strconv"
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
	case RebaseInput:
		return buildRebaseCommand(input, target)
	case SyncInput:
		return buildSyncCommand(input, target)
	case PushInput:
		return buildPushCommand(input, target)
	case SubmitInput:
		return buildSubmitCommand(input, target)
	case LinkInput:
		return buildLinkCommand(input, target)
	case UnstackInput:
		return buildUnstackCommand(input, target)
	default:
		return CommandSpec{}, fmt.Errorf("unsupported Stack command input type %T", typedInput)
	}
}

func buildRebaseCommand(input RebaseInput, target Target) (CommandSpec, error) {
	if err := validateCommandRemote("rebase", input.Remote, target); err != nil {
		return CommandSpec{}, err
	}

	args := []string{"rebase"}
	switch input.Action {
	case RebaseStart:
		args = append(args, "--remote", target.Remote)
		switch input.Scope {
		case RebaseFull:
		case RebaseUpstack:
			args = append(args, "--upstack")
		case RebaseDownstack:
			args = append(args, "--downstack")
		case RebaseNoTrunk:
			args = append(args, "--no-trunk")
		default:
			return CommandSpec{}, fmt.Errorf("rebase start requires a supported explicit scope")
		}
	case RebaseContinue:
		if input.Scope != "" {
			return CommandSpec{}, fmt.Errorf("rebase continue does not accept a scope")
		}
		args = append(args, "--continue")
	default:
		return CommandSpec{}, fmt.Errorf("unsupported rebase action %q", input.Action)
	}
	return CommandSpec{Args: args}, nil
}

func buildSyncCommand(input SyncInput, target Target) (CommandSpec, error) {
	if err := validateCommandRemote("sync", input.Remote, target); err != nil {
		return CommandSpec{}, err
	}
	args := []string{"sync", "--remote", target.Remote}
	if input.Prune {
		args = append(args, "--prune")
	}
	return CommandSpec{Args: args}, nil
}

func buildPushCommand(input PushInput, target Target) (CommandSpec, error) {
	if err := validateCommandRemote("push", input.Remote, target); err != nil {
		return CommandSpec{}, err
	}
	return CommandSpec{Args: []string{"push", "--remote", target.Remote}}, nil
}

func buildSubmitCommand(input SubmitInput, target Target) (CommandSpec, error) {
	if err := validateCommandRemote("submit", input.Remote, target); err != nil {
		return CommandSpec{}, err
	}

	args := []string{"submit", "--auto", "--remote", target.Remote}
	if input.Open {
		args = append(args, "--open")
	}
	return CommandSpec{Args: args}, nil
}

func buildLinkCommand(input LinkInput, target Target) (CommandSpec, error) {
	if err := validateCommandRemote("link", input.Remote, target); err != nil {
		return CommandSpec{}, err
	}
	if len(input.Branches) < 2 {
		return CommandSpec{}, fmt.Errorf("link requires at least two ordered branches")
	}
	if input.Base != "" {
		if err := validateCommandBranch(target, "link base", input.Base); err != nil {
			return CommandSpec{}, err
		}
	}

	args := []string{"link", "--remote", target.Remote}
	if input.Base != "" {
		args = append(args, "--base", input.Base)
	}
	if input.Open {
		args = append(args, "--open")
	}
	for _, branch := range input.Branches {
		if err := validateCommandBranch(target, "link branch", branch); err != nil {
			return CommandSpec{}, err
		}
		args = append(args, branch)
	}
	return CommandSpec{Args: args}, nil
}

func buildUnstackCommand(input UnstackInput, target Target) (CommandSpec, error) {
	if err := validateCommandRemote("unstack", input.Remote, target); err != nil {
		return CommandSpec{}, err
	}
	if input.StackNumber <= 0 {
		return CommandSpec{}, fmt.Errorf("unstack requires a positive explicit Stack number")
	}

	args := []string{"unstack", strconv.Itoa(input.StackNumber)}
	switch input.Mode {
	case UnstackRemoteAndLocal:
	case UnstackLocalOnly:
		args = append(args, "--local")
	default:
		return CommandSpec{}, fmt.Errorf("unstack requires an explicit supported mode")
	}
	return CommandSpec{Args: args}, nil
}

func validateCommandRemote(operation, requestRemote string, target Target) error {
	if strings.TrimSpace(target.Remote) == "" {
		return fmt.Errorf("%s requires a validated target remote", operation)
	}
	if strings.TrimSpace(requestRemote) == "" {
		return fmt.Errorf("%s requires an explicit remote", operation)
	}
	if requestRemote != target.Remote {
		return fmt.Errorf("%s remote %q does not match validated target remote %q", operation, requestRemote, target.Remote)
	}
	return nil
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
