//go:build darwin

package darwinproc

import (
	"errors"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestObserveGroupRejectsIncompleteExtraMemberProcessInfo(t *testing.T) {
	const (
		groupID         = 4101
		directWorkerPID = 4101
		extraMemberPID  = 4102
	)

	cases := []struct {
		name           string
		result         rawProcessInfoResult
		wantAbsent     bool
		wantErr        error
		wantIncomplete bool
	}{
		{
			name:       "zero-byte ESRCH",
			result:     rawProcessInfoResult{errorNumber: syscall.ESRCH},
			wantAbsent: true,
		},
		{
			name:    "short-byte ESRCH",
			result:  rawProcessInfoResult{bytes: processInfoSize - 1, errorNumber: syscall.ESRCH},
			wantErr: syscall.ESRCH,
		},
		{
			name:    "negative-byte ESRCH",
			result:  rawProcessInfoResult{bytes: -1, errorNumber: syscall.ESRCH},
			wantErr: syscall.ESRCH,
		},
		{
			name:    "zero-byte EINTR",
			result:  rawProcessInfoResult{errorNumber: syscall.EINTR},
			wantErr: syscall.EINTR,
		},
		{
			name:    "zero-byte EPERM",
			result:  rawProcessInfoResult{errorNumber: syscall.EPERM},
			wantErr: syscall.EPERM,
		},
		{
			name:           "zero-byte without errno",
			result:         rawProcessInfoResult{},
			wantIncomplete: true,
		},
		{
			name:           "short data without errno",
			result:         rawProcessInfoResult{bytes: processInfoSize - 1},
			wantIncomplete: true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			observation, err := observeGroup(
				groupID,
				directWorkerPID,
				time.Now().Add(time.Second),
				func(actualGroupID int, _ time.Time) ([]int, error) {
					if actualGroupID != groupID {
						t.Fatalf("group ID = %d, want %d", actualGroupID, groupID)
					}
					return []int{directWorkerPID, extraMemberPID}, nil
				},
				func(pid int) rawProcessInfoResult {
					switch pid {
					case directWorkerPID:
						return rawProcessInfoResult{bytes: processInfoSize, processGroup: groupID}
					case extraMemberPID:
						return testCase.result
					default:
						t.Fatalf("unexpected PID %d", pid)
						return rawProcessInfoResult{}
					}
				},
			)

			if testCase.wantAbsent {
				want := GroupObservation{DirectWorkerPresent: true, DirectWorkerLive: true}
				if err != nil || observation != want {
					t.Errorf("observation, err = %#v, %v; want %#v, nil", observation, err, want)
				}
				return
			}
			if testCase.wantErr != nil && !errors.Is(err, testCase.wantErr) {
				t.Errorf("error = %v, want %v", err, testCase.wantErr)
			}
			if testCase.wantIncomplete && (err == nil || !strings.Contains(err.Error(), "incomplete process data")) {
				t.Errorf("error = %v, want incomplete process data", err)
			}
			if observation != (GroupObservation{}) {
				t.Errorf("observation = %#v, want no trusted observation", observation)
			}
		})
	}
}
