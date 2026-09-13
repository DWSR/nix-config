//go:build darwin

package signer

/*
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

static int signer_write_output(int fd, const void *buffer, int length, int timeout_milliseconds, int *written, int *error_number) {
  struct pollfd descriptor = { .fd = fd, .events = POLLOUT, .revents = 0 };
  int ready;
  int flags;
  int restore_result;
  int restore_error;
  ssize_t result;

  *written = 0;
  *error_number = 0;
  errno = 0;
  ready = poll(&descriptor, 1, timeout_milliseconds);
  if (ready <= 0) {
    *error_number = ready == 0 ? EAGAIN : errno;
    return -1;
  }
  if ((descriptor.revents & POLLOUT) == 0) {
    *error_number = EPIPE;
    return -1;
  }

  errno = 0;
  flags = fcntl(fd, F_GETFL);
  if (flags == -1) {
    *error_number = errno;
    return -1;
  }
  if (fcntl(fd, F_SETFL, flags | O_NONBLOCK) == -1) {
    *error_number = errno;
    return -1;
  }

  errno = 0;
  result = write(fd, buffer, (size_t)length);
  *error_number = errno;
  errno = 0;
  restore_result = fcntl(fd, F_SETFL, flags);
  restore_error = errno;
  if (result < 0) {
    return -1;
  }
  if (restore_result == -1) {
    *error_number = restore_error;
    return -1;
  }
  *written = (int)result;
  return 0;
}
*/
import "C"

import (
	"errors"
	"fmt"
	"io"
	"os"
	"syscall"
	"time"
	"unsafe"
)

const (
	outputReadSize    = 32 * 1024
	maxCapturedOutput = 1024 * 1024
)

var (
	errOutputDeadline = errors.New("captured worker output did not complete before cleanup deadline")
	errOutputTooLarge = errors.New("captured worker output exceeded bounded capacity")
)

type capturedOutput struct {
	stdout capturedStream
	stderr capturedStream
}

type capturedStream struct {
	readerFD int
	contents []byte
	closed   bool
	relayed  int
}

type nativeOutputCapture struct {
	contents [maxCapturedOutput]byte
	length   int
	overflow bool
	stop     func()
}

func newCapturedOutput(stdoutFD, stderrFD int) *capturedOutput {
	return &capturedOutput{
		stdout: capturedStream{readerFD: stdoutFD},
		stderr: capturedStream{readerFD: stderrFD},
	}
}

func (output *nativeOutputCapture) Write(contents []byte) (int, error) {
	if output.overflow {
		return len(contents), errOutputTooLarge
	}
	remaining := len(output.contents) - output.length
	if len(contents) > remaining {
		output.length += copy(output.contents[output.length:], contents[:remaining])
		output.overflow = true
		output.stop()
		return len(contents), errOutputTooLarge
	}
	output.length += copy(output.contents[output.length:], contents)
	return len(contents), nil
}

func (output *nativeOutputCapture) bytes() []byte {
	return output.contents[:output.length]
}

func (output *capturedOutput) Drain(deadline time.Time) error {
	for {
		stdoutProgress, err := output.stdout.drain(deadline)
		if err != nil {
			return err
		}
		stderrProgress, err := output.stderr.drain(deadline)
		if err != nil {
			return err
		}
		if !stdoutProgress && !stderrProgress {
			return nil
		}
	}
}

func (output *capturedOutput) Relay(deadline time.Time) error {
	if err := output.Drain(deadline); err != nil {
		return err
	}
	if !output.stdout.closed || !output.stderr.closed {
		return syscall.EAGAIN
	}
	if err := output.stdout.relay(int(os.Stdout.Fd()), deadline); err != nil {
		return err
	}
	return output.stderr.relay(int(os.Stderr.Fd()), deadline)
}

func (stream *capturedStream) drain(deadline time.Time) (bool, error) {
	if stream.closed || !time.Now().Before(deadline) {
		return false, nil
	}

	progressed := false
	buffer := make([]byte, outputReadSize)
	for time.Now().Before(deadline) {
		read, err := syscall.Read(stream.readerFD, buffer)
		if read > 0 {
			if len(stream.contents)+read > maxCapturedOutput {
				return progressed, errOutputTooLarge
			}
			stream.contents = append(stream.contents, buffer[:read]...)
			progressed = true
		}
		if err == nil {
			if read == 0 {
				stream.closed = true
				return true, nil
			}
			continue
		}
		if errors.Is(err, syscall.EINTR) {
			return progressed, err
		}
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
			return progressed, nil
		}
		return progressed, fmt.Errorf("read captured worker output: %w", err)
	}
	return progressed, nil
}

func (stream *capturedStream) relay(destinationFD int, deadline time.Time) error {
	for stream.relayed < len(stream.contents) {
		if !time.Now().Before(deadline) {
			return errOutputDeadline
		}
		end := stream.relayed + outputReadSize
		if end > len(stream.contents) {
			end = len(stream.contents)
		}
		written, err := writeOutput(destinationFD, stream.contents[stream.relayed:end], deadline)
		if written > 0 {
			stream.relayed += written
		}
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func writeOutput(fd int, output []byte, deadline time.Time) (int, error) {
	if !time.Now().Before(deadline) {
		return 0, errOutputDeadline
	}
	timeout := time.Until(deadline) / time.Millisecond
	if timeout < 1 {
		timeout = 1
	}
	if timeout > 10 {
		timeout = 10
	}
	var written C.int
	var errorNumber C.int
	if C.signer_write_output(
		C.int(fd),
		unsafe.Pointer(&output[0]),
		C.int(len(output)),
		C.int(timeout),
		&written,
		&errorNumber,
	) != 0 {
		if errorNumber != 0 {
			return int(written), syscall.Errno(errorNumber)
		}
		return int(written), errors.New("bounded output relay failed without errno")
	}
	return int(written), nil
}
