package stackmcp

import (
	"context"
	"fmt"
)

type stackDispatcher struct {
	runner *ProcessRunner
}

func newStackDispatcher(runner *ProcessRunner) Dispatcher {
	return &stackDispatcher{runner: runner}
}

func (dispatcher *stackDispatcher) Dispatch(ctx context.Context, operation string, typedInput any) (Outcome, error) {
	expectedOperation, path, remote, err := stackInputTarget(typedInput)
	if err != nil {
		return rejectedStackOutcome(operation, "", err)
	}
	if operation != expectedOperation {
		return rejectedStackOutcome(operation, "", fmt.Errorf("typed input for %s cannot be dispatched as %s", expectedOperation, operation))
	}
	if dispatcher == nil || dispatcher.runner == nil {
		return rejectedStackOutcome(operation, "", fmt.Errorf("the Stack MCP process runner is not configured"))
	}

	target, err := ValidateTarget(path, remote, dispatcher.runner.config.GitPath)
	if err != nil {
		return rejectedStackOutcome(operation, "", fmt.Errorf("validate Stack worktree and remote before launch: %w", err))
	}
	if err := validateStackOperationPreflight(typedInput, target); err != nil {
		return rejectedStackOutcome(operation, target.Repository, err)
	}

	command, err := BuildCommand(typedInput, target)
	if err != nil {
		return rejectedStackOutcome(operation, target.Repository, fmt.Errorf("validate fixed %s command before launch: %w", operation, err))
	}

	processResult, processErr := dispatcher.runner.Run(ctx, target, command)
	return AdaptProcessResult(operation, target, processResult, processErr)
}

func stackInputTarget(input any) (operation, path, remote string, err error) {
	switch value := input.(type) {
	case ViewInput:
		return "stack_view", value.Path, value.Remote, nil
	case InitInput:
		return "stack_init", value.Path, value.Remote, nil
	case AddInput:
		return "stack_add", value.Path, value.Remote, nil
	case CheckoutInput:
		return "stack_checkout", value.Path, value.Remote, nil
	case RebaseInput:
		return "stack_rebase", value.Path, value.Remote, nil
	case SyncInput:
		return "stack_sync", value.Path, value.Remote, nil
	case PushInput:
		return "stack_push", value.Path, value.Remote, nil
	case SubmitInput:
		return "stack_submit", value.Path, value.Remote, nil
	case LinkInput:
		return "stack_link", value.Path, value.Remote, nil
	case UnstackInput:
		return "stack_unstack", value.Path, value.Remote, nil
	default:
		return "", "", "", fmt.Errorf("unsupported typed Stack input %T", input)
	}
}

func validateStackOperationPreflight(input any, target Target) error {
	switch value := input.(type) {
	case InitInput:
		return ValidateInitRemoteSelection(target, value.Trunk)
	case CheckoutInput:
		return ValidateCheckoutRemoteSelection(target)
	case RebaseInput:
		if value.Action == RebaseContinue {
			return ValidateRebaseContinueState(target)
		}
	case SubmitInput:
		return ValidateSubmitState(target)
	}
	return nil
}

func rejectedStackOutcome(operation, repository string, cause error) (Outcome, error) {
	if cause == nil {
		cause = fmt.Errorf("Stack operation was rejected before launch")
	}
	return Outcome{
		Operation:  operation,
		Repository: repository,
		Spawned:    false,
		Status:     OutcomeRejected,
		Stderr:     cause.Error(),
	}, cause
}
