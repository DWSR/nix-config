//go:build darwin

package supervisor

import (
	"errors"
	"fmt"
	"syscall"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/darwinproc"
)

const (
	workLimit    = 20 * time.Second
	attemptLimit = 22 * time.Second
	termLimit    = time.Second
	cleanupLimit = 2 * time.Second
	pollInterval = 10 * time.Millisecond
)

var errDeadline = darwinproc.ErrDeadline

type State string

const (
	Start            State = "Start"
	Working          State = "Working"
	CleanupTerm      State = "CleanupTerm"
	CleanupKill      State = "CleanupKill"
	VerifyGroup      State = "VerifyGroup"
	ReapDirectWorker State = "ReapDirectWorker"
	RelayOutput      State = "RelayOutput"
	Succeeded        State = "Succeeded"
	Failed           State = "Failed"
	TimedOut         State = "TimedOut"
	Interrupted      State = "Interrupted"
	CleanupUncertain State = "CleanupUncertain"
)

type Deadlines struct {
	T0           time.Time
	Work         time.Time
	Attempt      time.Time
	CleanupStart time.Time
	Term         time.Time
	Cleanup      time.Time
}

type Outcome struct {
	Code      int
	Final     State
	States    []State
	Deadlines Deadlines
	Cause     error
}

type WorkerResult struct {
	Done     bool
	ExitCode int
}

// GroupObservation keeps the direct worker separate from ordinary group members.
// A direct worker zombie is still present, but can be reaped after all other
// members are absent.
type GroupObservation struct {
	OtherMember         bool
	DirectWorkerPresent bool
	DirectWorkerLive    bool
}

type Clock interface {
	Now() time.Time
	SleepUntil(time.Time) error
}

type ResultObserver interface {
	Observe(deadline time.Time) (WorkerResult, error)
}

type GroupInspector interface {
	Observe(groupID, workerPID int, deadline time.Time) (GroupObservation, error)
}

// DirectWorkerGroupVerifier verifies the unreaped direct worker before a
// process-group signal is sent. Production verification uses pbi_pgid.
type DirectWorkerGroupVerifier interface {
	VerifyDirectWorkerGroup(groupID, workerPID int, deadline time.Time) error
}

type Signaler interface {
	Signal(groupID int, signal syscall.Signal, deadline time.Time) error
}

type DirectReaper interface {
	Reap(workerPID int, deadline time.Time) (bool, error)
}

type OutputRelay interface {
	Relay(deadline time.Time) error
}

type SignalObserver interface {
	Pending() (syscall.Signal, bool)
}

type Supervisor struct {
	T0       time.Time
	Clock    Clock
	Results  ResultObserver
	Groups   GroupInspector
	Signaler Signaler
	Reaper   DirectReaper
	Relay    OutputRelay
	Signals  SignalObserver

	WorkerPID int
	PGID      int
}

type completionKind uint8

const (
	completionResult completionKind = iota
	completionTimeout
	completionProtocolFailure
)

type completion struct {
	kind       completionKind
	workerCode int
	err        error
}

func (supervisor Supervisor) Run() Outcome {
	if supervisor.Clock == nil {
		return Outcome{Code: 125, Final: CleanupUncertain, States: []State{Start, CleanupUncertain}}
	}

	t0 := supervisor.T0
	if t0.IsZero() {
		t0 = supervisor.Clock.Now()
	}
	outcome := Outcome{
		States: []State{Start},
		Deadlines: Deadlines{
			T0:      t0,
			Work:    t0.Add(workLimit),
			Attempt: t0.Add(attemptLimit),
		},
	}
	if supervisor.Results == nil || supervisor.Groups == nil || supervisor.Signaler == nil ||
		supervisor.Reaper == nil || supervisor.Relay == nil || supervisor.WorkerPID <= 0 ||
		supervisor.PGID != supervisor.WorkerPID {
		return supervisor.cleanupUncertain(outcome)
	}

	outcome.States = append(outcome.States, Working)
	var parentSignal syscall.Signal
	var finished completion

	for {
		supervisor.observeParent(&parentSignal)
		if parentSignal != 0 {
			finished = completion{kind: completionProtocolFailure}
			break
		}
		if !supervisor.Clock.Now().Before(outcome.Deadlines.Work) {
			finished = completion{kind: completionTimeout}
			break
		}

		result, err := supervisor.Results.Observe(outcome.Deadlines.Work)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			finished = completion{kind: completionProtocolFailure, err: err}
			break
		}
		if result.Done {
			if !supervisor.Clock.Now().Before(outcome.Deadlines.Work) {
				finished = completion{kind: completionTimeout}
			} else {
				finished = completion{kind: completionResult, workerCode: result.ExitCode}
			}
			break
		}

		if err := supervisor.sleepUntil(outcome.Deadlines.Work, &parentSignal); err != nil && !errors.Is(err, errDeadline) {
			finished = completion{kind: completionProtocolFailure, err: err}
			break
		}
	}

	return supervisor.cleanup(outcome, finished, &parentSignal)
}

func (supervisor Supervisor) cleanup(outcome Outcome, finished completion, parentSignal *syscall.Signal) Outcome {
	cleanupStart := supervisor.Clock.Now()
	outcome.Deadlines.CleanupStart = cleanupStart
	outcome.Deadlines.Term = earlier(cleanupStart.Add(termLimit), outcome.Deadlines.Attempt)
	outcome.Deadlines.Cleanup = earlier(cleanupStart.Add(cleanupLimit), outcome.Deadlines.Attempt)
	outcome.States = append(outcome.States, CleanupTerm)

	if err := supervisor.signalGroup(syscall.SIGTERM, outcome.Deadlines.Term, parentSignal); err != nil {
		if !errors.Is(err, errDeadline) {
			return supervisor.cleanupUncertain(outcome, fmt.Errorf("send SIGTERM: %w", err))
		}
		return supervisor.killAndFinish(outcome, finished, parentSignal)
	}

	if err := supervisor.waitForGroup(outcome.Deadlines.Term, parentSignal); err != nil {
		if !errors.Is(err, errDeadline) {
			return supervisor.cleanupUncertain(outcome, fmt.Errorf("observe worker group after SIGTERM: %w", err))
		}
		return supervisor.killAndFinish(outcome, finished, parentSignal)
	}
	return supervisor.finishCleanup(outcome, finished, parentSignal)
}

func (supervisor Supervisor) killAndFinish(outcome Outcome, finished completion, parentSignal *syscall.Signal) Outcome {
	outcome.States = append(outcome.States, CleanupKill)
	if err := supervisor.signalGroup(syscall.SIGKILL, outcome.Deadlines.Cleanup, parentSignal); err != nil {
		return supervisor.cleanupUncertain(outcome, fmt.Errorf("send SIGKILL: %w", err))
	}
	if err := supervisor.waitForGroup(outcome.Deadlines.Cleanup, parentSignal); err != nil {
		return supervisor.cleanupUncertain(outcome, fmt.Errorf("observe worker group after SIGKILL: %w", err))
	}
	return supervisor.finishCleanup(outcome, finished, parentSignal)
}

func (supervisor Supervisor) finishCleanup(outcome Outcome, finished completion, parentSignal *syscall.Signal) Outcome {
	outcome.States = append(outcome.States, VerifyGroup, ReapDirectWorker)
	if err := supervisor.waitForReap(outcome.Deadlines.Cleanup, parentSignal); err != nil {
		return supervisor.cleanupUncertain(outcome, fmt.Errorf("reap direct worker: %w", err))
	}

	outcome.States = append(outcome.States, RelayOutput)
	if err := supervisor.relayOutput(outcome.Deadlines.Cleanup, parentSignal); err != nil {
		return supervisor.cleanupUncertain(outcome, fmt.Errorf("relay captured output: %w", err))
	}
	if supervisor.Clock.Now().After(outcome.Deadlines.Cleanup) {
		return supervisor.cleanupUncertain(outcome, errDeadline)
	}

	supervisor.observeParent(parentSignal)
	if *parentSignal != 0 {
		outcome.Code = 128 + int(*parentSignal)
		outcome.Final = Interrupted
		outcome.States = append(outcome.States, Interrupted)
		return outcome
	}
	if finished.kind == completionProtocolFailure {
		return supervisor.cleanupUncertain(outcome, finished.err)
	}
	if finished.kind == completionTimeout || (finished.workerCode == 0 && !supervisor.Clock.Now().Before(outcome.Deadlines.Work)) {
		outcome.Code = 124
		outcome.Final = TimedOut
		outcome.States = append(outcome.States, TimedOut)
		return outcome
	}
	if finished.workerCode != 0 {
		outcome.Code = finished.workerCode
		outcome.Final = Failed
		outcome.States = append(outcome.States, Failed)
		return outcome
	}
	outcome.Final = Succeeded
	outcome.States = append(outcome.States, Succeeded)
	return outcome
}

func (supervisor Supervisor) cleanupUncertain(outcome Outcome, causes ...error) Outcome {
	outcome.Code = 125
	outcome.Final = CleanupUncertain
	if len(causes) > 0 {
		outcome.Cause = causes[0]
	}
	outcome.States = append(outcome.States, CleanupUncertain)
	return outcome
}

func (supervisor Supervisor) signalGroup(signal syscall.Signal, deadline time.Time, parentSignal *syscall.Signal) error {
	for {
		supervisor.observeParent(parentSignal)
		if !supervisor.Clock.Now().Before(deadline) {
			return errDeadline
		}
		if err := supervisor.verifyDirectWorkerGroup(deadline); err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			return fmt.Errorf("verify direct worker group before signal: %w", err)
		}
		if !supervisor.Clock.Now().Before(deadline) {
			return errDeadline
		}
		err := supervisor.Signaler.Signal(-supervisor.PGID, signal, deadline)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		// A Darwin group can contain only an unreaped direct-worker zombie,
		// which can reject a group signal. Neither ESRCH nor EPERM establishes
		// cleanup; waitForGroup independently verifies the group before reaping.
		if errors.Is(err, syscall.ESRCH) || errors.Is(err, syscall.EPERM) {
			return nil
		}
		return err
	}
}

func (supervisor Supervisor) verifyDirectWorkerGroup(deadline time.Time) error {
	if verifier, ok := supervisor.Groups.(DirectWorkerGroupVerifier); ok {
		return verifier.VerifyDirectWorkerGroup(supervisor.PGID, supervisor.WorkerPID, deadline)
	}
	_, err := supervisor.Groups.Observe(supervisor.PGID, supervisor.WorkerPID, deadline)
	return err
}

func (supervisor Supervisor) waitForGroup(deadline time.Time, parentSignal *syscall.Signal) error {
	for {
		supervisor.observeParent(parentSignal)
		if !supervisor.Clock.Now().Before(deadline) {
			return errDeadline
		}
		observation, err := supervisor.Groups.Observe(supervisor.PGID, supervisor.WorkerPID, deadline)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if !observation.OtherMember && !observation.DirectWorkerLive {
			return nil
		}
		if err := supervisor.sleepUntil(deadline, parentSignal); err != nil && !errors.Is(err, errDeadline) {
			return err
		}
	}
}

func (supervisor Supervisor) waitForReap(deadline time.Time, parentSignal *syscall.Signal) error {
	for {
		supervisor.observeParent(parentSignal)
		if !supervisor.Clock.Now().Before(deadline) {
			return errDeadline
		}
		reaped, err := supervisor.Reaper.Reap(supervisor.WorkerPID, deadline)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		if reaped {
			return nil
		}
		if err := supervisor.sleepUntil(deadline, parentSignal); err != nil && !errors.Is(err, errDeadline) {
			return err
		}
	}
}

func (supervisor Supervisor) relayOutput(deadline time.Time, parentSignal *syscall.Signal) error {
	for {
		supervisor.observeParent(parentSignal)
		if !supervisor.Clock.Now().Before(deadline) {
			return errDeadline
		}
		err := supervisor.Relay.Relay(deadline)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
			if err := supervisor.sleepUntil(deadline, parentSignal); err != nil && !errors.Is(err, errDeadline) {
				return err
			}
			continue
		}
		return err
	}
}

func (supervisor Supervisor) sleepUntil(deadline time.Time, parentSignal *syscall.Signal) error {
	for {
		supervisor.observeParent(parentSignal)
		if !supervisor.Clock.Now().Before(deadline) {
			return errDeadline
		}
		next := supervisor.Clock.Now().Add(pollInterval)
		if deadline.Before(next) {
			next = deadline
		}
		err := supervisor.Clock.SleepUntil(next)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		return err
	}
}

func (supervisor Supervisor) observeParent(parentSignal *syscall.Signal) {
	if *parentSignal != 0 || supervisor.Signals == nil {
		return
	}
	if signal, pending := supervisor.Signals.Pending(); pending {
		*parentSignal = signal
	}
}

func earlier(left, right time.Time) time.Time {
	if left.Before(right) {
		return left
	}
	return right
}
