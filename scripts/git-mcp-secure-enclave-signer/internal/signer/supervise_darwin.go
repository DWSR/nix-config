//go:build darwin

package signer

import (
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/supervisor"
)

const capabilityPollInterval = 10 * time.Millisecond

var (
	errCapabilityDeadline    = errors.New("signing worker capability handoff reached the work deadline")
	errCapabilityInterrupted = errors.New("signing worker capability handoff interrupted by parent signal")
)

func runPrivateWorker(workerPath string, arguments []string, attemptStart time.Time) error {
	interrupts := make(chan os.Signal, 1)
	signal.Notify(interrupts, syscall.SIGHUP, os.Interrupt, syscall.SIGQUIT, syscall.SIGTERM)
	defer signal.Stop(interrupts)
	parentSignals := supervisor.NewSignalObserver(interrupts)
	workDeadline := attemptStart.Add(20 * time.Second)

	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return failure(125, fmt.Sprintf("could not create signing worker capability channel: %v", err))
	}
	parentCapability := os.NewFile(uintptr(fds[0]), "signing-worker-capability-parent")
	workerCapability := os.NewFile(uintptr(fds[1]), "signing-worker-capability-worker")
	defer parentCapability.Close()
	defer workerCapability.Close()
	// ExtraFiles duplicates only workerCapability into the child as fd 3. The
	// raw socketpair descriptors must not survive exec under their old numbers.
	syscall.CloseOnExec(fds[0])
	syscall.CloseOnExec(fds[1])
	if err := syscall.SetNonblock(fds[0], true); err != nil {
		return failure(125, fmt.Sprintf("could not bound signing worker capability handoff: %v", err))
	}

	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		return failure(125, fmt.Sprintf("could not capture signing worker stdout: %v", err))
	}
	defer stdoutReader.Close()
	defer stdoutWriter.Close()
	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		return failure(125, fmt.Sprintf("could not capture signing worker stderr: %v", err))
	}
	defer stderrReader.Close()
	defer stderrWriter.Close()
	resultReader, resultWriter, err := os.Pipe()
	if err != nil {
		return failure(125, fmt.Sprintf("could not create signing worker result channel: %v", err))
	}
	defer resultReader.Close()
	defer resultWriter.Close()
	stdoutReaderFD := int(stdoutReader.Fd())
	stderrReaderFD := int(stderrReader.Fd())
	resultReaderFD := int(resultReader.Fd())
	for _, fd := range []int{stdoutReaderFD, stderrReaderFD, resultReaderFD} {
		if err := syscall.SetNonblock(fd, true); err != nil {
			return failure(125, fmt.Sprintf("could not bound signing worker output capture: %v", err))
		}
	}

	capability := make([]byte, capabilitySize)
	if _, err := rand.Read(capability); err != nil {
		return failure(125, fmt.Sprintf("could not generate signing worker capability: %v", err))
	}

	worker := exec.Command(workerPath, arguments...)
	worker.Stdin = os.Stdin
	worker.Stdout = stdoutWriter
	worker.Stderr = stderrWriter
	worker.ExtraFiles = []*os.File{workerCapability, resultWriter}
	worker.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := worker.Start(); err != nil {
		return failure(125, fmt.Sprintf("could not start packaged signing worker: %v", err))
	}

	setupError := closeWorkerParentCopies(workerCapability, stdoutWriter, stderrWriter, resultWriter)
	if setupError == nil {
		setupError = writeCapabilityUntil(fds[0], capability, workDeadline, parentSignals)
	}
	if err := parentCapability.Close(); setupError == nil && err != nil {
		setupError = err
	}

	capturedOutput := newCapturedOutput(stdoutReaderFD, stderrReaderFD)
	results := newWorkerResultObserver(resultReaderFD, capturedOutput, setupError)
	outcome := supervisor.NewDarwinSupervisor(attemptStart, worker.Process.Pid, results, capturedOutput, parentSignals).Run()
	return supervisorOutcomeError(outcome)
}

func closeWorkerParentCopies(files ...*os.File) error {
	var first error
	for _, file := range files {
		if err := file.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func writeCapabilityUntil(fd int, capability []byte, deadline time.Time, signals supervisor.SignalObserver) error {
	for len(capability) > 0 {
		if _, pending := signals.Pending(); pending {
			return errCapabilityInterrupted
		}
		if !time.Now().Before(deadline) {
			return errCapabilityDeadline
		}

		written, err := syscall.Write(fd, capability)
		if written > 0 {
			capability = capability[written:]
		}
		if err == nil && written > 0 {
			continue
		}
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
			next := time.Now().Add(capabilityPollInterval)
			if deadline.Before(next) {
				next = deadline
			}
			time.Sleep(time.Until(next))
			continue
		}
		if err != nil {
			return err
		}
		return syscall.EIO
	}
	return nil
}

func supervisorOutcomeError(outcome supervisor.Outcome) error {
	switch outcome.Code {
	case 0:
		return nil
	case 124:
		return failure(124, "signing worker exceeded the immutable 20-second work deadline")
	case 125:
		if outcome.Cause != nil {
			return failure(125, fmt.Sprintf("signing worker cleanup could not be established by the immutable cleanup deadline after %s: %v", lastSupervisorState(outcome), outcome.Cause))
		}
		return failure(125, fmt.Sprintf("signing worker cleanup could not be established by the immutable cleanup deadline after %s", lastSupervisorState(outcome)))
	default:
		return silentExit{code: outcome.Code}
	}
}

func lastSupervisorState(outcome supervisor.Outcome) supervisor.State {
	if len(outcome.States) < 2 {
		return outcome.Final
	}
	return outcome.States[len(outcome.States)-2]
}
