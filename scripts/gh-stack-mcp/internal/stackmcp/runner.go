package stackmcp

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const maxCapturedOutputBytes = 64 * 1024

type ProcessRunnerConfig struct {
	ExtensionPath string
	GitPath       string
	GHPath        string
}

type ProcessRunner struct {
	config ProcessRunnerConfig
}

type ProcessResult struct {
	Spawned         bool
	ExitCode        *int
	Stdout          []byte
	Stderr          []byte
	Truncated       bool
	StdoutTruncated bool
	StderrTruncated bool
}

func NewProcessRunner(config ProcessRunnerConfig) (*ProcessRunner, error) {
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
	config.ExtensionPath = filepath.Clean(config.ExtensionPath)
	config.GitPath = filepath.Clean(config.GitPath)
	config.GHPath = filepath.Clean(config.GHPath)
	return &ProcessRunner{config: config}, nil
}

func (runner *ProcessRunner) Run(ctx context.Context, target Target, command CommandSpec) (ProcessResult, error) {
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
	if len(command.Args) == 0 {
		return ProcessResult{}, errors.New("fixed Stack command arguments are required")
	}
	for _, argument := range command.Args {
		if strings.ContainsRune(argument, '\x00') {
			return ProcessResult{}, errors.New("Stack command arguments cannot contain NUL bytes")
		}
	}
	if err := runner.validateExecutables(); err != nil {
		return ProcessResult{}, err
	}

	stdout := boundedOutputWriter{}
	stderr := boundedOutputWriter{}
	process := exec.CommandContext(ctx, runner.config.ExtensionPath, command.Args...)
	process.Dir = target.Path
	process.Env = runner.childEnvironment(target, os.Environ())
	process.Stdin = nil
	process.Stdout = &stdout
	process.Stderr = &stderr
	process.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	runErr := process.Run()
	result := ProcessResult{
		Spawned:         process.Process != nil,
		Stdout:          stdout.data,
		Stderr:          stderr.data,
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
		Truncated:       stdout.truncated || stderr.truncated,
	}
	if process.ProcessState != nil {
		exitCode := process.ProcessState.ExitCode()
		result.ExitCode = &exitCode
	}

	if runErr != nil {
		if !result.Spawned {
			return result, errors.New("could not start the required gh-stack extension; verify the packaged executable and permissions")
		}
		if ctx.Err() != nil {
			return result, fmt.Errorf("gh-stack execution was interrupted: %w", ctx.Err())
		}
		var exitError *exec.ExitError
		if errors.As(runErr, &exitError) {
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
	data      []byte
	truncated bool
}

func (writer *boundedOutputWriter) Write(data []byte) (int, error) {
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
