//go:build darwin

package signer

/*
#include <libproc.h>
#include <sys/types.h>

static int signer_proc_pidpath(pid_t pid, void *buffer, uint32_t size) {
  return proc_pidpath(pid, buffer, size);
}
*/
import "C"

import (
	"errors"
	"os"
	"path/filepath"
	"unsafe"
)

func currentExecutablePath() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	return canonicalExecutablePath(path)
}

func canonicalExecutablePath(path string) (string, error) {
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absPath)
}

func parentExecutablePath(pid int) (string, error) {
	buffer := make([]byte, 4096)
	length := C.signer_proc_pidpath(C.pid_t(pid), unsafe.Pointer(&buffer[0]), C.uint32_t(len(buffer)))
	if length <= 0 || int(length) >= len(buffer) {
		return "", errors.New("could not inspect parent executable")
	}
	return string(buffer[:int(length)]), nil
}
