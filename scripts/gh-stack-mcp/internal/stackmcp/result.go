package stackmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
)

func AdaptProcessResult(operation string, target Target, result ProcessResult, processErr error) (Outcome, error) {
	return adaptProcessResult(operation, target, result, processErr)
}

func adaptProcessResult(operation string, target Target, result ProcessResult, processErr error) (Outcome, error) {
	outcome := Outcome{
		Operation:  operation,
		Repository: target.Repository,
		Spawned:    result.Spawned,
		ExitCode:   copyExitCode(result.ExitCode),
		Status:     OutcomeExitedUnverified,
		Stdout:     string(result.Stdout),
		Stderr:     string(result.Stderr),
		Truncated:  processResultTruncated(result),
	}
	if !result.Spawned && outcome.Stderr == "" && processErr != nil {
		outcome.Stderr = processErr.Error()
	}

	if result.CleanupUnknown {
		outcome.Status = OutcomeCleanupUnknown
		return outcome, uncertainProcessError(operation, result, processErr)
	}
	if processWasInterrupted(result, processErr) {
		outcome.Status = OutcomeTimedOutUnknown
		return outcome, uncertainProcessError(operation, result, processErr)
	}
	if !result.Spawned {
		outcome.Status = OutcomeRejected
		return outcome, processResultError(operation, result, processErr)
	}

	if operation == "stack_view" {
		if result.ExitCode == nil || *result.ExitCode != 0 {
			return outcome, processResultError(operation, result, processErr)
		}
		if processStdoutTruncated(result) {
			return outcome, errors.Join(processErr, errors.New("stack_view JSON stdout was truncated; local observation was withheld"))
		}

		view, err := parseLocalView(result.Stdout, target.Path, target.GitPath)
		if err != nil {
			return outcome, errors.Join(processErr, fmt.Errorf("stack_view did not return one complete valid local view: %w", err))
		}
		canonical, err := json.Marshal(view)
		if err != nil {
			return outcome, errors.Join(processErr, fmt.Errorf("encode canonical local Stack view: %w", err))
		}
		outcome.Status = OutcomeLocalObservation
		outcome.Stdout = string(canonical)
		return outcome, processErr
	}

	if operation == "stack_rebase" && result.ExitCode != nil && *result.ExitCode == 3 {
		if ValidateRebaseContinueState(target) == nil {
			outcome.Status = OutcomeConflictPending
		}
	}
	return outcome, processResultError(operation, result, processErr)
}

// LocalView contains the ordered local observations returned by gh-stack
// v0.1.1's view --json command.
type LocalView struct {
	Trunk         string        `json:"trunk"`
	CurrentBranch string        `json:"currentBranch"`
	Branches      []LocalBranch `json:"branches"`
}

type LocalBranch struct {
	Name        string            `json:"name"`
	Head        string            `json:"head,omitempty"`
	Base        string            `json:"base,omitempty"`
	IsCurrent   bool              `json:"isCurrent"`
	IsMerged    bool              `json:"isMerged"`
	IsQueued    bool              `json:"isQueued"`
	NeedsRebase bool              `json:"needsRebase"`
	PR          *LocalPullRequest `json:"pr,omitempty"`
}

type LocalPullRequest struct {
	Number int    `json:"number"`
	URL    string `json:"url,omitempty"`
	State  string `json:"state"`
}

type localViewDocument struct {
	Trunk         *string                `json:"trunk"`
	CurrentBranch *string                `json:"currentBranch"`
	Branches      *[]localBranchDocument `json:"branches"`
}

type localBranchDocument struct {
	Name        *string                   `json:"name"`
	Head        *string                   `json:"head"`
	Base        *string                   `json:"base"`
	IsCurrent   *bool                     `json:"isCurrent"`
	IsMerged    *bool                     `json:"isMerged"`
	IsQueued    *bool                     `json:"isQueued"`
	NeedsRebase *bool                     `json:"needsRebase"`
	PR          *localPullRequestDocument `json:"pr"`
}

type localPullRequestDocument struct {
	Number *int    `json:"number"`
	URL    *string `json:"url"`
	State  *string `json:"state"`
}

func parseLocalView(data []byte, worktree string, fixedGitPath ...string) (LocalView, error) {
	if len(fixedGitPath) > 1 {
		return LocalView{}, errors.New("local view parsing accepts at most one fixed Git executable path")
	}
	gitPath := ""
	if len(fixedGitPath) == 1 && fixedGitPath[0] != "" {
		gitPath = fixedGitPath[0]
		if !filepath.IsAbs(gitPath) {
			return LocalView{}, errors.New("local view parsing requires an absolute fixed Git executable path")
		}
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()

	var document *localViewDocument
	if err := decoder.Decode(&document); err != nil {
		return LocalView{}, fmt.Errorf("decode view JSON: %w", err)
	}
	if document == nil {
		return LocalView{}, errors.New("view JSON must be an object")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return LocalView{}, errors.New("view JSON contains more than one value")
		}
		return LocalView{}, fmt.Errorf("view JSON has trailing data: %w", err)
	}

	if document.Trunk == nil {
		return LocalView{}, errors.New("view JSON is missing trunk")
	}
	if *document.Trunk == "" {
		return LocalView{}, errors.New("view JSON has an empty trunk")
	}
	if document.CurrentBranch == nil {
		return LocalView{}, errors.New("view JSON is missing currentBranch")
	}
	if *document.CurrentBranch == "" {
		return LocalView{}, errors.New("view JSON has an empty currentBranch")
	}
	if document.Branches == nil {
		return LocalView{}, errors.New("view JSON is missing branches")
	}
	if !filepath.IsAbs(worktree) {
		return LocalView{}, errors.New("view JSON branch refs cannot be validated without an absolute target worktree path")
	}
	if err := validateLocalViewBranchRefWithPath(gitPath, worktree, "trunk", *document.Trunk); err != nil {
		return LocalView{}, err
	}
	if err := validateLocalViewBranchRefWithPath(gitPath, worktree, "currentBranch", *document.CurrentBranch); err != nil {
		return LocalView{}, err
	}

	view := LocalView{
		Trunk:         *document.Trunk,
		CurrentBranch: *document.CurrentBranch,
		Branches:      make([]LocalBranch, len(*document.Branches)),
	}
	for index, branch := range *document.Branches {
		if branch.Name == nil || *branch.Name == "" {
			return LocalView{}, fmt.Errorf("view JSON branch %d is missing name", index)
		}
		if err := validateLocalViewBranchRefWithPath(gitPath, worktree, fmt.Sprintf("branch %d name", index), *branch.Name); err != nil {
			return LocalView{}, err
		}
		if branch.IsCurrent == nil || branch.IsMerged == nil || branch.IsQueued == nil || branch.NeedsRebase == nil {
			return LocalView{}, fmt.Errorf("view JSON branch %d is missing a required state flag", index)
		}

		localBranch := LocalBranch{
			Name:        *branch.Name,
			IsCurrent:   *branch.IsCurrent,
			IsMerged:    *branch.IsMerged,
			IsQueued:    *branch.IsQueued,
			NeedsRebase: *branch.NeedsRebase,
		}
		if branch.Head != nil {
			localBranch.Head = *branch.Head
		}
		if branch.Base != nil {
			localBranch.Base = *branch.Base
		}
		if branch.PR != nil {
			if branch.PR.Number == nil || *branch.PR.Number <= 0 {
				return LocalView{}, fmt.Errorf("view JSON branch %d has an invalid PR number", index)
			}
			if branch.PR.State == nil || *branch.PR.State == "" {
				return LocalView{}, fmt.Errorf("view JSON branch %d is missing PR state", index)
			}
			localBranch.PR = &LocalPullRequest{
				Number: *branch.PR.Number,
				State:  *branch.PR.State,
			}
			if branch.PR.URL != nil {
				localBranch.PR.URL = *branch.PR.URL
			}
		}
		view.Branches[index] = localBranch
	}
	return view, nil
}

func validateLocalViewBranchRefWithPath(gitPath, worktree, field, name string) error {
	// Check a fully qualified ref so @{-1} cannot expand as branch shorthand.
	_, err := runTargetGitWithPath(
		gitPath,
		worktree,
		"validate local Stack view "+field+" ref",
		"check-ref-format",
		"refs/heads/"+name,
	)
	if err != nil {
		return fmt.Errorf("validate view JSON %s as a local Git branch ref: %w", field, err)
	}
	return nil
}

func processResultTruncated(result ProcessResult) bool {
	return result.Truncated || result.StdoutTruncated || result.StderrTruncated
}

func processStdoutTruncated(result ProcessResult) bool {
	if result.StdoutTruncated {
		return true
	}
	return result.Truncated && !result.StderrTruncated
}

func processWasInterrupted(result ProcessResult, processErr error) bool {
	return result.TimedOut || result.Canceled || errors.Is(processErr, context.Canceled) || errors.Is(processErr, context.DeadlineExceeded)
}

func uncertainProcessError(operation string, result ProcessResult, processErr error) error {
	if processErr != nil {
		return processErr
	}
	if result.CleanupUnknown {
		return fmt.Errorf("%s process cleanup is uncertain", operation)
	}
	return fmt.Errorf("%s timed out or was interrupted", operation)
}

func processResultError(operation string, result ProcessResult, processErr error) error {
	if processErr != nil {
		return processErr
	}
	if !result.Spawned {
		return fmt.Errorf("%s was rejected before launch", operation)
	}
	if result.ExitCode == nil {
		return fmt.Errorf("%s completed without a process exit status", operation)
	}
	if *result.ExitCode != 0 {
		return fmt.Errorf("%s exited with status %d", operation, *result.ExitCode)
	}
	return nil
}

func copyExitCode(exitCode *int) *int {
	if exitCode == nil {
		return nil
	}
	copy := *exitCode
	return &copy
}
