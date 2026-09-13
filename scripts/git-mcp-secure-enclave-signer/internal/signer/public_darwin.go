//go:build darwin

package signer

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/config"
)

const (
	capabilitySize = 32
	workerBinary   = "git-mcp-secure-enclave-signer-worker"
)

func RunPublic(arguments []string) error {
	if !isSigningInvocation(arguments) {
		if config.SSHKeygenPath == "" {
			return failure(126, "packaged Apple ssh-keygen path is absent; restore the signer package and retry")
		}
		if err := syscall.Exec(config.SSHKeygenPath, append([]string{config.SSHKeygenPath}, arguments...), os.Environ()); err != nil {
			return failure(126, fmt.Sprintf("cannot execute Apple ssh-keygen %s: %v", config.SSHKeygenPath, err))
		}
		return nil
	}

	attemptStart := time.Now()
	workerPath, err := privateWorkerPath()
	if err != nil {
		return err
	}
	return runPrivateWorker(workerPath, arguments, attemptStart)
}

func isSigningInvocation(arguments []string) bool {
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		switch argument {
		case "--":
			return false
		case "-Ysign":
			return true
		case "-Y":
			if index+1 >= len(arguments) || arguments[index+1] == "--" {
				return false
			}
			if arguments[index+1] == "sign" {
				return true
			}
			index++
		default:
			if sshKeygenOptionTakesArgument(argument) {
				if index+1 >= len(arguments) || arguments[index+1] == "--" {
					return false
				}
				index++
			}
		}
	}
	return false
}

func sshKeygenOptionTakesArgument(argument string) bool {
	switch argument {
	case "-a", "-b", "-C", "-D", "-E", "-f", "-F", "-I", "-m", "-M", "-n", "-N", "-O", "-P", "-r", "-s", "-t", "-V", "-w", "-Z", "-z":
		return true
	default:
		return false
	}
}

func privateWorkerPath() (string, error) {
	publicPath, err := currentExecutablePath()
	if err != nil {
		return "", failure(125, fmt.Sprintf("cannot resolve packaged public signer path: %v", err))
	}
	workerPath := filepath.Clean(filepath.Join(filepath.Dir(publicPath), "..", "libexec", workerBinary))
	if err := requireExecutable(workerPath); err != nil {
		return "", failure(125, fmt.Sprintf("packaged signing worker %s is absent or not executable; restore the signer package and retry", workerPath))
	}
	return workerPath, nil
}
