//go:build darwin

package supervisor

import (
	"errors"
	"os"
	"syscall"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/darwinproc"
)

type realClock struct{}

func (realClock) Now() time.Time {
	return time.Now()
}

func (realClock) SleepUntil(deadline time.Time) error {
	if delay := time.Until(deadline); delay > 0 {
		time.Sleep(delay)
	}
	return nil
}

type darwinGroupInspector struct{}

func (darwinGroupInspector) VerifyDirectWorkerGroup(groupID, workerPID int, deadline time.Time) error {
	return darwinproc.VerifyDirectWorkerGroup(groupID, workerPID, deadline)
}

func (darwinGroupInspector) Observe(groupID, workerPID int, deadline time.Time) (GroupObservation, error) {
	observation, err := darwinproc.ObserveGroup(groupID, workerPID, deadline)
	return GroupObservation{
		OtherMember:         observation.OtherMember,
		DirectWorkerPresent: observation.DirectWorkerPresent,
		DirectWorkerLive:    observation.DirectWorkerLive,
	}, err
}

type syscallSignaler struct{}

func (syscallSignaler) Signal(groupID int, signal syscall.Signal, _ time.Time) error {
	if groupID >= 0 {
		return errors.New("supervisor must signal a negative process-group ID")
	}
	return syscall.Kill(groupID, signal)
}

type directWorkerReaper struct{}

func (directWorkerReaper) Reap(workerPID int, _ time.Time) (bool, error) {
	var status syscall.WaitStatus
	reapedPID, err := syscall.Wait4(workerPID, &status, syscall.WNOHANG, nil)
	if err != nil {
		return false, err
	}
	return reapedPID == workerPID, nil
}

func NewDarwinSupervisor(t0 time.Time, workerPID int, results ResultObserver, relay OutputRelay, signals SignalObserver) Supervisor {
	return Supervisor{
		T0:        t0,
		Clock:     realClock{},
		Results:   results,
		Groups:    darwinGroupInspector{},
		Signaler:  syscallSignaler{},
		Reaper:    directWorkerReaper{},
		Relay:     relay,
		Signals:   signals,
		WorkerPID: workerPID,
		PGID:      workerPID,
	}
}

type queuedSignalObserver struct {
	signals <-chan os.Signal
	pending syscall.Signal
}

func NewSignalObserver(signals <-chan os.Signal) SignalObserver {
	return &queuedSignalObserver{signals: signals}
}

func (observer *queuedSignalObserver) Pending() (syscall.Signal, bool) {
	if observer.pending != 0 {
		return observer.pending, true
	}
	select {
	case signal := <-observer.signals:
		value, ok := signal.(syscall.Signal)
		if !ok || value == 0 {
			return 0, false
		}
		observer.pending = value
		return value, true
	default:
		return 0, false
	}
}
