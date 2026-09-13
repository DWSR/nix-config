//go:build darwin

package signer

import (
	"errors"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestWriteOutputReturnsBackpressureInsteadOfBlocking(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	writerFD := int(writer.Fd())
	if err := syscall.SetNonblock(writerFD, true); err != nil {
		t.Fatal(err)
	}

	buffer := make([]byte, outputReadSize)
	full := false
	for attempt := 0; attempt < 128; attempt++ {
		_, err := syscall.Write(writerFD, buffer)
		if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EWOULDBLOCK) {
			full = true
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !full {
		t.Fatal("could not fill pipe to establish relay backpressure")
	}

	written, err := writeOutput(writerFD, []byte("x"), time.Now().Add(time.Second))
	if written != 0 || (!errors.Is(err, syscall.EAGAIN) && !errors.Is(err, syscall.EWOULDBLOCK)) {
		t.Fatalf("writeOutput = (%d, %v), want (0, EAGAIN)", written, err)
	}
}
