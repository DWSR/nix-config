//go:build darwin

package signer

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

type signerError struct {
	code    int
	message string
}

type silentExit struct {
	code int
}

func (err silentExit) Error() string {
	return fmt.Sprintf("worker exited with status %d", err.code)
}

func (err signerError) Error() string {
	return err.message
}

func failure(code int, message string) error {
	return signerError{code: code, message: message}
}

func ExitCode(err error) int {
	var silent silentExit
	if errors.As(err, &silent) {
		return silent.code
	}
	var childExit *exec.ExitError
	if errors.As(err, &childExit) {
		return childExit.ExitCode()
	}
	var signerFailure signerError
	if errors.As(err, &signerFailure) {
		return signerFailure.code
	}
	return 125
}

func ReportError(err error) {
	var silent silentExit
	if errors.As(err, &silent) {
		return
	}
	var childExit *exec.ExitError
	if errors.As(err, &childExit) {
		return
	}
	fmt.Fprintf(os.Stderr, "[git-mcp-secure-enclave-signer] %s\n", err)
}
