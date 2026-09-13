//go:build darwin

package supervisor

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/darwinproc"
)

const supervisorHelperEnvironment = "GIT_MCP_SIGNER_SUPERVISOR_HELPER"

func TestSupervisorKillsAndVerifiesRealWorkerGroup(t *testing.T) {
	barrierReader, barrierWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer barrierReader.Close()
	releaseReader, releaseWriter, err := os.Pipe()
	if err != nil {
		_ = barrierWriter.Close()
		t.Fatal(err)
	}
	defer releaseWriter.Close()

	worker := exec.Command(os.Args[0], "-test.run=^TestSupervisorHelperProcess$")
	worker.Env = append(os.Environ(), supervisorHelperEnvironment+"=worker")
	worker.ExtraFiles = []*os.File{barrierWriter, releaseReader}
	worker.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := worker.Start(); err != nil {
		barrierWriter.Close()
		releaseReader.Close()
		t.Fatal(err)
	}
	if err := barrierWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := releaseReader.Close(); err != nil {
		t.Fatal(err)
	}

	workerPID := worker.Process.Pid
	reaped := false
	t.Cleanup(func() {
		if reaped {
			return
		}
		_ = syscall.Kill(-workerPID, syscall.SIGKILL)
		_, _ = syscall.Wait4(workerPID, nil, 0, nil)
	})

	readSupervisorBarrier(t, barrierReader, "M")
	if groupID, err := darwinproc.ProcessGroupID(workerPID); err != nil || groupID != workerPID {
		t.Fatalf("worker process group = (%d, %v), want (%d, nil)", groupID, err, workerPID)
	}
	if sessionID, err := darwinproc.SessionID(workerPID); err != nil || sessionID != workerPID {
		t.Fatalf("worker session = (%d, %v), want (%d, nil)", sessionID, err, workerPID)
	}
	termIssued := make(chan struct{}, 1)
	killIssued := make(chan struct{}, 1)
	runner := Supervisor{
		Clock:   realClock{},
		Results: resultObserverFunc(func(time.Time) (WorkerResult, error) { return WorkerResult{Done: true, ExitCode: 0}, nil }),
		Groups:  darwinGroupInspector{},
		Signaler: signalerFunc(func(groupID int, signal syscall.Signal, deadline time.Time) error {
			err := syscallSignaler{}.Signal(groupID, signal, deadline)
			if err != nil {
				return err
			}
			switch signal {
			case syscall.SIGTERM:
				termIssued <- struct{}{}
			case syscall.SIGKILL:
				killIssued <- struct{}{}
			}
			return nil
		}),
		Reaper:    directWorkerReaper{},
		Relay:     relayFunc(func(time.Time) error { return nil }),
		Signals:   signalObserverFunc(func() (syscall.Signal, bool) { return 0, false }),
		WorkerPID: workerPID,
		PGID:      workerPID,
	}

	outcomes := make(chan Outcome, 1)
	go func() {
		outcomes <- runner.Run()
	}()
	awaitSupervisorSignal(t, termIssued, "SIGTERM")
	readSupervisorBarrier(t, barrierReader, "T")
	if _, err := releaseWriter.Write([]byte("L")); err != nil {
		t.Fatal(err)
	}
	if err := releaseWriter.Close(); err != nil {
		t.Fatal(err)
	}
	readSupervisorBarrier(t, barrierReader, "L")
	awaitSupervisorSignal(t, killIssued, "SIGKILL")
	outcome := awaitSupervisorOutcome(t, outcomes)
	reaped = outcome.Code == 0
	if outcome.Code != 0 || outcome.Final != Succeeded {
		t.Fatalf("outcome = %#v, cause = %v, want clean group cleanup", outcome, outcome.Cause)
	}
	if !containsState(outcome.States, CleanupKill) {
		t.Fatalf("states = %#v, want SIGKILL phase for TERM-resistant group member", outcome.States)
	}
	var status syscall.WaitStatus
	if _, err := syscall.Wait4(workerPID, &status, syscall.WNOHANG, nil); !errors.Is(err, syscall.ECHILD) {
		t.Fatalf("direct worker was not reaped exactly once: %v", err)
	}
	if err := syscall.Kill(-workerPID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("worker group remains after SIGKILL and direct-worker reaping: %v", err)
	}
}

func TestSupervisorHelperProcess(t *testing.T) {
	role := os.Getenv(supervisorHelperEnvironment)
	if role == "" {
		return
	}

	barrier := os.NewFile(3, "supervisor-helper-barrier")
	if barrier == nil {
		os.Exit(2)
	}
	defer barrier.Close()

	switch role {
	case "worker":
		release := os.NewFile(4, "supervisor-helper-release")
		if release == nil {
			os.Exit(3)
		}
		defer release.Close()
		term := make(chan os.Signal, 1)
		signal.Notify(term, syscall.SIGTERM)
		defer signal.Stop(term)
		member := exec.Command(os.Args[0], "-test.run=^TestSupervisorHelperProcess$")
		member.Env = append(os.Environ(), supervisorHelperEnvironment+"=member")
		member.ExtraFiles = []*os.File{barrier, release}
		if err := member.Start(); err != nil {
			_, _ = barrier.Write([]byte("E"))
			os.Exit(4)
		}
		<-term
		select {}
	case "member":
		release := os.NewFile(4, "supervisor-helper-release")
		if release == nil {
			os.Exit(5)
		}
		defer release.Close()
		term := make(chan os.Signal, 1)
		signal.Notify(term, syscall.SIGTERM)
		defer signal.Stop(term)
		if _, err := barrier.Write([]byte("M")); err != nil {
			os.Exit(6)
		}
		<-term
		if _, err := barrier.Write([]byte("T")); err != nil {
			os.Exit(7)
		}
		var releaseToken [1]byte
		if _, err := io.ReadFull(release, releaseToken[:]); err != nil || releaseToken[0] != 'L' {
			os.Exit(8)
		}
		late := exec.Command(os.Args[0], "-test.run=^TestSupervisorHelperProcess$")
		late.Env = append(os.Environ(), supervisorHelperEnvironment+"=late")
		late.ExtraFiles = []*os.File{barrier}
		if err := late.Start(); err != nil {
			os.Exit(9)
		}
		select {}
	case "late":
		if _, err := barrier.Write([]byte("L")); err != nil {
			os.Exit(10)
		}
		select {}
	default:
		os.Exit(11)
	}
}

func awaitSupervisorSignal(t *testing.T, signals <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signals:
	case <-time.After(5 * time.Second):
		t.Fatalf("supervisor did not issue %s", name)
	}
}

func awaitSupervisorOutcome(t *testing.T, outcomes <-chan Outcome) Outcome {
	t.Helper()
	select {
	case outcome := <-outcomes:
		return outcome
	case <-time.After(5 * time.Second):
		t.Fatal("supervisor did not complete bounded cleanup")
		return Outcome{}
	}
}

func readSupervisorBarrier(t *testing.T, reader io.Reader, want string) {
	t.Helper()
	result := make(chan error, 1)
	value := make([]byte, 1)
	go func() {
		_, err := io.ReadFull(reader, value)
		result <- err
	}()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
		if string(value) != want {
			t.Fatalf("helper barrier = %q, want %q", value, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for helper barrier %q", want)
	}
}

func containsState(states []State, want State) bool {
	for _, state := range states {
		if state == want {
			return true
		}
	}
	return false
}
