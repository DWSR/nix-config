//go:build darwin

package signer

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

const (
	modulePath   = "github.com/brandonmcnama/git-mcp-secure-enclave-signer"
	publicName   = "git-mcp-secure-enclave-signer"
	workerName   = "git-mcp-secure-enclave-signer-worker"
	fixtureKey   = "sk-ecdsa-sha2-nistp256@openssh.com AAAAfixtureprimary"
	fixturePrint = "SHA256:fixtureprimary"
	fixtureHash  = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
)

type runtime struct {
	public    string
	worker    string
	scAuth    string
	provider  string
	sshKeygen string
	log       string
}

type commandResult struct {
	stdout string
	stderr string
	err    error
}

type nativeCall struct {
	Arguments   []string `json:"arguments"`
	Environment []string `json:"environment"`
	CWD         string   `json:"cwd"`
	Provider    string   `json:"provider"`
	Tool        string   `json:"tool"`
}

func TestPublicSignerPassesNonSigningInvocationThroughUnchanged(t *testing.T) {
	runtime := buildRuntime(t)
	arguments := []string{"-Q", "cipher", "-f", "/tmp/key with spaces", "--", "literal-value"}

	result := runtime.run(t, runtime.public, arguments, nil)
	if result.err != nil {
		t.Fatalf("public signer failed: %v\nstderr: %s", result.err, result.stderr)
	}
	if result.stdout != "fixture-ssh-keygen-passthrough\n" {
		t.Fatalf("stdout = %q", result.stdout)
	}
	if result.stderr != "fixture-native-stderr\n" {
		t.Fatalf("stderr = %q", result.stderr)
	}

	calls := runtime.calls(t)
	if len(calls) != 1 {
		t.Fatalf("native calls = %#v", calls)
	}
	if calls[0].Tool != "fake-ssh-keygen" {
		t.Fatalf("tool = %q", calls[0].Tool)
	}
	if strings.Join(calls[0].Arguments, "\x00") != strings.Join(arguments, "\x00") {
		t.Fatalf("arguments = %#v, want %#v", calls[0].Arguments, arguments)
	}
}

func TestPublicSignerPassesNonSigningVerificationWorkerMarkersThroughUnchanged(t *testing.T) {
	runtime := buildRuntime(t)
	workingDirectory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	arguments := []string{
		"-Y", "verify",
		"-f", "/tmp/allowed signers",
		"-I", "--git-mcp-secure-enclave-signer-worker",
		"-n", "--signing-worker",
	}
	environment := map[string]string{
		"GIT_MCP_SIGNER_TEST_PASSTHROUGH": "preserve-this-environment-exactly",
	}

	result := runtime.runInDirectory(t, runtime.public, arguments, environment, workingDirectory)
	if result.err != nil {
		t.Fatalf("public signer failed: %v\nstdout: %s\nstderr: %s", result.err, result.stdout, result.stderr)
	}
	if result.stdout != "fixture-ssh-keygen-passthrough\n" {
		t.Fatalf("stdout = %q", result.stdout)
	}
	if result.stderr != "fixture-native-stderr\n" {
		t.Fatalf("stderr = %q", result.stderr)
	}

	calls := runtime.calls(t)
	if len(calls) != 1 {
		t.Fatalf("native calls = %#v", calls)
	}
	if calls[0].Tool != "fake-ssh-keygen" {
		t.Fatalf("tool = %q", calls[0].Tool)
	}
	if strings.Join(calls[0].Arguments, "\x00") != strings.Join(arguments, "\x00") {
		t.Fatalf("arguments = %#v, want %#v", calls[0].Arguments, arguments)
	}
	expectedEnvironment := runtime.environment(environment)
	if strings.Join(calls[0].Environment, "\x00") != strings.Join(expectedEnvironment, "\x00") {
		t.Fatal("inherited environment changed before ssh-keygen execution")
	}
	if calls[0].CWD != workingDirectory {
		t.Fatalf("cwd = %q, want %q", calls[0].CWD, workingDirectory)
	}
}

func TestPublicSignerPassesUnsupportedAndOpaqueYFormsThroughUnchanged(t *testing.T) {
	runtime := buildRuntime(t)
	workingDirectory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"GIT_MCP_SIGNER_TEST_PASSTHROUGH": "preserve-this-environment-exactly",
	}
	cases := []struct {
		name      string
		arguments []string
	}{
		{
			name:      "unsupported equals form",
			arguments: []string{"-Y=sign", "-n", "git", "-f", "/tmp/key", "payload"},
		},
		{
			name:      "end of options",
			arguments: []string{"--", "-Y", "sign", "-n", "git", "-f", "/tmp/key", "payload"},
		},
		{
			name:      "find principals",
			arguments: []string{"-Y", "find-principals", "-s", "/tmp/signature", "-f", "/tmp/allowed-signers"},
		},
		{
			name:      "match principals",
			arguments: []string{"-Y", "match-principals", "-I", "signer", "-f", "/tmp/allowed-signers"},
		},
		{
			name:      "check novalidate",
			arguments: []string{"-Y", "check-novalidate", "-n", "git", "-s", "/tmp/signature"},
		},
		{
			name:      "verify",
			arguments: []string{"-Y", "verify", "-f", "/tmp/allowed-signers", "-I", "signer", "-n", "git", "-s", "/tmp/signature", "-r", "/tmp/krl", "-O", "print-pubkey"},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			assertPublicPassthrough(t, runtime, testCase.arguments, environment, workingDirectory)
		})
	}
}

func TestPublicSignerDoesNotTreatSSHKeygenOptionValuesAsSigningSelectors(t *testing.T) {
	runtime := buildRuntime(t)
	for _, option := range []string{
		"-a", "-b", "-C", "-D", "-E", "-f", "-F", "-I", "-m", "-M", "-n",
		"-N", "-O", "-P", "-r", "-s", "-t", "-V", "-w", "-Z", "-z",
	} {
		t.Run(option, func(t *testing.T) {
			assertPublicPassthrough(t, runtime, []string{option, "-Ysign", "opaque"}, nil, "")
		})
	}
	assertPublicPassthrough(t, runtime, []string{"-n", "-Y", "sign"}, nil, "")
}

func TestPrivateWorkerRefusesDirectInvocationBeforeNativePreflight(t *testing.T) {
	runtime := buildRuntime(t)
	stub := writeSigningState(t)

	result := runtime.run(t, runtime.worker, signingArguments(stub, "-Y", "sign"), signingEnvironment(stub))
	if result.err == nil || commandExitCode(result.err) == 0 {
		t.Fatalf("direct private worker invocation succeeded: stdout=%q stderr=%q", result.stdout, result.stderr)
	}
	if !strings.Contains(strings.ToLower(result.stderr), "capability") {
		t.Fatalf("direct private worker diagnostic = %q", result.stderr)
	}
	if calls := runtime.calls(t); len(calls) != 0 {
		t.Fatalf("direct private worker reached native preflight: %#v", calls)
	}
}

func TestPrivateWorkerRejectsCapabilityFromNonPublicParentBeforeNativePreflight(t *testing.T) {
	runtime := buildRuntime(t)
	stub := writeSigningState(t)
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	writer := os.NewFile(uintptr(fds[0]), "forged-capability-writer")
	reader := os.NewFile(uintptr(fds[1]), "forged-capability-reader")
	defer writer.Close()
	defer reader.Close()
	if _, err := writer.Write(bytes.Repeat([]byte{1}, capabilitySize)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	process := exec.Command(runtime.worker, signingArguments(stub, "-Y", "sign")...)
	process.Env = runtime.environment(signingEnvironment(stub))
	process.ExtraFiles = []*os.File{reader}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	process.Stdout = &stdout
	process.Stderr = &stderr
	err = process.Run()
	if err == nil || commandExitCode(err) == 0 {
		t.Fatalf("worker accepted a non-public parent: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
	if !strings.Contains(strings.ToLower(stderr.String()), "fixed packaged public signer") {
		t.Fatalf("forged-capability diagnostic = %q", stderr.String())
	}
	if calls := runtime.calls(t); len(calls) != 0 {
		t.Fatalf("forged capability reached native preflight: %#v", calls)
	}
}

func TestPublicSignerUsesPrivateGoWorkerForEverySupportedSigningForm(t *testing.T) {
	forms := [][]string{
		{"-Y", "sign"},
		{"-Ysign"},
	}

	for _, form := range forms {
		t.Run(strings.Join(form, " "), func(t *testing.T) {
			runtime := buildRuntime(t)
			stub := writeSigningState(t)

			result := runtime.run(t, runtime.public, signingArguments(stub, form...), signingEnvironment(stub))
			if result.err != nil {
				t.Fatalf("public signer failed: %v\nstderr: %s", result.err, result.stderr)
			}
			if result.stdout != "fixture-ssh-signature:"+fixtureKey+"\n" {
				t.Fatalf("signature result = %q", result.stdout)
			}

			calls := runtime.calls(t)
			if !hasSigningCall(calls) {
				t.Fatalf("public signer did not reach the injected signing tool: %#v", calls)
			}
			for _, call := range calls {
				if call.Tool == "fake-ssh-keygen" && isSigningInvocation(call.Arguments) && call.Provider != runtime.provider {
					t.Fatalf("signing provider = %q, want fixed injected path %q", call.Provider, runtime.provider)
				}
			}
		})
	}
}

func TestPublicSignerPreservesMarkerLookingSigningOptionValues(t *testing.T) {
	for _, marker := range []string{"--signing-worker", "--git-mcp-secure-enclave-signer-worker"} {
		t.Run(marker, func(t *testing.T) {
			runtime := buildRuntime(t)
			stub := writeSigningState(t)
			arguments := []string{"-Y", "sign", "-n", marker, "-f", stub, "payload"}

			result := runtime.run(t, runtime.public, arguments, signingEnvironment(stub))
			if result.err != nil {
				t.Fatalf("public signer failed: %v\nstderr: %s", result.err, result.stderr)
			}
			if result.stdout != "fixture-ssh-signature:"+fixtureKey+"\n" {
				t.Fatalf("signature result = %q", result.stdout)
			}

			var signingCalls []nativeCall
			for _, call := range runtime.calls(t) {
				if call.Tool == "fake-ssh-keygen" && isSigningInvocation(call.Arguments) {
					signingCalls = append(signingCalls, call)
				}
			}
			if len(signingCalls) != 1 {
				t.Fatalf("signing calls = %#v", signingCalls)
			}
			if strings.Join(signingCalls[0].Arguments, "\x00") != strings.Join(arguments, "\x00") {
				t.Fatalf("signing arguments = %#v, want %#v", signingCalls[0].Arguments, arguments)
			}
			if signingCalls[0].Provider != runtime.provider {
				t.Fatalf("signing provider = %q, want fixed injected path %q", signingCalls[0].Provider, runtime.provider)
			}
		})
	}
}

func TestPreflightFailuresAreFailClosedBeforeSigning(t *testing.T) {
	cases := []struct {
		name       string
		configure  func(t *testing.T, runtime runtime, stub string) map[string]string
		diagnostic string
	}{
		{
			name: "provider",
			configure: func(_ *testing.T, _ runtime, _ string) map[string]string {
				return map[string]string{"SSH_SK_PROVIDER": "/wrong/provider"}
			},
			diagnostic: "SSH_SK_PROVIDER",
		},
		{
			name: "selector",
			configure: func(_ *testing.T, _ runtime, _ string) map[string]string {
				return map[string]string{"KEYCHAIN_CERTIFICATES": strings.Repeat("2", 40)}
			},
			diagnostic: "KEYCHAIN_CERTIFICATES",
		},
		{
			name: "resident stub",
			configure: func(t *testing.T, _ runtime, stub string) map[string]string {
				if err := os.Remove(stub); err != nil {
					t.Fatal(err)
				}
				return nil
			},
			diagnostic: "resident stub",
		},
		{
			name: "public key",
			configure: func(_ *testing.T, _ runtime, _ string) map[string]string {
				return map[string]string{"GIT_MCP_SIGNING_PUBLIC_KEY": "sk-ecdsa-sha2-nistp256@openssh.com AAAAwrong"}
			},
			diagnostic: "public key",
		},
		{
			name: "fingerprint",
			configure: func(_ *testing.T, _ runtime, _ string) map[string]string {
				return map[string]string{"GIT_MCP_SIGNING_FINGERPRINT": "SHA256:wrong"}
			},
			diagnostic: "fingerprint",
		},
		{
			name: "CTK identity",
			configure: func(_ *testing.T, _ runtime, _ string) map[string]string {
				return map[string]string{"GIT_MCP_SIGNER_TEST_CTK_OUTPUT": "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid\n"}
			},
			diagnostic: "exactly one resident identity",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			runtime := buildRuntime(t)
			stub := writeSigningState(t)

			environment := signingEnvironment(stub)
			for key, value := range testCase.configure(t, runtime, stub) {
				environment[key] = value
			}
			result := runtime.run(t, runtime.public, signingArguments(stub, "-Y", "sign"), environment)
			if result.err == nil || commandExitCode(result.err) == 0 {
				t.Fatalf("preflight failure succeeded: stdout=%q stderr=%q", result.stdout, result.stderr)
			}
			if !strings.Contains(strings.ToLower(result.stderr), strings.ToLower(testCase.diagnostic)) {
				t.Fatalf("diagnostic = %q, want %q", result.stderr, testCase.diagnostic)
			}
			if hasSigningCall(runtime.calls(t)) {
				t.Fatalf("preflight failure delegated signing: %#v", runtime.calls(t))
			}
		})
	}
}

func TestCaptureNativeOutputBoundsEachPreflightStream(t *testing.T) {
	runtime := buildRuntime(t)
	for _, testCase := range []struct {
		name        string
		outputBytes string
		stderrBytes string
	}{
		{
			name:        "stdout",
			outputBytes: strconv.Itoa(maxCapturedOutput + 1),
		},
		{
			name:        "stderr",
			stderrBytes: strconv.Itoa(maxCapturedOutput + 1),
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("GIT_MCP_SIGNER_TEST_CTK_OUTPUT", validCTKListing())
			t.Setenv("GIT_MCP_SIGNER_TEST_CTK_OUTPUT_BYTES", testCase.outputBytes)
			t.Setenv("GIT_MCP_SIGNER_TEST_CTK_STDERR_BYTES", testCase.stderrBytes)

			redirectedStderr, err := os.CreateTemp(t.TempDir(), "native-stderr")
			if err != nil {
				t.Fatal(err)
			}
			originalStderr := os.Stderr
			var output []byte
			var captureErr error
			func() {
				defer func() {
					os.Stderr = originalStderr
					_ = redirectedStderr.Close()
				}()
				os.Stderr = redirectedStderr
				output, captureErr = captureNativeOutput(runtime.scAuth, "list-ctk-identities", "-t", "sha1", "-e", "hex")
			}()

			if !errors.Is(captureErr, errOutputTooLarge) {
				t.Fatalf("captureNativeOutput error = %v, want bounded-output error", captureErr)
			}
			if output != nil {
				t.Fatalf("captureNativeOutput retained %d bytes after overflow", len(output))
			}
		})
	}
}

func TestPreflightRejectsOversizedNativeOutputBeforeSigning(t *testing.T) {
	runtime := buildRuntime(t)
	stub := writeSigningState(t)

	result := runtime.run(t, runtime.public, signingArguments(stub, "-Y", "sign"), map[string]string{
		"GIT_MCP_SIGNER_TEST_CTK_OUTPUT_BYTES": strconv.Itoa(maxCapturedOutput + 1),
		"GIT_MCP_SIGNING_STUB":                 stub,
	})

	if result.err == nil || commandExitCode(result.err) == 0 {
		t.Fatalf("oversized native preflight output succeeded: stdout=%q stderr=%q", result.stdout, result.stderr)
	}
	if !strings.Contains(result.stderr, "preflight output exceeded bounded capacity") {
		t.Fatalf("oversized native output diagnostic = %q", result.stderr)
	}
	if hasSigningCall(runtime.calls(t)) {
		t.Fatalf("oversized native preflight output delegated signing: %#v", runtime.calls(t))
	}
}

func TestListedFingerprintRejectsWhitespaceMalformedNativeOutput(t *testing.T) {
	if _, err := listedFingerprint("256 " + fixturePrint + " fixture-key\n"); err != nil {
		t.Fatalf("valid fingerprint listing rejected: %v", err)
	}
	if _, err := listedFingerprint("256  " + fixturePrint + " fixture-key\n"); err == nil {
		t.Fatal("malformed fingerprint listing was accepted")
	}
}

func TestCountConfiguredCTKIdentitiesAcceptsISOValidityDate(t *testing.T) {
	listing := strings.Replace(validCTKListing(), "23.11.26,", "2026-09-14,", 1)

	count, err := countConfiguredCTKIdentities(listing, fixtureHash)
	if err != nil {
		t.Fatalf("ISO validity date rejected: %v", err)
	}
	if count != 1 {
		t.Fatalf("matching identity count = %d, want 1", count)
	}
}

func buildRuntime(t *testing.T) runtime {
	t.Helper()
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	libexec := filepath.Join(root, "libexec")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(libexec, 0o755); err != nil {
		t.Fatal(err)
	}

	nativeTool := filepath.Join(root, "native-tool")
	buildGo(t, nativeTool, nil, "./internal/signer/testdata/native-tool")
	runtime := runtime{
		public:    filepath.Join(bin, publicName),
		worker:    filepath.Join(libexec, workerName),
		scAuth:    filepath.Join(root, "fake-sc-auth"),
		provider:  filepath.Join(root, "fake-provider"),
		sshKeygen: filepath.Join(root, "fake-ssh-keygen"),
		log:       filepath.Join(root, "native-calls.jsonl"),
	}
	for _, destination := range []string{runtime.scAuth, runtime.provider, runtime.sshKeygen} {
		if err := os.Link(nativeTool, destination); err != nil {
			t.Fatal(err)
		}
	}

	ldflags := map[string]string{
		modulePath + "/internal/config.ScAuthPath":    runtime.scAuth,
		modulePath + "/internal/config.ProviderPath":  runtime.provider,
		modulePath + "/internal/config.SSHKeygenPath": runtime.sshKeygen,
	}
	buildGo(t, runtime.public, ldflags, "./cmd/signer")
	buildGo(t, runtime.worker, ldflags, "./cmd/worker")
	return runtime
}

func buildGo(t *testing.T, output string, ldflags map[string]string, packagePath string) {
	t.Helper()
	arguments := []string{"build", "-o", output}
	if len(ldflags) > 0 {
		keys := make([]string, 0, len(ldflags))
		for key := range ldflags {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys)*2)
		for _, key := range keys {
			parts = append(parts, "-X", key+"="+ldflags[key])
		}
		arguments = append(arguments, "-ldflags", strings.Join(parts, " "))
	}
	arguments = append(arguments, packagePath)
	command := exec.Command("go", arguments...)
	command.Dir = moduleRoot(t)
	outputBytes, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("go %s failed: %v\n%s", strings.Join(arguments, " "), err, outputBytes)
	}
}

func moduleRoot(t *testing.T) string {
	t.Helper()
	directory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(directory, "go.mod")); err == nil {
			return directory
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			t.Fatal("could not locate signer go.mod")
		}
		directory = parent
	}
}

func writeSigningState(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	stub := filepath.Join(directory, "id_ecdsa_sk_rk")
	if err := os.WriteFile(stub, []byte("resident-handle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stub+".pub", []byte(fixtureKey+" fixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return stub
}

func signingArguments(stub string, form ...string) []string {
	arguments := append([]string{}, form...)
	arguments = append(arguments, "-n", "git", "-f", stub, "payload")
	return arguments
}

func signingEnvironment(stub string) map[string]string {
	return map[string]string{"GIT_MCP_SIGNING_STUB": stub}
}

func (runtime runtime) run(t *testing.T, command string, arguments []string, additional map[string]string) commandResult {
	return runtime.runInDirectory(t, command, arguments, additional, "")
}

func (runtime runtime) runInDirectory(t *testing.T, command string, arguments []string, additional map[string]string, directory string) commandResult {
	t.Helper()
	process := exec.Command(command, arguments...)
	process.Dir = directory
	process.Env = runtime.environment(additional)
	process.Stdin = strings.NewReader("")
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	process.Stdout = &stdout
	process.Stderr = &stderr
	err := process.Run()
	return commandResult{stdout: stdout.String(), stderr: stderr.String(), err: err}
}

func assertPublicPassthrough(t *testing.T, runtime runtime, arguments []string, environment map[string]string, directory string) {
	t.Helper()
	if err := os.Remove(runtime.log); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	result := runtime.runInDirectory(t, runtime.public, arguments, environment, directory)
	if result.err != nil {
		t.Fatalf("public signer failed: %v\nstdout: %s\nstderr: %s", result.err, result.stdout, result.stderr)
	}
	if result.stdout != "fixture-ssh-keygen-passthrough\n" {
		t.Fatalf("stdout = %q", result.stdout)
	}
	if result.stderr != "fixture-native-stderr\n" {
		t.Fatalf("stderr = %q", result.stderr)
	}

	calls := runtime.calls(t)
	if len(calls) != 1 {
		t.Fatalf("native calls = %#v", calls)
	}
	if calls[0].Tool != "fake-ssh-keygen" {
		t.Fatalf("tool = %q", calls[0].Tool)
	}
	if strings.Join(calls[0].Arguments, "\x00") != strings.Join(arguments, "\x00") {
		t.Fatalf("arguments = %#v, want %#v", calls[0].Arguments, arguments)
	}
	expectedEnvironment := runtime.environment(environment)
	if strings.Join(calls[0].Environment, "\x00") != strings.Join(expectedEnvironment, "\x00") {
		t.Fatal("inherited environment changed before ssh-keygen execution")
	}
	if directory != "" && calls[0].CWD != directory {
		t.Fatalf("cwd = %q, want %q", calls[0].CWD, directory)
	}
}

func (runtime runtime) environment(additional map[string]string) []string {
	values := map[string]string{
		"GIT_MCP_SIGNER_TEST_CTK_OUTPUT":    validCTKListing(),
		"GIT_MCP_SIGNER_TEST_FINGERPRINT":   fixturePrint,
		"GIT_MCP_SIGNER_TEST_LOG":           runtime.log,
		"GIT_MCP_SIGNER_TEST_NATIVE_STDERR": "fixture-native-stderr\n",
		"GIT_MCP_SIGNER_TEST_PUBLIC_KEY":    fixtureKey,
		"GIT_MCP_SIGNING_CTK_HASH":          fixtureHash,
		"GIT_MCP_SIGNING_FINGERPRINT":       fixturePrint,
		"GIT_MCP_SIGNING_PUBLIC_KEY":        fixtureKey,
		"KEYCHAIN_CERTIFICATES":             fixtureHash,
		"SSH_SK_PROVIDER":                   runtime.provider,
	}
	for key, value := range additional {
		values[key] = value
	}

	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if found {
			environment[key] = value
		}
	}
	for key, value := range values {
		environment[key] = value
	}
	entries := make([]string, 0, len(environment))
	for key, value := range environment {
		entries = append(entries, key+"="+value)
	}
	sort.Strings(entries)
	return entries
}

func (runtime runtime) calls(t *testing.T) []nativeCall {
	t.Helper()
	file, err := os.Open(runtime.log)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()

	var calls []nativeCall
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var call nativeCall
		if err := json.Unmarshal(scanner.Bytes(), &call); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, call)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return calls
}

func validCTKListing() string {
	return "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid\n" +
		"p-256-ne ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD none fixture-primary ssh 23.11.26, 17:09 YES\n"
}

func hasSigningCall(calls []nativeCall) bool {
	for _, call := range calls {
		if call.Tool == "fake-ssh-keygen" && isSigningInvocation(call.Arguments) {
			return true
		}
	}
	return false
}

func commandExitCode(err error) int {
	var exitError *exec.ExitError
	if errors.As(err, &exitError) {
		return exitError.ExitCode()
	}
	return -1
}
