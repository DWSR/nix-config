//go:build darwin

package darwinproc

/*
#cgo LDFLAGS: -lproc
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <unistd.h>

static int signer_list_pids(pid_t process_group, void *buffer, int buffer_size, int *error_number) {
  errno = 0;
  int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)process_group, buffer, buffer_size);
  *error_number = errno;
  return bytes;
}

static int signer_process_info(pid_t pid, pid_t *process_group, int *process_status, int *error_number) {
  struct proc_bsdinfo info;
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &info, PROC_PIDTBSDINFO_SIZE);
  *error_number = errno;
  if (bytes == PROC_PIDTBSDINFO_SIZE) {
    *process_group = (pid_t)info.pbi_pgid;
    *process_status = (int)info.pbi_status;
  }
  return bytes;
}

static int signer_session(pid_t pid, pid_t *session, int *error_number) {
  errno = 0;
  pid_t result = getsid(pid);
  *error_number = errno;
  if (result != -1) *session = result;
  return result == -1 ? -1 : 0;
}

static int signer_is_zombie(int status) {
  return status == SZOMB;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

var ErrDeadline = errors.New("Darwin process inspection deadline reached")

const processInfoSize = int(C.PROC_PIDTBSDINFO_SIZE)

type GroupObservation struct {
	OtherMember         bool
	OtherZombie         bool
	DirectWorkerPresent bool
	DirectWorkerLive    bool
}

type pidLister func(groupID int, deadline time.Time) ([]int, error)

type rawProcessInfoResult struct {
	bytes        int
	processGroup int
	processState int
	errorNumber  syscall.Errno
}

type rawProcessInfoFunc func(pid int) rawProcessInfoResult

// ObserveGroup uses pbi_pgid, not a process-tree relationship, because the
// signer owns only the dedicated worker process group. SZOMB entries remain
// present until their own parent reaps them.
func ObserveGroup(groupID, directWorkerPID int, deadline time.Time) (GroupObservation, error) {
	return observeGroup(groupID, directWorkerPID, deadline, listPIDs, readProcessInfo)
}

func observeGroup(groupID, directWorkerPID int, deadline time.Time, list pidLister, read rawProcessInfoFunc) (GroupObservation, error) {
	_, directStatus, err := directWorkerGroupInfo(groupID, directWorkerPID, deadline, read)
	if err != nil {
		return GroupObservation{}, err
	}

	pids, err := list(groupID, deadline)
	if err != nil {
		return GroupObservation{}, err
	}

	observation := GroupObservation{
		DirectWorkerPresent: true,
		DirectWorkerLive:    C.signer_is_zombie(C.int(directStatus)) == 0,
	}
	for _, pid := range pids {
		if !time.Now().Before(deadline) {
			return GroupObservation{}, ErrDeadline
		}
		result, err := processInfo(pid, read)
		// Only a zero-byte ESRCH response establishes that a listed PID vanished.
		// Short and negative replies fail closed even when their errno is ESRCH.
		if result.bytes == 0 && result.errorNumber == syscall.ESRCH {
			continue
		}
		if err != nil {
			return GroupObservation{}, err
		}
		if result.processGroup != groupID {
			continue
		}

		if pid == directWorkerPID {
			continue
		}
		zombie := C.signer_is_zombie(C.int(result.processState)) != 0
		// A non-worker zombie remains a group member until its parent reaps it.
		if zombie {
			observation.OtherZombie = true
		}
		observation.OtherMember = true
	}
	return observation, nil
}

func VerifyDirectWorkerGroup(groupID, directWorkerPID int, deadline time.Time) error {
	_, _, err := directWorkerGroupInfo(groupID, directWorkerPID, deadline, readProcessInfo)
	return err
}

func ProcessGroupID(pid int) (int, error) {
	result, err := processInfo(pid, readProcessInfo)
	if err != nil {
		return 0, err
	}
	return result.processGroup, nil
}

func SessionID(pid int) (int, error) {
	var session C.pid_t
	var errorNumber C.int
	if C.signer_session(C.pid_t(pid), &session, &errorNumber) != 0 {
		return 0, errno(int(errorNumber), "getsid")
	}
	return int(session), nil
}

func listPIDs(groupID int, deadline time.Time) ([]int, error) {
	if !time.Now().Before(deadline) {
		return nil, ErrDeadline
	}
	var errorNumber C.int
	bytes := C.signer_list_pids(C.pid_t(groupID), nil, 0, &errorNumber)
	if bytes < 0 {
		return nil, errno(int(errorNumber), "proc_listpids")
	}
	if bytes == 0 {
		return nil, nil
	}

	pidSize := int(unsafe.Sizeof(C.pid_t(0)))
	capacity := int(bytes)/pidSize + 64
	for attempt := 0; attempt < 8; attempt++ {
		if !time.Now().Before(deadline) {
			return nil, ErrDeadline
		}
		pids := make([]C.pid_t, capacity)
		bytes = C.signer_list_pids(C.pid_t(groupID), unsafe.Pointer(&pids[0]), C.int(len(pids)*pidSize), &errorNumber)
		if bytes < 0 {
			return nil, errno(int(errorNumber), "proc_listpids")
		}
		if int(bytes) < len(pids)*pidSize {
			count := int(bytes) / pidSize
			result := make([]int, 0, count)
			for _, pid := range pids[:count] {
				if pid > 0 {
					result = append(result, int(pid))
				}
			}
			return result, nil
		}
		capacity *= 2
	}
	return nil, errors.New("process list changed while inspecting worker group")
}

func directWorkerGroupInfo(groupID, directWorkerPID int, deadline time.Time, read rawProcessInfoFunc) (int, int, error) {
	if !time.Now().Before(deadline) {
		return 0, 0, ErrDeadline
	}
	result, err := processInfo(directWorkerPID, read)
	if err != nil {
		return 0, 0, err
	}
	if result.processGroup != groupID {
		return 0, 0, fmt.Errorf("direct worker %d left worker process group %d", directWorkerPID, groupID)
	}
	return result.processGroup, result.processState, nil
}

func readProcessInfo(pid int) rawProcessInfoResult {
	var processGroup C.pid_t
	var processState C.int
	var errorNumber C.int
	bytes := C.signer_process_info(C.pid_t(pid), &processGroup, &processState, &errorNumber)
	return rawProcessInfoResult{
		bytes:        int(bytes),
		processGroup: int(processGroup),
		processState: int(processState),
		errorNumber:  syscall.Errno(errorNumber),
	}
}

func processInfo(pid int, read rawProcessInfoFunc) (rawProcessInfoResult, error) {
	result := read(pid)
	if result.bytes == processInfoSize {
		return result, nil
	}
	if result.bytes == 0 && result.errorNumber == syscall.ESRCH {
		return result, syscall.ESRCH
	}
	return result, errno(int(result.errorNumber), "proc_pidinfo")
}

func errno(value int, operation string) error {
	if value != 0 {
		return syscall.Errno(value)
	}
	return fmt.Errorf("%s returned incomplete process data", operation)
}
