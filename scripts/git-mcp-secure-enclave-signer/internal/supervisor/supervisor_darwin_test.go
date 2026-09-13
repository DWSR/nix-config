//go:build darwin

package supervisor

import (
	"errors"
	"fmt"
	"reflect"
	"syscall"
	"testing"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/darwinproc"
)

func TestSupervisorSucceedsOnlyAfterGroupVerificationReapingAndRelay(t *testing.T) {
	clock, harness, runner := newHarness()
	harness.group = func(groupID, workerPID int, deadline time.Time) (GroupObservation, error) {
		if groupID != runner.PGID || workerPID != runner.WorkerPID {
			t.Fatalf("group inspection = (%d, %d), want (%d, %d)", groupID, workerPID, runner.PGID, runner.WorkerPID)
		}
		if deadline != clock.now.Add(time.Second) {
			t.Fatalf("group deadline = %v, want TERM deadline %v", deadline, clock.now.Add(time.Second))
		}
		harness.trace = append(harness.trace, "group")
		return GroupObservation{}, nil
	}
	harness.reaper = func(workerPID int, deadline time.Time) (bool, error) {
		if workerPID != runner.WorkerPID {
			t.Fatalf("reaper worker = %d, want %d", workerPID, runner.WorkerPID)
		}
		harness.trace = append(harness.trace, "reap")
		return true, nil
	}
	harness.relay = func(deadline time.Time) error {
		harness.trace = append(harness.trace, "relay")
		return nil
	}

	outcome := runner.Run()

	if outcome.Code != 0 || outcome.Final != Succeeded {
		t.Fatalf("outcome = %#v, want successful completion", outcome)
	}
	assertStates(t, outcome, []State{
		Start,
		Working,
		CleanupTerm,
		VerifyGroup,
		ReapDirectWorker,
		RelayOutput,
		Succeeded,
	})
	assertDeadlines(t, outcome, clock.origin, clock.origin.Add(20*time.Second), clock.origin.Add(22*time.Second), clock.origin, clock.origin.Add(time.Second), clock.origin.Add(2*time.Second))
	if want := []signalCall{{groupID: -runner.PGID, signal: syscall.SIGTERM}}; !reflect.DeepEqual(harness.signals, want) {
		t.Fatalf("signals = %#v, want %#v", harness.signals, want)
	}
	if want := []string{"group", "term", "group", "reap", "relay"}; !reflect.DeepEqual(harness.trace, want) {
		t.Fatalf("cleanup order = %#v, want %#v", harness.trace, want)
	}
}

func TestSupervisorTimesOutAtTheWorkDeadline(t *testing.T) {
	t.Run("exact worker result", func(t *testing.T) {
		clock, harness, runner := newHarness()
		workDeadline := clock.origin.Add(20 * time.Second)
		harness.result = func(deadline time.Time) (WorkerResult, error) {
			if deadline != workDeadline {
				t.Fatalf("result deadline = %v, want %v", deadline, workDeadline)
			}
			clock.now = workDeadline
			return WorkerResult{Done: true, ExitCode: 0}, nil
		}

		outcome := runner.Run()

		if outcome.Code != 124 || outcome.Final != TimedOut {
			t.Fatalf("outcome = %#v, want exact-deadline timeout", outcome)
		}
		assertDeadlines(t, outcome, clock.origin, workDeadline, clock.origin.Add(22*time.Second), workDeadline, workDeadline.Add(time.Second), workDeadline.Add(2*time.Second))
	})

	t.Run("successful result with cleanup at work deadline", func(t *testing.T) {
		clock, harness, runner := newHarness()
		workDeadline := clock.origin.Add(20 * time.Second)
		harness.result = func(time.Time) (WorkerResult, error) {
			clock.now = workDeadline.Add(-time.Second)
			return WorkerResult{Done: true, ExitCode: 0}, nil
		}
		harness.group = func(int, int, time.Time) (GroupObservation, error) {
			clock.now = workDeadline
			return GroupObservation{}, nil
		}

		outcome := runner.Run()

		if outcome.Code != 124 || outcome.Final != TimedOut {
			t.Fatalf("outcome = %#v, want cleanup-crossing timeout", outcome)
		}
	})
}

func TestSupervisorPreservesPreDeadlineWorkerFailureAfterCleanCleanup(t *testing.T) {
	_, harness, runner := newHarness()
	harness.result = func(time.Time) (WorkerResult, error) {
		return WorkerResult{Done: true, ExitCode: 17}, nil
	}

	outcome := runner.Run()

	if outcome.Code != 17 || outcome.Final != Failed {
		t.Fatalf("outcome = %#v, want worker failure", outcome)
	}
}

func TestSupervisorParentInterruptionOutranksWorkerResult(t *testing.T) {
	_, harness, runner := newHarness()
	harness.result = func(time.Time) (WorkerResult, error) {
		return WorkerResult{Done: true, ExitCode: 0}, nil
	}
	pendingCalls := 0
	harness.pending = func() (syscall.Signal, bool) {
		pendingCalls++
		if pendingCalls == 2 {
			return syscall.SIGINT, true
		}
		return 0, false
	}

	outcome := runner.Run()

	if outcome.Code != 128+int(syscall.SIGINT) || outcome.Final != Interrupted {
		t.Fatalf("outcome = %#v, want clean interruption", outcome)
	}
}

func TestSupervisorReturnsCleanupUncertainForIncompleteCleanup(t *testing.T) {
	cases := []struct {
		name  string
		setup func(*fakeClock, *harness, *Supervisor)
	}{
		{
			name: "failed group observation",
			setup: func(_ *fakeClock, harness *harness, _ *Supervisor) {
				harness.group = func(int, int, time.Time) (GroupObservation, error) {
					return GroupObservation{}, errors.New("proc_pidinfo failed")
				}
			},
		},
		{
			name: "persistent zombie",
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor) {
				harness.group = func(int, int, time.Time) (GroupObservation, error) {
					clock.now = clock.origin.Add(2 * time.Second)
					return GroupObservation{OtherMember: true}, nil
				}
			},
		},
		{
			name: "direct worker cannot be reaped",
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor) {
				harness.reaper = func(int, time.Time) (bool, error) {
					clock.now = clock.origin.Add(2 * time.Second)
					return false, nil
				}
			},
		},
		{
			name: "output relay fails",
			setup: func(_ *fakeClock, harness *harness, _ *Supervisor) {
				harness.relay = func(time.Time) error {
					return errors.New("captured stderr relay failed")
				}
			},
		},
		{
			name: "output relay remains incomplete",
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor) {
				harness.relay = func(time.Time) error {
					return syscall.EAGAIN
				}
				clock.sleep = func(time.Time) error {
					clock.now = clock.origin.Add(2 * time.Second)
					return nil
				}
			},
		},
		{
			name: "interruption with cleanup uncertainty",
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor) {
				pendingCalls := 0
				harness.pending = func() (syscall.Signal, bool) {
					pendingCalls++
					if pendingCalls == 1 {
						return syscall.SIGTERM, true
					}
					return 0, false
				}
				harness.group = func(int, int, time.Time) (GroupObservation, error) {
					clock.now = clock.origin.Add(2 * time.Second)
					return GroupObservation{OtherMember: true}, nil
				}
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			clock, harness, runner := newHarness()
			testCase.setup(clock, harness, runner)

			outcome := runner.Run()

			if outcome.Code != 125 || outcome.Final != CleanupUncertain {
				t.Fatalf("outcome = %#v, want cleanup uncertainty", outcome)
			}
		})
	}
}

func TestSupervisorFailsClosedForIncompleteExtraMemberProcessInfo(t *testing.T) {
	cases := []struct {
		name string
	}{
		{name: "short-byte ESRCH"},
		{name: "negative-byte ESRCH"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, harness, runner := newHarness()
			runner.Groups = verifiedGroupInspector{
				observe: func(int, int, time.Time) (GroupObservation, error) {
					return GroupObservation{}, fmt.Errorf("extra member proc_pidinfo %s: %w", testCase.name, syscall.ESRCH)
				},
			}
			reaperCalls := 0
			harness.reaper = func(int, time.Time) (bool, error) {
				reaperCalls++
				return true, nil
			}
			relayCalls := 0
			harness.relay = func(time.Time) error {
				relayCalls++
				return nil
			}

			outcome := runner.Run()

			if outcome.Code != 125 || outcome.Final != CleanupUncertain {
				t.Fatalf("outcome = %#v, want cleanup uncertainty", outcome)
			}
			if want := []signalCall{{groupID: -runner.PGID, signal: syscall.SIGTERM}}; !reflect.DeepEqual(harness.signals, want) {
				t.Fatalf("signals = %#v, want %#v", harness.signals, want)
			}
			if reaperCalls != 0 || relayCalls != 0 || containsState(outcome.States, Succeeded) {
				t.Fatalf("false successful cleanup: reaper calls = %d, relay calls = %d, states = %#v", reaperCalls, relayCalls, outcome.States)
			}
		})
	}
}

func TestSupervisorKillsLateGroupMemberBeforeReaping(t *testing.T) {
	clock, harness, runner := newHarness()
	groupCalls := 0
	harness.group = func(int, int, time.Time) (GroupObservation, error) {
		groupCalls++
		harness.trace = append(harness.trace, "group")
		switch groupCalls {
		case 1:
			return GroupObservation{OtherMember: true}, nil
		case 2:
			clock.now = clock.origin.Add(time.Second)
			return GroupObservation{OtherMember: true}, nil
		case 3:
			return GroupObservation{OtherMember: true}, nil
		case 4:
			return GroupObservation{}, nil
		default:
			t.Fatalf("unexpected group observation %d", groupCalls)
			return GroupObservation{}, nil
		}
	}
	harness.reaper = func(int, time.Time) (bool, error) {
		harness.trace = append(harness.trace, "reap")
		return true, nil
	}

	outcome := runner.Run()

	if outcome.Code != 0 || outcome.Final != Succeeded {
		t.Fatalf("outcome = %#v, want clean late-member cleanup", outcome)
	}
	if want := []signalCall{
		{groupID: -runner.PGID, signal: syscall.SIGTERM},
		{groupID: -runner.PGID, signal: syscall.SIGKILL},
	}; !reflect.DeepEqual(harness.signals, want) {
		t.Fatalf("signals = %#v, want %#v", harness.signals, want)
	}
	if indexOf(harness.trace, "kill") > indexOf(harness.trace, "reap") {
		t.Fatalf("reaped direct worker before removing late group member: %#v", harness.trace)
	}
}

func TestSupervisorKillsAfterTERMGroupSnapshotDeadline(t *testing.T) {
	clock, harness, runner := newHarness()
	inspector := &termSnapshotDeadlineInspector{
		t:       t,
		clock:   clock,
		term:    clock.origin.Add(time.Second),
		cleanup: clock.origin.Add(2 * time.Second),
	}
	runner.Groups = inspector

	signalCalls := 0
	harness.signal = func(_ int, _ syscall.Signal, deadline time.Time) error {
		signalCalls++
		if len(inspector.verificationDeadlines) != signalCalls {
			t.Fatalf("signal %d issued without fresh direct-worker verification: %#v", signalCalls, inspector.verificationDeadlines)
		}
		if inspector.verificationDeadlines[signalCalls-1] != deadline {
			t.Fatalf("signal %d verification deadline = %v, want %v", signalCalls, inspector.verificationDeadlines[signalCalls-1], deadline)
		}
		return nil
	}

	reaped := false
	harness.reaper = func(_ int, deadline time.Time) (bool, error) {
		if deadline != inspector.cleanup {
			t.Fatalf("reap deadline = %v, want cleanup deadline %v", deadline, inspector.cleanup)
		}
		reaped = true
		return true, nil
	}
	relayed := false
	harness.relay = func(deadline time.Time) error {
		if deadline != inspector.cleanup {
			t.Fatalf("relay deadline = %v, want cleanup deadline %v", deadline, inspector.cleanup)
		}
		relayed = true
		return nil
	}

	outcome := runner.Run()

	if outcome.Code != 0 || outcome.Final != Succeeded {
		t.Fatalf("outcome = %#v, want clean pre-work success after verified SIGKILL", outcome)
	}
	assertStates(t, outcome, []State{
		Start,
		Working,
		CleanupTerm,
		CleanupKill,
		VerifyGroup,
		ReapDirectWorker,
		RelayOutput,
		Succeeded,
	})
	if want := []signalCall{
		{groupID: -runner.PGID, signal: syscall.SIGTERM},
		{groupID: -runner.PGID, signal: syscall.SIGKILL},
	}; !reflect.DeepEqual(harness.signals, want) {
		t.Fatalf("signals = %#v, want %#v", harness.signals, want)
	}
	if want := []time.Time{inspector.term, inspector.cleanup}; !reflect.DeepEqual(inspector.verificationDeadlines, want) {
		t.Fatalf("verification deadlines = %#v, want %#v", inspector.verificationDeadlines, want)
	}
	if inspector.snapshotCalls != 2 || !reaped || !relayed {
		t.Fatalf("snapshot calls = %d, reaped = %t, relayed = %t; want group absence, direct reaping, and output relay", inspector.snapshotCalls, reaped, relayed)
	}
}

func TestSupervisorVerifiesAnEPERMGroupSignalBeforePermittingSuccess(t *testing.T) {
	t.Run("clean observed group", func(t *testing.T) {
		_, harness, runner := newHarness()
		harness.signal = func(int, syscall.Signal, time.Time) error {
			return syscall.EPERM
		}
		harness.group = func(int, int, time.Time) (GroupObservation, error) {
			return GroupObservation{DirectWorkerPresent: true}, nil
		}

		outcome := runner.Run()

		if outcome.Code != 0 || outcome.Final != Succeeded {
			t.Fatalf("outcome = %#v, want success after independent group verification", outcome)
		}
	})

	t.Run("member remains", func(t *testing.T) {
		clock, harness, runner := newHarness()
		harness.signal = func(int, syscall.Signal, time.Time) error {
			return syscall.EPERM
		}
		harness.group = func(int, int, time.Time) (GroupObservation, error) {
			clock.now = clock.origin.Add(2 * time.Second)
			return GroupObservation{OtherMember: true}, nil
		}

		outcome := runner.Run()

		if outcome.Code != 125 || outcome.Final != CleanupUncertain {
			t.Fatalf("outcome = %#v, want cleanup uncertainty for unverified group", outcome)
		}
	})
}

func TestSupervisorDoesNotSignalAnUnverifiedDirectWorkerGroup(t *testing.T) {
	t.Run("configured PGID differs from direct worker", func(t *testing.T) {
		_, harness, runner := newHarness()
		runner.PGID++

		outcome := runner.Run()

		if outcome.Code != 125 || outcome.Final != CleanupUncertain {
			t.Fatalf("outcome = %#v, want cleanup uncertainty", outcome)
		}
		if len(harness.signals) != 0 {
			t.Fatalf("signaled a group other than the direct worker PID: %#v", harness.signals)
		}
	})

	t.Run("before SIGTERM", func(t *testing.T) {
		_, harness, runner := newHarness()
		harness.group = func(int, int, time.Time) (GroupObservation, error) {
			return GroupObservation{}, errors.New("direct worker pbi_pgid is not the worker process group")
		}

		outcome := runner.Run()

		if outcome.Code != 125 || outcome.Final != CleanupUncertain {
			t.Fatalf("outcome = %#v, want cleanup uncertainty", outcome)
		}
		if len(harness.signals) != 0 {
			t.Fatalf("signaled an unverified direct worker group: %#v", harness.signals)
		}
	})

	t.Run("before SIGKILL", func(t *testing.T) {
		clock, harness, runner := newHarness()
		observations := 0
		harness.group = func(int, int, time.Time) (GroupObservation, error) {
			observations++
			switch observations {
			case 1:
				return GroupObservation{}, nil
			case 2:
				clock.now = clock.origin.Add(time.Second)
				return GroupObservation{OtherMember: true}, nil
			case 3:
				return GroupObservation{}, errors.New("direct worker has no process group record")
			default:
				t.Fatalf("unexpected group observation %d", observations)
				return GroupObservation{}, nil
			}
		}

		outcome := runner.Run()

		if outcome.Code != 125 || outcome.Final != CleanupUncertain {
			t.Fatalf("outcome = %#v, want cleanup uncertainty", outcome)
		}
		if !containsState(outcome.States, CleanupKill) {
			t.Fatalf("states = %#v, want SIGKILL phase", outcome.States)
		}
		want := []signalCall{{groupID: -runner.PGID, signal: syscall.SIGTERM}}
		if !reflect.DeepEqual(harness.signals, want) {
			t.Fatalf("signals = %#v, want %#v", harness.signals, want)
		}
	})
}

func TestSupervisorBoundsEveryEINTRRetry(t *testing.T) {
	cases := []struct {
		name     string
		wantCode int
		setup    func(*fakeClock, *harness, *Supervisor, *int)
	}{
		{
			name:     "result observation",
			wantCode: 124,
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor, calls *int) {
				harness.result = func(deadline time.Time) (WorkerResult, error) {
					*calls++
					if deadline != clock.origin.Add(20*time.Second) {
						t.Fatalf("result deadline = %v", deadline)
					}
					clock.now = deadline
					return WorkerResult{}, syscall.EINTR
				}
			},
		},
		{
			name:     "group observation",
			wantCode: 125,
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor, calls *int) {
				harness.group = func(_ int, _ int, deadline time.Time) (GroupObservation, error) {
					*calls++
					if deadline != clock.origin.Add(time.Second) {
						t.Fatalf("group deadline = %v", deadline)
					}
					clock.now = clock.origin.Add(2 * time.Second)
					return GroupObservation{}, syscall.EINTR
				}
			},
		},
		{
			name:     "term signal",
			wantCode: 125,
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor, calls *int) {
				harness.signal = func(_ int, _ syscall.Signal, deadline time.Time) error {
					*calls++
					if deadline != clock.origin.Add(time.Second) {
						t.Fatalf("TERM deadline = %v", deadline)
					}
					clock.now = clock.origin.Add(2 * time.Second)
					return syscall.EINTR
				}
			},
		},
		{
			name:     "termination wait",
			wantCode: 125,
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor, calls *int) {
				harness.group = func(int, int, time.Time) (GroupObservation, error) {
					return GroupObservation{OtherMember: true}, nil
				}
				clock.sleep = func(time.Time) error {
					*calls++
					clock.now = clock.origin.Add(2 * time.Second)
					return syscall.EINTR
				}
			},
		},
		{
			name:     "direct reaping",
			wantCode: 125,
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor, calls *int) {
				harness.reaper = func(_ int, deadline time.Time) (bool, error) {
					*calls++
					if deadline != clock.origin.Add(2*time.Second) {
						t.Fatalf("reap deadline = %v", deadline)
					}
					clock.now = deadline
					return false, syscall.EINTR
				}
			},
		},
		{
			name:     "output relay",
			wantCode: 125,
			setup: func(clock *fakeClock, harness *harness, _ *Supervisor, calls *int) {
				harness.relay = func(deadline time.Time) error {
					*calls++
					if deadline != clock.origin.Add(2*time.Second) {
						t.Fatalf("relay deadline = %v", deadline)
					}
					clock.now = deadline
					return syscall.EINTR
				}
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			clock, harness, runner := newHarness()
			calls := 0
			testCase.setup(clock, harness, runner, &calls)

			outcome := runner.Run()

			if outcome.Code != testCase.wantCode {
				t.Fatalf("outcome = %#v, want exit %d", outcome, testCase.wantCode)
			}
			if calls != 1 {
				t.Fatalf("interrupted operation retried %d times after its deadline", calls)
			}
			if outcome.Deadlines.Cleanup != clock.origin.Add(2*time.Second) && testCase.wantCode == 125 {
				t.Fatalf("cleanup deadline = %v, want immutable %v", outcome.Deadlines.Cleanup, clock.origin.Add(2*time.Second))
			}
		})
	}
}

func TestSupervisorChecksParentSignalBeforeRetryingEINTR(t *testing.T) {
	_, harness, runner := newHarness()
	resultCalls := 0
	harness.result = func(time.Time) (WorkerResult, error) {
		resultCalls++
		return WorkerResult{}, syscall.EINTR
	}
	pendingCalls := 0
	harness.pending = func() (syscall.Signal, bool) {
		pendingCalls++
		if pendingCalls == 2 {
			return syscall.SIGINT, true
		}
		return 0, false
	}

	outcome := runner.Run()

	if outcome.Code != 128+int(syscall.SIGINT) || outcome.Final != Interrupted {
		t.Fatalf("outcome = %#v, want interrupted cleanup", outcome)
	}
	if resultCalls != 1 {
		t.Fatalf("result observer retried after pending interruption: %d calls", resultCalls)
	}
}

func TestSupervisorClipsCleanupDeadlinesToAttemptDeadline(t *testing.T) {
	clock, harness, runner := newHarness()
	attemptDeadline := clock.origin.Add(22 * time.Second)
	harness.result = func(time.Time) (WorkerResult, error) {
		clock.now = attemptDeadline.Add(-500 * time.Millisecond)
		return WorkerResult{Done: true, ExitCode: 0}, nil
	}

	outcome := runner.Run()

	if outcome.Code != 124 || outcome.Final != TimedOut {
		t.Fatalf("outcome = %#v, want timed out result after work deadline", outcome)
	}
	assertDeadlines(t, outcome, clock.origin, clock.origin.Add(20*time.Second), attemptDeadline, attemptDeadline.Add(-500*time.Millisecond), attemptDeadline, attemptDeadline)
}

func TestSupervisorReturnsTimeoutWhenCleanupCompletesAtTheExactDeadline(t *testing.T) {
	clock, harness, runner := newHarness()
	workDeadline := clock.origin.Add(20 * time.Second)
	cleanupDeadline := clock.origin.Add(22 * time.Second)
	harness.result = func(time.Time) (WorkerResult, error) {
		clock.now = workDeadline
		return WorkerResult{Done: true, ExitCode: 0}, nil
	}
	harness.relay = func(deadline time.Time) error {
		if deadline != cleanupDeadline {
			t.Fatalf("relay deadline = %v, want %v", deadline, cleanupDeadline)
		}
		clock.now = cleanupDeadline
		return nil
	}

	outcome := runner.Run()

	if outcome.Code != 124 || outcome.Final != TimedOut {
		t.Fatalf("outcome = %#v, want exact-cleanup timeout", outcome)
	}
}

type fakeClock struct {
	origin time.Time
	now    time.Time
	sleeps []time.Time
	sleep  func(time.Time) error
}

func (clock *fakeClock) Now() time.Time {
	return clock.now
}

func (clock *fakeClock) SleepUntil(deadline time.Time) error {
	clock.sleeps = append(clock.sleeps, deadline)
	if clock.sleep != nil {
		return clock.sleep(deadline)
	}
	clock.now = deadline
	return nil
}

type harness struct {
	result  func(time.Time) (WorkerResult, error)
	group   func(int, int, time.Time) (GroupObservation, error)
	signal  func(int, syscall.Signal, time.Time) error
	reaper  func(int, time.Time) (bool, error)
	relay   func(time.Time) error
	pending func() (syscall.Signal, bool)

	signals []signalCall
	trace   []string
}

func newHarness() (*fakeClock, *harness, *Supervisor) {
	origin := time.Unix(1_700_000_000, 0)
	clock := &fakeClock{origin: origin, now: origin}
	harness := &harness{
		result: func(time.Time) (WorkerResult, error) {
			return WorkerResult{Done: true, ExitCode: 0}, nil
		},
		group: func(int, int, time.Time) (GroupObservation, error) {
			return GroupObservation{}, nil
		},
		reaper: func(int, time.Time) (bool, error) {
			return true, nil
		},
		relay: func(time.Time) error {
			return nil
		},
		pending: func() (syscall.Signal, bool) {
			return 0, false
		},
	}
	runner := &Supervisor{
		Clock:   clock,
		Results: resultObserverFunc(func(deadline time.Time) (WorkerResult, error) { return harness.result(deadline) }),
		Groups: groupInspectorFunc(func(groupID, workerPID int, deadline time.Time) (GroupObservation, error) {
			return harness.group(groupID, workerPID, deadline)
		}),
		Signaler: signalerFunc(func(groupID int, signal syscall.Signal, deadline time.Time) error {
			harness.signals = append(harness.signals, signalCall{groupID: groupID, signal: signal})
			if signal == syscall.SIGTERM {
				harness.trace = append(harness.trace, "term")
			} else if signal == syscall.SIGKILL {
				harness.trace = append(harness.trace, "kill")
			}
			if harness.signal != nil {
				return harness.signal(groupID, signal, deadline)
			}
			return nil
		}),
		Reaper:    reaperFunc(func(workerPID int, deadline time.Time) (bool, error) { return harness.reaper(workerPID, deadline) }),
		Relay:     relayFunc(func(deadline time.Time) error { return harness.relay(deadline) }),
		Signals:   signalObserverFunc(func() (syscall.Signal, bool) { return harness.pending() }),
		WorkerPID: 4101,
		PGID:      4101,
	}
	return clock, harness, runner
}

type resultObserverFunc func(time.Time) (WorkerResult, error)

func (function resultObserverFunc) Observe(deadline time.Time) (WorkerResult, error) {
	return function(deadline)
}

type groupInspectorFunc func(int, int, time.Time) (GroupObservation, error)

func (function groupInspectorFunc) Observe(groupID, workerPID int, deadline time.Time) (GroupObservation, error) {
	return function(groupID, workerPID, deadline)
}

type verifiedGroupInspector struct {
	observe func(int, int, time.Time) (GroupObservation, error)
}

func (inspector verifiedGroupInspector) VerifyDirectWorkerGroup(int, int, time.Time) error {
	return nil
}

func (inspector verifiedGroupInspector) Observe(groupID, workerPID int, deadline time.Time) (GroupObservation, error) {
	return inspector.observe(groupID, workerPID, deadline)
}

type termSnapshotDeadlineInspector struct {
	t                     *testing.T
	clock                 *fakeClock
	term                  time.Time
	cleanup               time.Time
	verificationDeadlines []time.Time
	snapshotCalls         int
}

func (inspector *termSnapshotDeadlineInspector) VerifyDirectWorkerGroup(groupID, workerPID int, deadline time.Time) error {
	inspector.t.Helper()
	if groupID != 4101 || workerPID != 4101 {
		inspector.t.Fatalf("direct-worker verification = (%d, %d), want (4101, 4101)", groupID, workerPID)
	}
	inspector.verificationDeadlines = append(inspector.verificationDeadlines, deadline)
	return nil
}

func (inspector *termSnapshotDeadlineInspector) Observe(groupID, workerPID int, deadline time.Time) (GroupObservation, error) {
	inspector.t.Helper()
	if groupID != 4101 || workerPID != 4101 {
		inspector.t.Fatalf("group observation = (%d, %d), want (4101, 4101)", groupID, workerPID)
	}
	inspector.snapshotCalls++
	switch inspector.snapshotCalls {
	case 1:
		if deadline != inspector.term {
			inspector.t.Fatalf("TERM group snapshot deadline = %v, want %v", deadline, inspector.term)
		}
		inspector.clock.now = inspector.term
		return GroupObservation{}, darwinproc.ErrDeadline
	case 2:
		if deadline != inspector.cleanup {
			inspector.t.Fatalf("SIGKILL group snapshot deadline = %v, want %v", deadline, inspector.cleanup)
		}
		return GroupObservation{}, nil
	default:
		inspector.t.Fatalf("unexpected group snapshot %d", inspector.snapshotCalls)
		return GroupObservation{}, nil
	}
}

type signalerFunc func(int, syscall.Signal, time.Time) error

func (function signalerFunc) Signal(groupID int, signal syscall.Signal, deadline time.Time) error {
	return function(groupID, signal, deadline)
}

type reaperFunc func(int, time.Time) (bool, error)

func (function reaperFunc) Reap(workerPID int, deadline time.Time) (bool, error) {
	return function(workerPID, deadline)
}

type relayFunc func(time.Time) error

func (function relayFunc) Relay(deadline time.Time) error {
	return function(deadline)
}

type signalObserverFunc func() (syscall.Signal, bool)

func (function signalObserverFunc) Pending() (syscall.Signal, bool) {
	return function()
}

type signalCall struct {
	groupID int
	signal  syscall.Signal
}

func assertStates(t *testing.T, outcome Outcome, want []State) {
	t.Helper()
	if !reflect.DeepEqual(outcome.States, want) {
		t.Fatalf("states = %#v, want %#v", outcome.States, want)
	}
}

func assertDeadlines(t *testing.T, outcome Outcome, t0, work, attempt, cleanupStart, term, cleanup time.Time) {
	t.Helper()
	want := Deadlines{
		T0:           t0,
		Work:         work,
		Attempt:      attempt,
		CleanupStart: cleanupStart,
		Term:         term,
		Cleanup:      cleanup,
	}
	if !reflect.DeepEqual(outcome.Deadlines, want) {
		t.Fatalf("deadlines = %#v, want %#v", outcome.Deadlines, want)
	}
}

func indexOf(values []string, want string) int {
	for index, value := range values {
		if value == want {
			return index
		}
	}
	return len(values)
}
