package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
)

type nativeCall struct {
	Arguments   []string `json:"arguments"`
	Environment []string `json:"environment"`
	CWD         string   `json:"cwd"`
	Provider    string   `json:"provider"`
	Tool        string   `json:"tool"`
}

func main() {
	arguments := os.Args[1:]
	tool := filepath.Base(os.Args[0])
	logCall(tool, arguments)

	switch tool {
	case "fake-sc-auth":
		mustWriteRepeated(os.Stderr, environmentCount("GIT_MCP_SIGNER_TEST_CTK_STDERR_BYTES"))
		mustWrite(os.Stdout, os.Getenv("GIT_MCP_SIGNER_TEST_CTK_OUTPUT"))
		mustWriteRepeated(os.Stdout, environmentCount("GIT_MCP_SIGNER_TEST_CTK_OUTPUT_BYTES"))
	case "fake-ssh-keygen":
		runSSHKeygen(arguments)
	case "fake-provider":
		mustWrite(os.Stdout, "fixture-provider\n")
	default:
		fmt.Fprintf(os.Stderr, "unknown test native tool %q\n", tool)
		os.Exit(64)
	}
}

func runSSHKeygen(arguments []string) {
	if len(arguments) > 0 && arguments[0] == "-y" {
		mustWrite(os.Stdout, os.Getenv("GIT_MCP_SIGNER_TEST_PUBLIC_KEY")+"\n")
		return
	}
	if len(arguments) > 0 && arguments[0] == "-lf" {
		fmt.Fprintf(os.Stdout, "256 %s fixture-key\n", os.Getenv("GIT_MCP_SIGNER_TEST_FINGERPRINT"))
		return
	}
	if isSigningInvocation(arguments) {
		if status, err := strconv.Atoi(os.Getenv("GIT_MCP_SIGNER_TEST_SIGN_STATUS")); err == nil && status != 0 {
			mustWrite(os.Stderr, "fixture provider rejected signing\n")
			os.Exit(status)
		}
		mustWrite(os.Stdout, "fixture-ssh-signature:"+os.Getenv("GIT_MCP_SIGNER_TEST_PUBLIC_KEY")+"\n")
		return
	}
	mustWrite(os.Stdout, "fixture-ssh-keygen-passthrough\n")
	mustWrite(os.Stderr, os.Getenv("GIT_MCP_SIGNER_TEST_NATIVE_STDERR"))
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

func logCall(tool string, arguments []string) {
	path := os.Getenv("GIT_MCP_SIGNER_TEST_LOG")
	if path == "" {
		return
	}
	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}
	environment := append([]string(nil), os.Environ()...)
	sort.Strings(environment)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(nativeCall{
		Arguments:   arguments,
		Environment: environment,
		CWD:         cwd,
		Provider:    os.Getenv("SSH_SK_PROVIDER"),
		Tool:        tool,
	}); err != nil {
		panic(err)
	}
}

func mustWrite(file *os.File, value string) {
	if _, err := fmt.Fprint(file, value); err != nil {
		panic(err)
	}
}

func environmentCount(name string) int {
	count, err := strconv.Atoi(os.Getenv(name))
	if err != nil || count < 0 {
		return 0
	}
	return count
}

func mustWriteRepeated(file *os.File, count int) {
	var buffer [4096]byte
	for index := range buffer {
		buffer[index] = 'x'
	}
	for count > 0 {
		length := len(buffer)
		if count < length {
			length = count
		}
		if _, err := file.Write(buffer[:length]); err != nil {
			return
		}
		count -= length
	}
}
