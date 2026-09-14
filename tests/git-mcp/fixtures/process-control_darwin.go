//go:build darwin

package main

/*
#cgo LDFLAGS: -lproc
#include <errno.h>
#include <libproc.h>
#include <stdint.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/types.h>
#include <unistd.h>

static int process_control_info(pid_t pid, struct proc_bsdinfo *info, int *error_number) {
	errno = 0;
	int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, info, PROC_PIDTBSDINFO_SIZE);
	*error_number = errno;
	return bytes;
}

static int process_control_path(pid_t pid, char *path, uint32_t path_size, int *error_number) {
	errno = 0;
	int bytes = proc_pidpath(pid, path, path_size);
	*error_number = errno;
	return bytes;
}

static int process_control_list_pids(pid_t process_group, void *buffer, int buffer_size, int *error_number) {
	errno = 0;
	int bytes = proc_listpids(PROC_PGRP_ONLY, (uint32_t)process_group, buffer, buffer_size);
	*error_number = errno;
	return bytes;
}

static int process_control_session(pid_t pid, pid_t *session, int *error_number) {
	errno = 0;
	pid_t result = getsid(pid);
	*error_number = errno;
	if (result != -1) *session = result;
	return result == -1 ? -1 : 0;
}

static int process_control_is_zombie(int status) {
	return status == SZOMB;
}
*/
import "C"

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	absentExitCode               = 3
	usageExitCode                = 64
	failureExitCode              = 70
	agentSocketTrapLifecycleRole = "agent-socket-trap-lifecycle"
)

var processInfoSize = int(C.PROC_PIDTBSDINFO_SIZE)

type commandError struct {
	code int
	err  error
}

func (err *commandError) Error() string {
	return err.err.Error()
}

func usageError(format string, arguments ...any) error {
	return &commandError{code: usageExitCode, err: fmt.Errorf(format, arguments...)}
}

func absentError(format string, arguments ...any) error {
	return &commandError{code: absentExitCode, err: fmt.Errorf(format, arguments...)}
}

type processIdentity struct {
	PID               int    `json:"pid"`
	ProcessGroup      int    `json:"processGroup"`
	StartSeconds      uint64 `json:"startSeconds"`
	StartMicroseconds uint64 `json:"startMicroseconds"`
	Executable        string `json:"executable"`
}

type observedProcess struct {
	processIdentity
	zombie bool
}

type ownershipRecord struct {
	processIdentity
	ExpectedExecutable string `json:"expectedExecutable"`
	Role               string `json:"role"`
	SessionToken       string `json:"sessionToken"`
}

type workerGroup struct {
	Kind         string            `json:"kind"`
	ProcessGroup int               `json:"processGroup"`
	Session      int               `json:"session"`
	SessionToken string            `json:"sessionToken"`
	Anchor       ownershipRecord   `json:"anchor"`
	Members      []ownershipRecord `json:"members"`
}

type ownershipState struct {
	Record ownershipRecord `json:"record"`
	State  string          `json:"state"`
}

type ownershipRelease struct {
	PID                int    `json:"pid"`
	SessionToken       string `json:"sessionToken"`
	ExpectedExecutable string `json:"expectedExecutable"`
	Role               string `json:"role"`
}

type stringList []string

func (values *stringList) String() string {
	return strings.Join(*values, ",")
}

func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func parsePositiveInteger(value, description string) (int, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 || parsed > math.MaxInt32 {
		return 0, usageError("invalid %s: %s", description, value)
	}
	return int(parsed), nil
}

func parseTimeout(value int) (time.Duration, error) {
	if value <= 0 || value > 600_000 {
		return 0, usageError("invalid timeout milliseconds: %d", value)
	}
	return time.Duration(value) * time.Millisecond, nil
}

func newFlagSet(name string) *flag.FlagSet {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	return flags
}

func parseFlags(flags *flag.FlagSet, arguments []string) error {
	if err := flags.Parse(arguments); err != nil {
		return usageError("%s", err)
	}
	if flags.NArg() != 0 {
		return usageError("unexpected argument: %s", flags.Arg(0))
	}
	return nil
}

func processError(operation string, bytes int, errno syscall.Errno) error {
	if errno != 0 {
		return fmt.Errorf("%s: %w", operation, errno)
	}
	if bytes != 0 {
		return fmt.Errorf("%s returned incomplete process data (%d bytes)", operation, bytes)
	}
	return fmt.Errorf("%s returned no process data", operation)
}

func readProcessInfo(pid int) (observedProcess, bool, error) {
	var info C.struct_proc_bsdinfo
	var errorNumber C.int
	bytesRead := int(C.process_control_info(C.pid_t(pid), &info, &errorNumber))
	errno := syscall.Errno(errorNumber)
	if bytesRead != processInfoSize {
		if bytesRead == 0 && errno == syscall.ESRCH {
			return observedProcess{}, true, nil
		}
		return observedProcess{}, false, processError("proc_pidinfo", bytesRead, errno)
	}

	result := observedProcess{
		processIdentity: processIdentity{
			PID:               pid,
			ProcessGroup:      int(info.pbi_pgid),
			StartSeconds:      uint64(info.pbi_start_tvsec),
			StartMicroseconds: uint64(info.pbi_start_tvusec),
		},
		zombie: C.process_control_is_zombie(C.int(info.pbi_status)) != 0,
	}
	if err := validateProcessFields(result.processIdentity); err != nil {
		return observedProcess{}, false, fmt.Errorf("proc_pidinfo returned invalid process identity: %w", err)
	}
	return result, false, nil
}

func readProcessPath(pid int, result *observedProcess) (bool, error) {
	path := make([]C.char, int(C.PROC_PIDPATHINFO_MAXSIZE))
	var errorNumber C.int
	bytesRead := int(C.process_control_path(
		C.pid_t(pid),
		(*C.char)(unsafe.Pointer(&path[0])),
		C.uint32_t(len(path)),
		&errorNumber,
	))
	errno := syscall.Errno(errorNumber)
	if bytesRead <= 0 {
		if bytesRead == 0 && errno == syscall.ESRCH {
			if result.zombie {
				return false, nil
			}
			return true, nil
		}
		return false, processError("proc_pidpath", bytesRead, errno)
	}
	result.Executable = C.GoString((*C.char)(unsafe.Pointer(&path[0])))
	if err := validateIdentity(result.processIdentity); err != nil {
		return false, fmt.Errorf("proc_pidpath returned invalid process identity: %w", err)
	}
	return false, nil
}

func inspectProcess(pid int) (observedProcess, bool, error) {
	result, absent, err := readProcessInfo(pid)
	if err != nil || absent {
		return observedProcess{}, absent, err
	}
	absent, err = readProcessPath(pid, &result)
	if err != nil || absent {
		return observedProcess{}, absent, err
	}
	if result.Executable == "" {
		return observedProcess{}, false, fmt.Errorf("cannot establish executable identity for zombie process %d", pid)
	}
	return result, false, nil
}

func sessionID(pid int) (int, bool, error) {
	var session C.pid_t
	var errorNumber C.int
	if C.process_control_session(C.pid_t(pid), &session, &errorNumber) != 0 {
		errno := syscall.Errno(errorNumber)
		if errno == syscall.ESRCH {
			return 0, true, nil
		}
		return 0, false, processError("getsid", -1, errno)
	}
	if session <= 0 {
		return 0, false, fmt.Errorf("getsid returned invalid session for process %d", pid)
	}
	return int(session), false, nil
}

func listProcessIDs(processGroup int) ([]int, error) {
	var errorNumber C.int
	bytesRead := int(C.process_control_list_pids(C.pid_t(processGroup), nil, 0, &errorNumber))
	errno := syscall.Errno(errorNumber)
	if bytesRead < 0 {
		return nil, processError("proc_listpids", bytesRead, errno)
	}
	if bytesRead == 0 {
		if errno != 0 {
			return nil, processError("proc_listpids", bytesRead, errno)
		}
		return nil, nil
	}

	pidSize := int(unsafe.Sizeof(C.pid_t(0)))
	capacity := bytesRead/pidSize + 64
	for attempt := 0; attempt < 8; attempt++ {
		pids := make([]C.pid_t, capacity)
		bytesRead = int(C.process_control_list_pids(
			C.pid_t(processGroup),
			unsafe.Pointer(&pids[0]),
			C.int(len(pids)*pidSize),
			&errorNumber,
		))
		errno = syscall.Errno(errorNumber)
		if bytesRead < 0 {
			return nil, processError("proc_listpids", bytesRead, errno)
		}
		if bytesRead < len(pids)*pidSize {
			result := make([]int, 0, bytesRead/pidSize)
			for _, pid := range pids[:bytesRead/pidSize] {
				if pid > 0 {
					result = append(result, int(pid))
				}
			}
			sort.Ints(result)
			return result, nil
		}
		if capacity > math.MaxInt32/(2*pidSize) {
			return nil, fmt.Errorf("process list exceeds supported size")
		}
		capacity *= 2
	}
	return nil, fmt.Errorf("process list changed while inspecting process group %d", processGroup)
}

func inspectGroup(processGroup int) ([]observedProcess, error) {
	pids, err := listProcessIDs(processGroup)
	if err != nil {
		return nil, err
	}
	result := make([]observedProcess, 0, len(pids))
	for _, pid := range pids {
		process, absent, err := inspectProcess(pid)
		if err != nil {
			return nil, err
		}
		if absent || process.ProcessGroup != processGroup {
			continue
		}
		result = append(result, process)
	}
	return result, nil
}

func inspectGroupForCleanup(processGroup int) ([]observedProcess, error) {
	pids, err := listProcessIDs(processGroup)
	if err != nil {
		return nil, err
	}
	result := make([]observedProcess, 0, len(pids))
	for _, pid := range pids {
		process, absent, err := readProcessInfo(pid)
		if err != nil {
			return nil, err
		}
		if absent || process.ProcessGroup != processGroup {
			continue
		}
		absent, err = readProcessPath(pid, &process)
		if err != nil {
			return nil, err
		}
		if absent {
			continue
		}
		result = append(result, process)
	}
	return result, nil
}

func validateIdentity(identity processIdentity) error {
	if err := validateProcessFields(identity); err != nil {
		return err
	}
	if identity.Executable == "" {
		return errors.New("missing executable")
	}
	return nil
}

func validateProcessFields(identity processIdentity) error {
	if identity.PID <= 0 {
		return fmt.Errorf("invalid process ID %d", identity.PID)
	}
	if identity.ProcessGroup <= 0 {
		return fmt.Errorf("invalid process group %d", identity.ProcessGroup)
	}
	if identity.StartMicroseconds >= 1_000_000 {
		return fmt.Errorf("invalid start microseconds %d", identity.StartMicroseconds)
	}
	return nil
}

func validateOwnershipRecord(record ownershipRecord, token, location string) error {
	if token == "" {
		return errors.New("ownership token is required")
	}
	if record.SessionToken != token {
		return fmt.Errorf("foreign ownership token in %s", location)
	}
	if err := validateIdentity(record.processIdentity); err != nil {
		return fmt.Errorf("invalid ownership record in %s: %w", location, err)
	}
	if record.ExpectedExecutable == "" {
		return fmt.Errorf("missing expected executable in %s", location)
	}
	if record.Executable != record.ExpectedExecutable {
		return fmt.Errorf("unexpected executable in %s: expected %s, observed %s", location, record.ExpectedExecutable, record.Executable)
	}
	if record.Role == "" {
		return fmt.Errorf("missing role in %s", location)
	}
	return nil
}

func sameIdentity(left, right processIdentity) bool {
	return left.PID == right.PID &&
		left.ProcessGroup == right.ProcessGroup &&
		left.StartSeconds == right.StartSeconds &&
		left.StartMicroseconds == right.StartMicroseconds &&
		left.Executable == right.Executable
}

func sameProcessInstance(left, right processIdentity) bool {
	return left.PID == right.PID &&
		left.ProcessGroup == right.ProcessGroup &&
		left.StartSeconds == right.StartSeconds &&
		left.StartMicroseconds == right.StartMicroseconds
}

func sameOwnershipRecord(left, right ownershipRecord) bool {
	return sameIdentity(left.processIdentity, right.processIdentity) &&
		left.ExpectedExecutable == right.ExpectedExecutable &&
		left.Role == right.Role &&
		left.SessionToken == right.SessionToken
}

func ownershipKey(record ownershipRecord) string {
	return strings.Join([]string{
		strconv.Itoa(record.PID),
		strconv.Itoa(record.ProcessGroup),
		strconv.FormatUint(record.StartSeconds, 10),
		strconv.FormatUint(record.StartMicroseconds, 10),
		record.Executable,
		record.ExpectedExecutable,
		record.Role,
		record.SessionToken,
	}, "\x00")
}

func encodeJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

func decodeJSON(contents []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

func writeAtomic(path string, contents []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".process-control-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func writeRootRecord(root string, record ownershipRecord) error {
	directory := filepath.Join(root, "owned-processes")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	contents, err := encodeJSON(record)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".record-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	finalPath := filepath.Join(
		directory,
		strings.TrimPrefix(filepath.Base(temporaryPath), ".")+".json",
	)
	return os.Rename(temporaryPath, finalPath)
}

func writeRecordFile(path string, record ownershipRecord, truncate bool) error {
	contents, err := encodeJSON(record)
	if err != nil {
		return err
	}
	if truncate {
		return writeAtomic(path, contents, 0o600)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := file.Write(contents); err != nil {
		return err
	}
	return file.Sync()
}

func readRootRecords(root, token string) ([]ownershipRecord, error) {
	directory := filepath.Join(root, "owned-processes")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]ownershipRecord, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		contents, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var record ownershipRecord
		if err := decodeJSON(contents, &record); err != nil {
			return nil, fmt.Errorf("malformed durable ownership record %s: %w", path, err)
		}
		if err := validateOwnershipRecord(record, token, path); err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, nil
}

func readRecordFile(path, token string) ([]ownershipRecord, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()

	decoder := json.NewDecoder(file)
	result := []ownershipRecord{}
	for {
		var record ownershipRecord
		err := decoder.Decode(&record)
		if err == io.EOF {
			return result, nil
		}
		if err != nil {
			return nil, fmt.Errorf("malformed durable ownership record %s: %w", path, err)
		}
		if err := validateOwnershipRecord(record, token, path); err != nil {
			return nil, err
		}
		result = append(result, record)
	}
}

func loadRecords(root, token string, recordFiles []string) ([]ownershipRecord, error) {
	if token == "" {
		return nil, usageError("ownership token is required")
	}
	result := []ownershipRecord{}
	if root != "" {
		records, err := readRootRecords(root, token)
		if err != nil {
			return nil, err
		}
		result = append(result, records...)
	}
	for _, path := range recordFiles {
		records, err := readRecordFile(path, token)
		if err != nil {
			return nil, err
		}
		result = append(result, records...)
	}
	seen := map[string]bool{}
	unique := make([]ownershipRecord, 0, len(result))
	for _, record := range result {
		key := ownershipKey(record)
		if !seen[key] {
			seen[key] = true
			unique = append(unique, record)
		}
	}
	return unique, nil
}

func selectRecords(records []ownershipRecord, selected map[int]bool, role string) []ownershipRecord {
	result := records[:0]
	for _, record := range records {
		if len(selected) > 0 && !selected[record.PID] {
			continue
		}
		if role != "" && record.Role != role {
			continue
		}
		result = append(result, record)
	}
	return result
}

func validateWorkerGroup(group workerGroup, token, location string) error {
	if group.Kind != "worker-group" {
		return fmt.Errorf("invalid worker group kind in %s", location)
	}
	if group.SessionToken != token {
		return fmt.Errorf("foreign worker-group token in %s", location)
	}
	if group.ProcessGroup <= 0 || group.Session <= 0 {
		return fmt.Errorf("invalid worker group in %s", location)
	}
	if group.Session != group.ProcessGroup {
		return fmt.Errorf("worker group does not own its session in %s", location)
	}
	if len(group.Members) == 0 {
		return fmt.Errorf("empty worker group in %s", location)
	}
	if err := validateOwnershipRecord(group.Anchor, token, location+" anchor"); err != nil {
		return err
	}
	if group.Anchor.ProcessGroup != group.ProcessGroup {
		return fmt.Errorf("worker-group anchor escaped group in %s", location)
	}

	memberIdentities := map[string]bool{}
	anchorFound := false
	for _, member := range group.Members {
		if err := validateOwnershipRecord(member, token, location+" member"); err != nil {
			return err
		}
		if member.ProcessGroup != group.ProcessGroup {
			return fmt.Errorf("worker-group member %d escaped group in %s", member.PID, location)
		}
		identityKey := strings.Join([]string{
			strconv.Itoa(member.PID),
			strconv.Itoa(member.ProcessGroup),
			strconv.FormatUint(member.StartSeconds, 10),
			strconv.FormatUint(member.StartMicroseconds, 10),
			member.Executable,
		}, "\x00")
		if memberIdentities[identityKey] {
			return fmt.Errorf("duplicate worker-group member in %s", location)
		}
		memberIdentities[identityKey] = true
		if sameOwnershipRecord(member, group.Anchor) {
			anchorFound = true
		}
	}
	if !anchorFound {
		return fmt.Errorf("worker-group anchor is not a member in %s", location)
	}
	return nil
}

func loadWorkerGroups(root, token string, records []ownershipRecord, allowPending bool) ([]workerGroup, error) {
	if root == "" {
		return nil, nil
	}
	directory := filepath.Join(root, "worker-groups")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	owned := map[string]bool{}
	for _, record := range records {
		owned[ownershipKey(record)] = true
	}
	groups := []workerGroup{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		if _, err := os.Stat(path + ".ready"); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				if allowPending {
					continue
				}
				return nil, fmt.Errorf("incomplete durable worker-group record; refusing cleanup: %s", path)
			}
			return nil, err
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var group workerGroup
		if err := decodeJSON(contents, &group); err != nil {
			return nil, fmt.Errorf("malformed durable worker-group manifest %s: %w", path, err)
		}
		if err := validateWorkerGroup(group, token, path); err != nil {
			return nil, err
		}
		for _, member := range group.Members {
			if !owned[ownershipKey(member)] {
				return nil, fmt.Errorf("worker-group member %d lacks a durable ownership record", member.PID)
			}
		}
		groups = append(groups, group)
	}
	return groups, nil
}

func hasPendingWorkerGroups(root string) (bool, error) {
	directory := filepath.Join(root, "worker-groups")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if _, err := os.Stat(filepath.Join(directory, entry.Name()) + ".ready"); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return true, nil
			}
			return false, err
		}
	}
	return false, nil
}

func observedOwnershipState(record ownershipRecord) (string, error) {
	observed, absent, err := readProcessInfo(record.PID)
	if err != nil {
		return "", err
	}
	if absent {
		return "gone", nil
	}
	if !sameProcessInstance(record.processIdentity, observed.processIdentity) {
		return "", fmt.Errorf(
			"owned process %d no longer matches its durable identity (%s, %d.%d); refusing to signal process instance %d.%d",
			record.PID,
			record.Executable,
			record.StartSeconds,
			record.StartMicroseconds,
			observed.StartSeconds,
			observed.StartMicroseconds,
		)
	}
	if observed.zombie {
		return "zombie", nil
	}
	absent, err = readProcessPath(record.PID, &observed)
	if err != nil {
		return "", err
	}
	if absent {
		return "gone", nil
	}
	if !sameIdentity(record.processIdentity, observed.processIdentity) {
		return "", fmt.Errorf(
			"owned process %d no longer matches its durable executable identity (%s); refusing to signal %s",
			record.PID,
			record.Executable,
			observed.Executable,
		)
	}
	return "live", nil
}

func signalOwnedRecord(record ownershipRecord, signal syscall.Signal) (bool, error) {
	state, err := observedOwnershipState(record)
	if err != nil {
		return false, err
	}
	if state == "gone" || state == "zombie" {
		return false, nil
	}
	if err := syscall.Kill(record.PID, signal); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return false, nil
		}
		return false, fmt.Errorf("cannot signal owned process %d: %w", record.PID, err)
	}
	return true, nil
}

func signalWorkerGroup(processGroup int, signal syscall.Signal) error {
	if err := syscall.Kill(-processGroup, signal); err != nil && !errors.Is(err, syscall.ESRCH) {
		return fmt.Errorf("cannot signal worker process group %d: %w", processGroup, err)
	}
	return nil
}

func memberRecord(group workerGroup, observed observedProcess) (ownershipRecord, bool) {
	for _, member := range group.Members {
		if sameProcessInstance(member.processIdentity, observed.processIdentity) &&
			(observed.zombie || member.Executable == observed.Executable) {
			return member, true
		}
	}
	return ownershipRecord{}, false
}

type groupPlan struct {
	group          workerGroup
	currentMembers []observedProcess
	anchorState    string
}

func planWorkerGroup(group workerGroup) (groupPlan, error) {
	currentMembers, err := inspectGroupForCleanup(group.ProcessGroup)
	if err != nil {
		return groupPlan{}, err
	}
	for _, member := range currentMembers {
		if _, ok := memberRecord(group, member); !ok {
			return groupPlan{}, fmt.Errorf("unrecorded live worker-group member %d in group %d; refusing to signal", member.PID, group.ProcessGroup)
		}
	}
	anchorState, err := observedOwnershipState(group.Anchor)
	if err != nil {
		return groupPlan{}, err
	}
	for _, member := range group.Members {
		if _, err := observedOwnershipState(member); err != nil {
			return groupPlan{}, err
		}
	}
	if anchorState != "gone" {
		anchorPresent := false
		for _, member := range currentMembers {
			if _, ok := memberRecord(workerGroup{Members: []ownershipRecord{group.Anchor}}, member); ok {
				anchorPresent = true
				break
			}
		}
		if !anchorPresent {
			return groupPlan{}, fmt.Errorf("worker-group anchor %d is absent from live group %d", group.Anchor.PID, group.ProcessGroup)
		}
	}
	return groupPlan{group: group, currentMembers: currentMembers, anchorState: anchorState}, nil
}

func groupIsGone(group workerGroup) (bool, error) {
	currentMembers, err := inspectGroupForCleanup(group.ProcessGroup)
	if err != nil {
		return false, err
	}
	if len(currentMembers) > 0 {
		for _, member := range currentMembers {
			if _, ok := memberRecord(group, member); !ok {
				return false, fmt.Errorf("unrecorded live worker-group member %d in group %d; refusing to claim cleanup", member.PID, group.ProcessGroup)
			}
		}
		return false, nil
	}
	for _, member := range group.Members {
		state, err := observedOwnershipState(member)
		if err != nil {
			return false, err
		}
		if state != "gone" {
			return false, nil
		}
	}
	return true, nil
}

func waitForWorkerGroupGone(group workerGroup, deadline time.Time) error {
	for {
		gone, err := groupIsGone(group)
		if err != nil {
			return err
		}
		if gone {
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("worker process group %d survived cleanup", group.ProcessGroup)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func terminateWorkerGroup(group workerGroup, deadline time.Time) error {
	plan, err := planWorkerGroup(group)
	if err != nil {
		return err
	}
	if len(plan.currentMembers) > 0 {
		if plan.anchorState != "gone" {
			if err := signalWorkerGroup(group.ProcessGroup, syscall.SIGKILL); err != nil {
				return err
			}
		} else {
			for _, member := range plan.currentMembers {
				record, ok := memberRecord(group, member)
				if !ok {
					return fmt.Errorf("unrecorded live worker-group member %d in group %d; refusing to signal", member.PID, group.ProcessGroup)
				}
				if _, err := signalOwnedRecord(record, syscall.SIGKILL); err != nil {
					return err
				}
			}
		}
	}
	return waitForWorkerGroupGone(group, deadline)
}

func recordsAreGone(records []ownershipRecord) (bool, error) {
	for _, record := range records {
		state, err := observedOwnershipState(record)
		if err != nil {
			return false, err
		}
		if state != "gone" {
			return false, nil
		}
	}
	return true, nil
}

func waitForRecordsGone(records []ownershipRecord, deadline time.Time) (bool, error) {
	for {
		gone, err := recordsAreGone(records)
		if err != nil || gone || !time.Now().Before(deadline) {
			return gone, err
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func terminateOwnedRecords(records []ownershipRecord, deadline time.Time) error {
	for _, record := range records {
		if _, err := signalOwnedRecord(record, syscall.SIGTERM); err != nil {
			return err
		}
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return fmt.Errorf("owned fixture processes survived cleanup")
	}
	termDeadline := time.Now().Add(remaining / 2)
	if gone, err := waitForRecordsGone(records, termDeadline); err != nil {
		return err
	} else if gone {
		return nil
	}
	for _, record := range records {
		if _, err := signalOwnedRecord(record, syscall.SIGKILL); err != nil {
			return err
		}
	}
	if gone, err := waitForRecordsGone(records, deadline); err != nil {
		return err
	} else if gone {
		return nil
	}
	return fmt.Errorf("owned fixture processes survived cleanup")
}

func recordFromFlags(arguments []string) (ownershipRecord, string, string, bool, error) {
	flags := newFlagSet("record")
	root := flags.String("root", "", "")
	file := flags.String("file", "", "")
	token := flags.String("token", "", "")
	pidText := flags.String("pid", "", "")
	expectedExecutable := flags.String("expected-executable", "", "")
	useObservedExecutable := flags.Bool("use-observed-executable", false, "")
	role := flags.String("role", "", "")
	waitMilliseconds := flags.Int("wait-ms", 0, "")
	truncate := flags.Bool("truncate", false, "")
	testRecordMode := flags.String("test-record-mode", "", "")
	if err := parseFlags(flags, arguments); err != nil {
		return ownershipRecord{}, "", "", false, err
	}
	if (*root == "" && *file == "") || (*root != "" && *file != "") {
		return ownershipRecord{}, "", "", false, usageError("record requires exactly one of --root or --file")
	}
	if *token == "" || *pidText == "" || *role == "" || (*expectedExecutable == "" && !*useObservedExecutable) {
		return ownershipRecord{}, "", "", false, usageError("record requires --token, --pid, --role, and an expected executable")
	}
	pid, err := parsePositiveInteger(*pidText, "process ID")
	if err != nil {
		return ownershipRecord{}, "", "", false, err
	}
	deadline := time.Now()
	if *waitMilliseconds > 0 {
		duration, err := parseTimeout(*waitMilliseconds)
		if err != nil {
			return ownershipRecord{}, "", "", false, err
		}
		deadline = deadline.Add(duration)
	}
	for {
		observed, absent, err := inspectProcess(pid)
		if err == nil && !absent {
			expected := *expectedExecutable
			if *useObservedExecutable {
				expected = observed.Executable
			}
			if observed.Executable == expected {
				record := ownershipRecord{
					processIdentity:    observed.processIdentity,
					ExpectedExecutable: expected,
					Role:               *role,
					SessionToken:       *token,
				}
				switch *testRecordMode {
				case "":
				case "synthetic-ownership-record":
					record.PID++
				case "recycled-ownership-record":
					record.StartMicroseconds = (record.StartMicroseconds + 1) % 1_000_000
				default:
					return ownershipRecord{}, "", "", false, usageError("invalid test record mode: %s", *testRecordMode)
				}
				return record, *root, *file, *truncate, nil
			}
			err = fmt.Errorf("%s executable mismatch: expected %s, observed %s", *role, expected, observed.Executable)
		} else if err == nil && absent {
			err = fmt.Errorf("process %d exited before ownership capture", pid)
		}
		if *waitMilliseconds == 0 || !time.Now().Before(deadline) {
			return ownershipRecord{}, "", "", false, err
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func commandRecord(arguments []string) error {
	record, root, file, truncate, err := recordFromFlags(arguments)
	if err != nil {
		return err
	}
	if err := validateOwnershipRecord(record, record.SessionToken, "new ownership record"); err != nil {
		return err
	}
	if root != "" {
		return writeRootRecord(root, record)
	}
	return writeRecordFile(file, record, truncate)
}

func commandInspect(arguments []string) error {
	if len(arguments) != 1 {
		return usageError("usage: process-control inspect <pid>")
	}
	pid, err := parsePositiveInteger(arguments[0], "process ID")
	if err != nil {
		return err
	}
	observed, absent, err := inspectProcess(pid)
	if err != nil {
		return err
	}
	if absent {
		return absentError("process %d is absent", pid)
	}
	fmt.Printf("%d\t%d\t%d\t%d\t%s\n", observed.PID, observed.ProcessGroup, observed.StartSeconds, observed.StartMicroseconds, observed.Executable)
	return nil
}

func commandGroup(arguments []string) error {
	if len(arguments) != 1 {
		return usageError("usage: process-control group <process-group>")
	}
	processGroup, err := parsePositiveInteger(arguments[0], "process group")
	if err != nil {
		return err
	}
	members, err := inspectGroup(processGroup)
	if err != nil {
		return err
	}
	if len(members) == 0 {
		return absentError("process group %d is absent", processGroup)
	}
	for _, member := range members {
		fmt.Printf("%d\t%d\t%d\t%d\t%s\n", member.PID, member.ProcessGroup, member.StartSeconds, member.StartMicroseconds, member.Executable)
	}
	return nil
}

func commandSession(arguments []string) error {
	if len(arguments) != 1 {
		return usageError("usage: process-control session <pid>")
	}
	pid, err := parsePositiveInteger(arguments[0], "process ID")
	if err != nil {
		return err
	}
	session, absent, err := sessionID(pid)
	if err != nil {
		return err
	}
	if absent {
		return absentError("process %d is absent", pid)
	}
	fmt.Printf("%d\n", session)
	return nil
}

func commandCaptureGroup(arguments []string) error {
	flags := newFlagSet("capture-group")
	root := flags.String("root", "", "")
	token := flags.String("token", "", "")
	anchorText := flags.String("anchor", "", "")
	role := flags.String("role", "", "")
	if err := parseFlags(flags, arguments); err != nil {
		return err
	}
	if *root == "" || *token == "" || *anchorText == "" || *role == "" {
		return usageError("capture-group requires --root, --token, --anchor, and --role")
	}
	anchorPID, err := parsePositiveInteger(*anchorText, "anchor process ID")
	if err != nil {
		return err
	}
	anchor, absent, err := inspectProcess(anchorPID)
	if err != nil {
		return err
	}
	if absent {
		return absentError("anchor process %d is absent", anchorPID)
	}
	session, absent, err := sessionID(anchorPID)
	if err != nil {
		return err
	}
	if absent {
		return absentError("anchor process %d is absent", anchorPID)
	}
	if session != anchor.ProcessGroup {
		return fmt.Errorf("worker process group %d does not own anchor session %d", anchor.ProcessGroup, session)
	}
	members, err := inspectGroup(anchor.ProcessGroup)
	if err != nil {
		return err
	}
	if len(members) == 0 {
		return absentError("worker process group %d is absent", anchor.ProcessGroup)
	}
	groupMembers := make([]ownershipRecord, 0, len(members))
	var groupAnchor ownershipRecord
	for _, member := range members {
		record := ownershipRecord{
			processIdentity:    member.processIdentity,
			ExpectedExecutable: member.Executable,
			Role:               *role,
			SessionToken:       *token,
		}
		if err := writeRootRecord(*root, record); err != nil {
			return err
		}
		groupMembers = append(groupMembers, record)
		if sameIdentity(member.processIdentity, anchor.processIdentity) {
			groupAnchor = record
		}
	}
	if groupAnchor.PID == 0 {
		return fmt.Errorf("worker-group anchor %d is absent from live group %d", anchorPID, anchor.ProcessGroup)
	}
	manifest := workerGroup{
		Kind:         "worker-group",
		ProcessGroup: anchor.ProcessGroup,
		Session:      session,
		SessionToken: *token,
		Anchor:       groupAnchor,
		Members:      groupMembers,
	}
	if err := validateWorkerGroup(manifest, *token, "new worker-group manifest"); err != nil {
		return err
	}
	directory := filepath.Join(*root, "worker-groups")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	contents, err := encodeJSON(manifest)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".worker-group-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	manifestPath := filepath.Join(directory, strings.TrimPrefix(filepath.Base(temporaryPath), ".")+".json")
	if err := os.Rename(temporaryPath, manifestPath); err != nil {
		return err
	}
	return writeAtomic(manifestPath+".ready", []byte("ready\n"), 0o600)
}

func commandWaitRecord(arguments []string) error {
	flags := newFlagSet("wait-record")
	root := flags.String("root", "", "")
	token := flags.String("token", "", "")
	pidText := flags.String("pid", "", "")
	role := flags.String("role", "", "")
	timeoutMilliseconds := flags.Int("timeout-ms", 2_000, "")
	if err := parseFlags(flags, arguments); err != nil {
		return err
	}
	if *root == "" || *token == "" || *pidText == "" {
		return usageError("wait-record requires --root, --token, and --pid")
	}
	pid, err := parsePositiveInteger(*pidText, "process ID")
	if err != nil {
		return err
	}
	duration, err := parseTimeout(*timeoutMilliseconds)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(duration)
	for {
		records, err := readRootRecords(*root, *token)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.PID != pid {
				continue
			}
			if *role != "" && record.Role != *role {
				continue
			}
			state, err := observedOwnershipState(record)
			if err != nil {
				return err
			}
			if state == "live" {
				contents, err := encodeJSON(record)
				if err != nil {
					return err
				}
				_, err = os.Stdout.Write(contents)
				return err
			}
		}
		if !time.Now().Before(deadline) {
			if *role != "" {
				return fmt.Errorf("process %d did not publish a live durable ownership record for role %s", pid, *role)
			}
			return fmt.Errorf("process %d did not publish a live durable ownership record", pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func commandReleaseRecord(arguments []string) error {
	flags := newFlagSet("release-record")
	root := flags.String("root", "", "")
	token := flags.String("token", "", "")
	pidText := flags.String("pid", "", "")
	role := flags.String("role", "", "")
	if err := parseFlags(flags, arguments); err != nil {
		return err
	}
	if *root == "" || *token == "" || *pidText == "" || *role == "" {
		return usageError("release-record requires --root, --token, --pid, and --role")
	}
	if *role != agentSocketTrapLifecycleRole {
		return usageError("release-record role must be %s", agentSocketTrapLifecycleRole)
	}
	pid, err := parsePositiveInteger(*pidText, "process ID")
	if err != nil {
		return err
	}
	records, err := readRootRecords(*root, *token)
	if err != nil {
		return err
	}
	var matched *ownershipRecord
	for index := range records {
		record := &records[index]
		if record.PID != pid || record.Role != *role {
			continue
		}
		if matched != nil {
			return fmt.Errorf("multiple durable ownership records match process %d and role %s", pid, *role)
		}
		matched = record
	}
	if matched == nil {
		return fmt.Errorf("no durable ownership record matches process %d and role %s", pid, *role)
	}
	state, err := observedOwnershipState(*matched)
	if err != nil {
		return err
	}
	if state != "live" {
		return fmt.Errorf("process %d is %s; refusing lifecycle release", pid, state)
	}
	contents, err := encodeJSON(ownershipRelease{
		PID:                matched.PID,
		SessionToken:       matched.SessionToken,
		ExpectedExecutable: matched.ExpectedExecutable,
		Role:               matched.Role,
	})
	if err != nil {
		return err
	}
	return writeAtomic(
		filepath.Join(*root, "ownership-releases", strconv.Itoa(pid)+".json"),
		contents,
		0o600,
	)
}

func commandWaitGroups(arguments []string) error {
	flags := newFlagSet("wait-groups")
	root := flags.String("root", "", "")
	token := flags.String("token", "", "")
	expectedGroups := flags.Int("count", 0, "")
	timeoutMilliseconds := flags.Int("timeout-ms", 2_000, "")
	if err := parseFlags(flags, arguments); err != nil {
		return err
	}
	if *root == "" || *token == "" || *expectedGroups <= 0 {
		return usageError("wait-groups requires --root, --token, and positive --count")
	}
	duration, err := parseTimeout(*timeoutMilliseconds)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(duration)
	for {
		records, err := loadRecords(*root, *token, nil)
		if err != nil {
			return err
		}
		groups, err := loadWorkerGroups(*root, *token, records, true)
		if err != nil {
			return err
		}
		pending, err := hasPendingWorkerGroups(*root)
		if err != nil {
			return err
		}
		if len(groups) >= *expectedGroups && !pending {
			contents, err := encodeJSON(groups)
			if err != nil {
				return err
			}
			_, err = os.Stdout.Write(contents)
			return err
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("expected %d complete worker-group records, got %d", *expectedGroups, len(groups))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func commandRecords(arguments []string, states bool) error {
	flags := newFlagSet("records")
	root := flags.String("root", "", "")
	token := flags.String("token", "", "")
	role := flags.String("role", "", "")
	var recordFiles stringList
	flags.Var(&recordFiles, "record-file", "")
	if err := parseFlags(flags, arguments); err != nil {
		return err
	}
	if *token == "" || (*root == "" && len(recordFiles) == 0) {
		return usageError("records requires --token and --root or --record-file")
	}
	command := "records"
	if states {
		command = "states"
	}
	if *role != "" && *role != agentSocketTrapLifecycleRole {
		return usageError("%s role must be %s", command, agentSocketTrapLifecycleRole)
	}
	records, err := loadRecords(*root, *token, recordFiles)
	if err != nil {
		return err
	}
	records = selectRecords(records, nil, *role)
	if !states {
		contents, err := encodeJSON(records)
		if err != nil {
			return err
		}
		_, err = os.Stdout.Write(contents)
		return err
	}
	result := make([]ownershipState, 0, len(records))
	for _, record := range records {
		state, err := observedOwnershipState(record)
		if err != nil {
			return err
		}
		result = append(result, ownershipState{Record: record, State: state})
	}
	contents, err := encodeJSON(result)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(contents)
	return err
}

func commandCleanup(arguments []string) error {
	flags := newFlagSet("cleanup")
	root := flags.String("root", "", "")
	token := flags.String("token", "", "")
	role := flags.String("role", "", "")
	timeoutMilliseconds := flags.Int("timeout-ms", 1_000, "")
	var recordFiles stringList
	var selectedPIDs stringList
	flags.Var(&recordFiles, "record-file", "")
	flags.Var(&selectedPIDs, "pid", "")
	if err := parseFlags(flags, arguments); err != nil {
		return err
	}
	if *token == "" || (*root == "" && len(recordFiles) == 0) {
		return usageError("cleanup requires --token and --root or --record-file")
	}
	if *role != "" && *role != agentSocketTrapLifecycleRole {
		return usageError("cleanup role must be %s", agentSocketTrapLifecycleRole)
	}
	duration, err := parseTimeout(*timeoutMilliseconds)
	if err != nil {
		return err
	}
	selected := map[int]bool{}
	for _, value := range selectedPIDs {
		pid, err := parsePositiveInteger(value, "process ID")
		if err != nil {
			return err
		}
		selected[pid] = true
	}
	records, err := loadRecords(*root, *token, recordFiles)
	if err != nil {
		return err
	}
	records = selectRecords(records, selected, *role)
	if len(records) == 0 {
		if *role != "" && len(selected) > 0 {
			return fmt.Errorf("no durable ownership record matches requested process and role %s", *role)
		}
		if *role != "" {
			return fmt.Errorf("no durable ownership record matches requested role %s", *role)
		}
		if len(selected) > 0 {
			return fmt.Errorf("no durable ownership record matches requested process")
		}
	}
	for _, record := range records {
		if _, err := observedOwnershipState(record); err != nil {
			return err
		}
	}
	if *role != "" {
		// Lifecycle records name a direct fake-agent child, never a worker group.
		return terminateOwnedRecords(records, time.Now().Add(duration))
	}
	allRecords, err := loadRecords(*root, *token, recordFiles)
	if err != nil {
		return err
	}
	groups, err := loadWorkerGroups(*root, *token, allRecords, false)
	if err != nil {
		return err
	}
	if len(selected) > 0 {
		filtered := groups[:0]
		for _, group := range groups {
			for _, member := range group.Members {
				if selected[member.PID] {
					filtered = append(filtered, group)
					break
				}
			}
		}
		groups = filtered
	}
	deadline := time.Now().Add(duration)
	for _, group := range groups {
		if err := terminateWorkerGroup(group, deadline); err != nil {
			return err
		}
	}
	return terminateOwnedRecords(records, deadline)
}

func run(arguments []string) error {
	if len(arguments) == 0 {
		return usageError("usage: process-control <inspect|group|session|record|capture-group|wait-record|release-record|wait-groups|records|states|cleanup> ...")
	}
	switch arguments[0] {
	case "inspect":
		return commandInspect(arguments[1:])
	case "group":
		return commandGroup(arguments[1:])
	case "session":
		return commandSession(arguments[1:])
	case "record":
		return commandRecord(arguments[1:])
	case "capture-group":
		return commandCaptureGroup(arguments[1:])
	case "wait-record":
		return commandWaitRecord(arguments[1:])
	case "release-record":
		return commandReleaseRecord(arguments[1:])
	case "wait-groups":
		return commandWaitGroups(arguments[1:])
	case "records":
		return commandRecords(arguments[1:], false)
	case "states":
		return commandRecords(arguments[1:], true)
	case "cleanup":
		return commandCleanup(arguments[1:])
	default:
		return usageError("unknown command: %s", arguments[0])
	}
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		code := failureExitCode
		var commandErr *commandError
		if errors.As(err, &commandErr) {
			code = commandErr.code
		}
		fmt.Fprintf(os.Stderr, "process-control: %v\n", err)
		os.Exit(code)
	}
}
