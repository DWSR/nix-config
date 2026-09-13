//go:build darwin

package main

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"testing"
	"time"
)

const zombieChildEnvironment = "GIT_MCP_PROCESS_CONTROL_ZOMBIE_CHILD"

func TestProcessControlZombieChild(t *testing.T) {
	if os.Getenv(zombieChildEnvironment) != "1" {
		return
	}

	barrier := os.NewFile(uintptr(3), "zombie-child-barrier")
	if barrier == nil {
		os.Exit(2)
	}
	_, _ = io.Copy(io.Discard, barrier)
	_ = barrier.Close()
	os.Exit(0)
}

func TestZombieOwnershipStateRemainsUncertainUntilParentReaps(t *testing.T) {
	barrierRead, barrierWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer barrierWrite.Close()

	child := exec.Command(os.Args[0], "-test.run=^TestProcessControlZombieChild$")
	child.Env = append(os.Environ(), zombieChildEnvironment+"=1")
	child.ExtraFiles = []*os.File{barrierRead}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	if err := barrierRead.Close(); err != nil {
		t.Fatal(err)
	}

	reaped := false
	defer func() {
		if !reaped {
			_ = child.Process.Kill()
			_, _ = child.Process.Wait()
		}
	}()

	live, absent, err := inspectProcess(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if absent {
		t.Fatalf("child %d exited before ownership capture", child.Process.Pid)
	}
	record := ownershipRecord{
		processIdentity:    live.processIdentity,
		ExpectedExecutable: live.Executable,
		Role:               "zombie-regression",
		SessionToken:       "zombie-regression-token",
	}

	if err := barrierWrite.Close(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		observed, absent, err := readProcessInfo(child.Process.Pid)
		if err != nil {
			t.Fatal(err)
		}
		if absent {
			t.Fatalf("child %d became absent before its parent reaped it", child.Process.Pid)
		}
		if observed.zombie {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("child %d did not become an observable zombie", child.Process.Pid)
		}
		time.Sleep(time.Millisecond)
	}

	state, err := observedOwnershipState(record)
	if err != nil {
		t.Fatal(err)
	}
	if state != "zombie" {
		t.Fatalf("ownership state = %q, want zombie", state)
	}
	if gone, err := recordsAreGone([]ownershipRecord{record}); err != nil {
		t.Fatal(err)
	} else if gone {
		t.Fatal("zombie ownership record was treated as gone")
	}
	if err := terminateOwnedRecords([]ownershipRecord{record}, time.Now().Add(50*time.Millisecond)); err == nil {
		t.Fatal("cleanup succeeded while the owned process remained a zombie")
	}
	if err := run([]string{"inspect", strconv.Itoa(child.Process.Pid)}); err == nil {
		t.Fatal("inspect succeeded for an observable zombie")
	} else {
		var commandErr *commandError
		if errors.As(err, &commandErr) && commandErr.code == absentExitCode {
			t.Fatal("inspect reported an observable zombie as absent")
		}
	}

	if err := child.Wait(); err != nil {
		t.Fatal(err)
	}
	reaped = true

	err = run([]string{"inspect", strconv.Itoa(child.Process.Pid)})
	var commandErr *commandError
	if !errors.As(err, &commandErr) || commandErr.code != absentExitCode {
		t.Fatalf("reaped child inspect error = %v, want exit %d", err, absentExitCode)
	}
}
