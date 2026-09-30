package stackmcp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxCapturedOutputBytes = 64 * 1024

const (
	processGroupCleanupTimeout  = 5 * time.Second
	proxyResponseDeliveryMargin = 10 * time.Second
)

type ProcessRunnerConfig struct {
	ExtensionPath string
	GitPath       string
	GHPath        string
}

type ProcessRunner struct {
	config ProcessRunnerConfig
	timing processRunnerTiming
	lockMu sync.Mutex
	locks  map[string]*repositoryOperationLock
}

type repositoryOperationLock struct {
	semaphore chan struct{}
	refs      int
}

type ProcessResult struct {
	Spawned         bool
	ExitCode        *int
	Stdout          []byte
	Stderr          []byte
	Truncated       bool
	StdoutTruncated bool
	StderrTruncated bool
	Canceled        bool
	TimedOut        bool
	CleanupUnknown  bool
}

type processWaitResult struct {
	err    error
	waited bool
}

func NewProcessRunner(config ProcessRunnerConfig) (*ProcessRunner, error) {
	return newProcessRunnerWithTiming(config, defaultProcessRunnerTiming())
}

type processRunnerTiming struct {
	operationBudgets map[string]time.Duration
	cleanupTimeout   time.Duration
	deliveryMargin   time.Duration
}

func defaultProcessRunnerTiming() processRunnerTiming {
	return processRunnerTiming{
		operationBudgets: map[string]time.Duration{
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
		},
		cleanupTimeout: processGroupCleanupTimeout,
		deliveryMargin: proxyResponseDeliveryMargin,
	}
}

func (timing processRunnerTiming) operationBudget(command CommandSpec) (time.Duration, error) {
	if len(command.Args) == 0 {
		return 0, errors.New("fixed Stack command arguments are required")
	}
	budget, ok := timing.operationBudgets[command.Args[0]]
	if !ok {
		return 0, fmt.Errorf("unsupported fixed Stack operation %q", command.Args[0])
	}
	return budget, nil
}

func newProcessRunnerWithTiming(config ProcessRunnerConfig, timing processRunnerTiming) (*ProcessRunner, error) {
	for _, executable := range []struct {
		name string
		path string
	}{
		{name: "gh-stack extension", path: config.ExtensionPath},
		{name: "Git", path: config.GitPath},
		{name: "gh", path: config.GHPath},
	} {
		if executable.path == "" || !filepath.IsAbs(executable.path) || strings.ContainsRune(executable.path, '\x00') {
			return nil, fmt.Errorf("%s executable path must be absolute", executable.name)
		}
	}
	if timing.cleanupTimeout <= 0 || timing.deliveryMargin <= 0 {
		return nil, errors.New("process runner cleanup and delivery margins must be positive")
	}
	for _, operation := range []string{"view", "init", "add", "checkout", "rebase", "sync", "push", "submit", "link", "unstack"} {
		if timing.operationBudgets[operation] <= 0 {
			return nil, fmt.Errorf("process runner budget for %s must be positive", operation)
		}
	}
	operationBudgets := make(map[string]time.Duration, len(timing.operationBudgets))
	for operation, budget := range timing.operationBudgets {
		operationBudgets[operation] = budget
	}
	timing.operationBudgets = operationBudgets
	config.ExtensionPath = filepath.Clean(config.ExtensionPath)
	config.GitPath = filepath.Clean(config.GitPath)
	config.GHPath = filepath.Clean(config.GHPath)
	return &ProcessRunner{
		config: config,
		timing: timing,
		locks:  make(map[string]*repositoryOperationLock),
	}, nil
}

func (runner *ProcessRunner) Run(ctx context.Context, target Target, command CommandSpec) (ProcessResult, error) {
	return runner.runBounded(ctx, target, command)
}

func (runner *ProcessRunner) runBounded(ctx context.Context, target Target, command CommandSpec) (ProcessResult, error) {
	startedAt := time.Now()
	if runner == nil {
		return ProcessResult{}, errors.New("process runner is not configured")
	}
	if ctx == nil {
		return ProcessResult{}, errors.New("process runner requires a context")
	}
	if target.Path == "" || !filepath.IsAbs(target.Path) {
		return ProcessResult{}, errors.New("the validated worktree path must be absolute")
	}
	if !validRunnerRepository(target.Repository) {
		return ProcessResult{}, errors.New("the validated target repository is missing or not normalized")
	}
	if target.CommonDir == "" || !filepath.IsAbs(target.CommonDir) {
		return ProcessResult{}, errors.New("the validated common Git directory must be absolute")
	}
	if len(command.Args) == 0 {
		return ProcessResult{}, errors.New("fixed Stack command arguments are required")
	}
	for _, argument := range command.Args {
		if strings.ContainsRune(argument, '\x00') {
			return ProcessResult{}, errors.New("Stack command arguments cannot contain NUL bytes")
		}
	}
	operationBudget, err := runner.timing.operationBudget(command)
	if err != nil {
		return ProcessResult{}, err
	}
	if ctx.Err() != nil {
		return runner.contextResult(ctx, ctx), fmt.Errorf("gh-stack execution was interrupted before launch: %w", ctx.Err())
	}

	executionDeadline := startedAt.Add(operationBudget)
	if requestDeadline, hasDeadline := ctx.Deadline(); hasDeadline {
		latestExecutionDeadline := requestDeadline.Add(-runner.timing.cleanupTimeout - runner.timing.deliveryMargin)
		if !latestExecutionDeadline.After(startedAt) {
			return ProcessResult{}, errors.New("request deadline leaves no execution time after cleanup and response-delivery margins")
		}
		if latestExecutionDeadline.Before(executionDeadline) {
			executionDeadline = latestExecutionDeadline
		}
	}
	if !executionDeadline.After(time.Now()) {
		return ProcessResult{}, errors.New("Stack operation budget expired before launch")
	}

	commonDirectory := filepath.Clean(target.CommonDir)
	if err := runner.validateExecutables(); err != nil {
		return ProcessResult{}, err
	}
	executionContext, cancel := context.WithDeadline(ctx, executionDeadline)
	defer cancel()

	release, err := runner.acquireRepositoryLock(executionContext, commonDirectory)
	if err != nil {
		result := runner.contextResult(ctx, executionContext)
		return result, runner.prelaunchContextError(ctx, executionContext, err)
	}
	defer release()

	if executionContext.Err() != nil || !time.Now().Before(executionDeadline) {
		result := runner.contextResult(ctx, executionContext)
		if result.Canceled || result.TimedOut {
			return result, runner.prelaunchContextError(ctx, executionContext, executionContext.Err())
		}
		return result, errors.New("Stack operation budget expired before launch")
	}

	return runner.runSupervisedProcess(ctx, executionContext, target, command)
}

func (runner *ProcessRunner) contextResult(requestContext, executionContext context.Context) ProcessResult {
	requestError := requestContext.Err()
	executionError := executionContext.Err()
	return ProcessResult{
		Canceled: errors.Is(requestError, context.Canceled) || errors.Is(executionError, context.Canceled),
		TimedOut: errors.Is(requestError, context.DeadlineExceeded) || errors.Is(executionError, context.DeadlineExceeded),
	}
}

func (runner *ProcessRunner) prelaunchContextError(requestContext, executionContext context.Context, cause error) error {
	if requestError := requestContext.Err(); errors.Is(requestError, context.Canceled) {
		return fmt.Errorf("gh-stack execution was interrupted before launch while waiting for repository serialization: %w", requestError)
	} else if errors.Is(requestError, context.DeadlineExceeded) {
		return fmt.Errorf("request deadline expired before launch while waiting for repository serialization: %w", requestError)
	}
	if executionError := executionContext.Err(); executionError != nil {
		return fmt.Errorf("gh-stack execution budget expired before launch while waiting for repository serialization: %w", executionError)
	}
	if cause != nil {
		return fmt.Errorf("could not acquire the repository operation lock: %w", cause)
	}
	return errors.New("could not acquire the repository operation lock")
}

func (runner *ProcessRunner) acquireRepositoryLock(ctx context.Context, commonDirectory string) (func(), error) {
	runner.lockMu.Lock()
	lock := runner.locks[commonDirectory]
	if lock == nil {
		lock = &repositoryOperationLock{semaphore: make(chan struct{}, 1)}
		runner.locks[commonDirectory] = lock
	}
	lock.refs++
	runner.lockMu.Unlock()

	dropReference := func() {
		runner.lockMu.Lock()
		lock.refs--
		if lock.refs == 0 {
			delete(runner.locks, commonDirectory)
		}
		runner.lockMu.Unlock()
	}

	select {
	case lock.semaphore <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-lock.semaphore
			dropReference()
			return nil, err
		}
		var releaseOnce sync.Once
		return func() {
			releaseOnce.Do(func() {
				<-lock.semaphore
				dropReference()
			})
		}, nil
	case <-ctx.Done():
		dropReference()
		return nil, ctx.Err()
	}
}

func (runner *ProcessRunner) runSupervisedProcess(requestContext, executionContext context.Context, target Target, command CommandSpec) (ProcessResult, error) {
	stdout := boundedOutputWriter{}
	stderr := boundedOutputWriter{}
	process := exec.Command(runner.config.ExtensionPath, command.Args...)
	process.Dir = target.Path
	process.Env = runner.childEnvironment(target, os.Environ())
	process.Stdin = nil
	process.Stdout = &stdout
	process.Stderr = &stderr
	process.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := executionContext.Err(); err != nil {
		result := runner.contextResult(requestContext, executionContext)
		return result, runner.prelaunchContextError(requestContext, executionContext, err)
	}
	if deadline, hasDeadline := executionContext.Deadline(); hasDeadline && !time.Now().Before(deadline) {
		result := runner.contextResult(requestContext, executionContext)
		result.TimedOut = true
		return result, errors.New("Stack operation budget expired before launch")
	}
	if err := process.Start(); err != nil {
		return ProcessResult{}, errors.New("could not start the required gh-stack extension; verify the packaged executable and permissions")
	}

	waitResults := make(chan error, 1)
	go func() {
		waitResults <- process.Wait()
	}()

	waitResult, completed := arbitrateProcessCompletion(requestContext, executionContext, waitResults)
	if completed {
		return completedProcessResult(process, &stdout, &stderr, waitResult.err)
	}
	return runner.interruptedProcessResult(requestContext, executionContext, process, &stdout, &stderr, waitResults, waitResult)
}

func (runner *ProcessRunner) interruptedProcessResult(
	requestContext, executionContext context.Context,
	process *exec.Cmd,
	stdout, stderr *boundedOutputWriter,
	waitResults <-chan error,
	initialWaitResult processWaitResult,
) (ProcessResult, error) {
	var waitErr error
	var waited, cleanupUnknown bool
	if initialWaitResult.waited {
		waitErr, waited, cleanupUnknown = terminateProcessGroupWithInitialWait(
			process.Process.Pid, waitResults, runner.timing.cleanupTimeout, initialWaitResult,
		)
	} else {
		waitErr, waited, cleanupUnknown = terminateProcessGroup(
			process.Process.Pid, waitResults, runner.timing.cleanupTimeout,
		)
	}
	result := capturedProcessResult(process, stdout, stderr, waited)
	contextResult := runner.contextResult(requestContext, executionContext)
	now := time.Now()
	result.Canceled = contextResult.Canceled
	result.TimedOut = contextResult.TimedOut || contextDeadlineExpiredAt(requestContext, now) || contextDeadlineExpiredAt(executionContext, now)
	result.CleanupUnknown = cleanupUnknown

	cause := executionContext.Err()
	if cause == nil {
		cause = requestContext.Err()
	}
	if cause == nil && result.TimedOut {
		cause = context.DeadlineExceeded
	}
	if cause == nil && result.Canceled {
		cause = context.Canceled
	}
	if cause == nil {
		cause = errors.New("execution stopped before its result was collected")
	}
	if cleanupUnknown {
		return result, fmt.Errorf("gh-stack execution stopped with uncertain process-group cleanup: %w", cause)
	}
	if waitErr == nil && result.ExitCode == nil {
		return result, fmt.Errorf("gh-stack execution stopped before an exit status was collected: %w", cause)
	}
	if result.TimedOut {
		return result, fmt.Errorf("gh-stack execution exceeded its bounded time budget: %w", cause)
	}
	return result, fmt.Errorf("gh-stack execution was interrupted: %w", cause)
}

func arbitrateProcessCompletion(requestContext, executionContext context.Context, waitResults <-chan error) (processWaitResult, bool) {
	arbitrateWaitResult := func(waitErr error) (processWaitResult, bool) {
		waitResult := processWaitResult{err: waitErr, waited: true}
		return waitResult, !processExecutionStoppedAt(requestContext, executionContext, time.Now())
	}

	select {
	case waitErr := <-waitResults:
		return arbitrateWaitResult(waitErr)
	default:
	}

	select {
	case waitErr := <-waitResults:
		return arbitrateWaitResult(waitErr)
	case <-requestContext.Done():
		return processWaitResult{}, false
	case <-executionContext.Done():
		return processWaitResult{}, false
	}
}

func processExecutionStoppedAt(requestContext, executionContext context.Context, now time.Time) bool {
	return requestContext.Err() != nil || executionContext.Err() != nil ||
		contextDeadlineExpiredAt(requestContext, now) || contextDeadlineExpiredAt(executionContext, now)
}

func contextDeadlineExpiredAt(ctx context.Context, now time.Time) bool {
	deadline, hasDeadline := ctx.Deadline()
	return hasDeadline && !now.Before(deadline)
}

func completedProcessResult(process *exec.Cmd, stdout, stderr *boundedOutputWriter, waitErr error) (ProcessResult, error) {
	result := capturedProcessResult(process, stdout, stderr, true)
	if waitErr != nil {
		if !result.Spawned {
			return result, errors.New("could not start the required gh-stack extension; verify the packaged executable and permissions")
		}
		var exitError *exec.ExitError
		if errors.As(waitErr, &exitError) {
			exitCode := exitError.ExitCode()
			result.ExitCode = &exitCode
			return result, nil
		}
		return result, errors.New("could not collect the gh-stack process result")
	}
	if !result.Spawned || result.ExitCode == nil {
		return result, errors.New("gh-stack completed without a process exit status")
	}
	return result, nil
}

func capturedProcessResult(process *exec.Cmd, stdout, stderr *boundedOutputWriter, waited bool) ProcessResult {
	stdoutData, stdoutTruncated := stdout.snapshot()
	stderrData, stderrTruncated := stderr.snapshot()
	result := ProcessResult{
		Spawned:         process.Process != nil,
		Stdout:          stdoutData,
		Stderr:          stderrData,
		StdoutTruncated: stdoutTruncated,
		StderrTruncated: stderrTruncated,
		Truncated:       stdoutTruncated || stderrTruncated,
	}
	if waited && process.ProcessState != nil {
		exitCode := process.ProcessState.ExitCode()
		result.ExitCode = &exitCode
	}
	return result
}

func terminateProcessGroup(processGroupID int, waitResults <-chan error, timeout time.Duration) (error, bool, bool) {
	return terminateProcessGroupWithInitialWait(processGroupID, waitResults, timeout, processWaitResult{})
}

func terminateProcessGroupWithInitialWait(
	processGroupID int,
	waitResults <-chan error,
	timeout time.Duration,
	initialWaitResult processWaitResult,
) (error, bool, bool) {
	if processGroupID <= 1 || timeout <= 0 {
		return nil, false, true
	}
	deadline := time.Now().Add(timeout)
	escalationTime := time.Now().Add(timeout / 2)
	_ = signalProcessGroup(processGroupID, syscall.SIGTERM)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()

	waitErr := initialWaitResult.err
	waited := initialWaitResult.waited
	killed := false
	for {
		now := time.Now()
		if !killed && !now.Before(escalationTime) {
			_ = signalProcessGroup(processGroupID, syscall.SIGKILL)
			killed = true
		}

		groupAlive, groupErr := processGroupAlive(processGroupID)
		if groupErr != nil {
			_ = signalProcessGroup(processGroupID, syscall.SIGKILL)
		}
		if waited && !groupAlive && groupErr == nil {
			return waitErr, true, false
		}
		if !now.Before(deadline) {
			_ = signalProcessGroup(processGroupID, syscall.SIGKILL)
			if !waited {
				select {
				case waitErr = <-waitResults:
					waited = true
				default:
				}
			}
			groupAlive, groupErr = processGroupAlive(processGroupID)
			return waitErr, waited, !waited || groupAlive || groupErr != nil
		}

		select {
		case waitErr = <-waitResults:
			waited = true
		case <-ticker.C:
		}
	}
}

func signalProcessGroup(processGroupID int, signal syscall.Signal) error {
	if processGroupID <= 1 {
		return errors.New("invalid child process-group id")
	}
	err := syscall.Kill(-processGroupID, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

func processGroupAlive(processGroupID int) (bool, error) {
	if processGroupID <= 1 {
		return false, errors.New("invalid child process-group id")
	}
	err := syscall.Kill(-processGroupID, 0)
	if err == nil || errors.Is(err, syscall.EPERM) {
		return true, nil
	}
	if errors.Is(err, syscall.ESRCH) {
		return false, nil
	}
	return false, err
}

func validRunnerRepository(repository string) bool {
	if repository == "" || strings.ContainsAny(repository, "\x00\r\n\t ") {
		return false
	}
	identity, err := parseRemoteRepository("https://" + repository)
	return err == nil && identity == repository
}

func (runner *ProcessRunner) validateExecutables() error {
	for _, executable := range []struct {
		name string
		path string
	}{
		{name: "gh-stack extension", path: runner.config.ExtensionPath},
		{name: "Git", path: runner.config.GitPath},
		{name: "gh", path: runner.config.GHPath},
	} {
		info, err := os.Stat(executable.path)
		if errors.Is(err, os.ErrNotExist) {
			return missingRunnerDependency(executable.name)
		}
		if err != nil {
			return fmt.Errorf("required %s executable cannot be accessed; restore or rebuild the packaged Stack MCP runtime", executable.name)
		}
		if !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			return fmt.Errorf("required %s executable is not runnable; restore or rebuild the packaged Stack MCP runtime", executable.name)
		}
	}
	return nil
}

func missingRunnerDependency(name string) error {
	switch name {
	case "gh-stack extension":
		return errors.New("required gh-stack extension executable is missing; restore or rebuild the Stack MCP package")
	case "Git":
		return errors.New("required Git executable is missing; restore the packaged Git runtime")
	case "gh":
		return errors.New("required gh executable is missing; restore the packaged GitHub CLI runtime and authenticate with gh auth login")
	default:
		return fmt.Errorf("required %s executable is missing; restore the packaged Stack MCP runtime", name)
	}
}

var allowlistedRunnerEnvironment = [...]string{
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"GH_CONFIG_DIR",
	"GNUPGHOME",
	"GPG_AGENT_INFO",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"TMPDIR",
	"TMP",
	"TEMP",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
}

func (runner *ProcessRunner) childEnvironment(target Target, inherited []string) []string {
	allowed := make(map[string]struct{}, len(allowlistedRunnerEnvironment))
	for _, name := range allowlistedRunnerEnvironment {
		allowed[name] = struct{}{}
	}
	values := make(map[string]string, len(allowed))
	for _, entry := range inherited {
		name, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if _, isAllowed := allowed[name]; isAllowed {
			values[name] = value
		}
	}

	environment := make([]string, 0, len(allowed)+3)
	for _, name := range allowlistedRunnerEnvironment {
		if value, exists := values[name]; exists {
			environment = append(environment, name+"="+value)
		}
	}
	environment = append(environment,
		"GH_PATH="+runner.config.GHPath,
		"PATH="+runner.runtimePath(),
		"GH_REPO="+target.Repository,
	)
	return environment
}

func (runner *ProcessRunner) runtimePath() string {
	directories := []string{
		filepath.Dir(runner.config.ExtensionPath),
		filepath.Dir(runner.config.GitPath),
		filepath.Dir(runner.config.GHPath),
	}
	seen := make(map[string]struct{}, len(directories))
	unique := make([]string, 0, len(directories))
	for _, directory := range directories {
		if _, exists := seen[directory]; exists {
			continue
		}
		seen[directory] = struct{}{}
		unique = append(unique, directory)
	}
	return strings.Join(unique, string(os.PathListSeparator))
}

type boundedOutputWriter struct {
	mu        sync.Mutex
	data      []byte
	truncated bool
}

func (writer *boundedOutputWriter) Write(data []byte) (int, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()

	originalLength := len(data)
	remaining := maxCapturedOutputBytes - len(writer.data)
	if remaining <= 0 {
		if originalLength > 0 {
			writer.truncated = true
		}
		return originalLength, nil
	}
	if len(data) > remaining {
		data = data[:remaining]
		writer.truncated = true
	}
	writer.data = append(writer.data, data...)
	return originalLength, nil
}

func (writer *boundedOutputWriter) snapshot() ([]byte, bool) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return append([]byte(nil), writer.data...), writer.truncated
}
