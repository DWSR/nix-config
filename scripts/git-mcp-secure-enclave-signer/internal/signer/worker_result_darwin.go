//go:build darwin

package signer

import (
	"errors"
	"fmt"
	"syscall"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/supervisor"
)

const (
	workerResultFD   = 4
	workerResultSize = 5
)

var workerResultPrefix = [4]byte{'S', 'E', 'R', '1'}

type workerResultObserver struct {
	readerFD   int
	output     *capturedOutput
	setupError error
	message    []byte
}

func newWorkerResultObserver(readerFD int, output *capturedOutput, setupError error) *workerResultObserver {
	return &workerResultObserver{readerFD: readerFD, output: output, setupError: setupError}
}

func (observer *workerResultObserver) Observe(deadline time.Time) (supervisor.WorkerResult, error) {
	if observer.setupError != nil {
		err := observer.setupError
		observer.setupError = nil
		if errors.Is(err, errCapabilityDeadline) {
			return supervisor.WorkerResult{}, nil
		}
		return supervisor.WorkerResult{}, err
	}
	if err := observer.output.Drain(deadline); err != nil {
		return supervisor.WorkerResult{}, err
	}
	if !time.Now().Before(deadline) {
		return supervisor.WorkerResult{}, nil
	}

	buffer := make([]byte, workerResultSize-len(observer.message))
	read, err := syscall.Read(observer.readerFD, buffer)
	if read > 0 {
		observer.message = append(observer.message, buffer[:read]...)
		if len(observer.message) == workerResultSize {
			if string(observer.message[:len(workerResultPrefix)]) != string(workerResultPrefix[:]) {
				return supervisor.WorkerResult{}, errors.New("worker returned an invalid result record")
			}
			return supervisor.WorkerResult{Done: true, ExitCode: int(observer.message[workerResultSize-1])}, nil
		}
	}
	if err == nil && read == 0 {
		return supervisor.WorkerResult{}, errors.New("worker exited without a result record")
	}
	if errors.Is(err, syscall.EINTR) {
		return supervisor.WorkerResult{}, err
	}
	if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
		return supervisor.WorkerResult{}, nil
	}
	if err != nil {
		return supervisor.WorkerResult{}, fmt.Errorf("read worker result: %w", err)
	}
	return supervisor.WorkerResult{}, nil
}

func prepareWorkerResultReporting() {
	syscall.CloseOnExec(workerResultFD)
}

func ReportWorkerResult(exitCode int) {
	if exitCode < 0 || exitCode > 255 {
		exitCode = 125
	}
	record := [workerResultSize]byte{
		workerResultPrefix[0],
		workerResultPrefix[1],
		workerResultPrefix[2],
		workerResultPrefix[3],
		byte(exitCode),
	}
	_, _ = syscall.Write(workerResultFD, record[:])
}
