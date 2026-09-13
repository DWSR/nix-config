//go:build darwin

package signer

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/brandonmcnama/git-mcp-secure-enclave-signer/internal/config"
)

var (
	fingerprintPattern = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/=]+$`)
	hexHashPattern     = regexp.MustCompile(`^[0-9a-f]{40}$`)
	keyDataPattern     = regexp.MustCompile(`^[A-Za-z0-9+/=]+$`)
	listingDatePattern = regexp.MustCompile(`^[0-9]{2}\.[0-9]{2}\.[0-9]{2},$`)
	listingHashPattern = regexp.MustCompile(`^[0-9A-Fa-f]{40}$`)
	listingTimePattern = regexp.MustCompile(`^[0-9]{2}:[0-9]{2}$`)
)

func RunWorker(arguments []string) error {
	prepareWorkerResultReporting()
	if err := requireCapability(); err != nil {
		return err
	}
	if err := requirePublicSignerParent(); err != nil {
		return err
	}
	return preflightAndSign(arguments)
}

func requireCapability() error {
	capabilityFile := os.NewFile(3, "signing-worker-capability")
	if capabilityFile == nil {
		return failure(1, "signing worker requires a one-shot capability from the packaged public signer")
	}
	defer capabilityFile.Close()
	capability, err := io.ReadAll(capabilityFile)
	if err != nil || len(capability) != capabilitySize {
		return failure(1, "signing worker requires a one-shot capability from the packaged public signer")
	}
	for _, value := range capability {
		if value != 0 {
			return nil
		}
	}
	return failure(1, "signing worker requires a one-shot capability from the packaged public signer")
}

func requirePublicSignerParent() error {
	workerPath, err := currentExecutablePath()
	if err != nil {
		return failure(1, fmt.Sprintf("signing worker cannot resolve its packaged path: %v", err))
	}
	expectedPublicPath := filepath.Clean(filepath.Join(filepath.Dir(workerPath), "..", "bin", "git-mcp-secure-enclave-signer"))
	expectedPublicPath, err = canonicalExecutablePath(expectedPublicPath)
	if err != nil {
		return failure(1, fmt.Sprintf("signing worker cannot resolve packaged public signer path: %v", err))
	}
	parentPath, err := parentExecutablePath(os.Getppid())
	if err != nil {
		return failure(1, "signing worker was not started by the fixed packaged public signer")
	}
	parentPath, err = canonicalExecutablePath(parentPath)
	if err != nil || parentPath != expectedPublicPath {
		return failure(1, "signing worker was not started by the fixed packaged public signer")
	}
	return nil
}

func preflightAndSign(arguments []string) error {
	if err := requireNativePaths(); err != nil {
		return err
	}
	if os.Getenv("SSH_SK_PROVIDER") != config.ProviderPath {
		return failure(1, fmt.Sprintf("SSH_SK_PROVIDER must be %s; restore the Apple provider path and retry", config.ProviderPath))
	}
	if err := requireReadable(config.ProviderPath); err != nil {
		return failure(1, fmt.Sprintf("signing provider %s is absent or unreadable; restore the Apple provider and retry", config.ProviderPath))
	}
	if err := requireExecutable(config.ScAuthPath); err != nil {
		return failure(1, fmt.Sprintf("CTK identity tool %s is absent or not executable; restore macOS signing tools and retry", config.ScAuthPath))
	}
	if err := requireExecutable(config.SSHKeygenPath); err != nil {
		return failure(1, fmt.Sprintf("ssh-keygen %s is absent or not executable; restore macOS signing tools and retry", config.SSHKeygenPath))
	}

	ctkHash := os.Getenv("GIT_MCP_SIGNING_CTK_HASH")
	selector := os.Getenv("KEYCHAIN_CERTIFICATES")
	expectedPublicKey := os.Getenv("GIT_MCP_SIGNING_PUBLIC_KEY")
	expectedFingerprint := os.Getenv("GIT_MCP_SIGNING_FINGERPRINT")
	configuredStub := os.Getenv("GIT_MCP_SIGNING_STUB")
	if !hexHashPattern.MatchString(ctkHash) {
		return failure(1, "configured CTK identity hash is missing or malformed; run the signing doctor command")
	}
	if selector != ctkHash {
		return failure(1, fmt.Sprintf("KEYCHAIN_CERTIFICATES must equal configured CTK hash %s; restore the git-mcp signing environment", ctkHash))
	}
	if expectedPublicKey == "" {
		return failure(1, "configured signing public key is missing; restore the git-mcp signing environment")
	}
	if expectedFingerprint == "" {
		return failure(1, "configured signing fingerprint is missing; restore the git-mcp signing environment")
	}
	if !fingerprintPattern.MatchString(expectedFingerprint) {
		return failure(1, "configured signing fingerprint is malformed; run the signing doctor command")
	}
	if configuredStub == "" {
		return failure(1, "configured resident stub path is missing; run the signing recovery command")
	}

	stubArgument, count, err := signingStubArgument(arguments)
	if err != nil {
		return failure(1, fmt.Sprintf("ssh-keygen -f requires the configured resident stub %s", configuredStub))
	}
	if count != 1 {
		return failure(1, fmt.Sprintf("signing requires exactly one -f argument for resident stub %s", configuredStub))
	}
	if stubArgument != configuredStub {
		return failure(1, fmt.Sprintf("ssh-keygen -f path %s does not match configured resident stub %s", stubArgument, configuredStub))
	}
	if _, err := readRegularNonEmptyFile(configuredStub); err != nil {
		return failure(1, fmt.Sprintf("resident stub %s is absent, unreadable, or malformed; run recover-stub and retry", configuredStub))
	}
	actualPublicKey, err := readRegularNonEmptyFile(configuredStub + ".pub")
	if err != nil {
		return failure(1, fmt.Sprintf("resident public key %s.pub is absent, unreadable, or malformed; run recover-stub and retry", configuredStub))
	}

	identityListing, err := captureNativeOutput(config.ScAuthPath, "list-ctk-identities", "-t", "sha1", "-e", "hex")
	if err != nil {
		return preflightNativeFailure(err, "sc_auth identity listing failed; complete the first unlock after reboot and retry")
	}
	expectedKeyMaterial, err := normalizePublicKey(expectedPublicKey)
	if err != nil {
		return failure(1, "configured signing public key is malformed; run the signing doctor command")
	}
	actualKeyMaterial, err := normalizePublicKey(string(actualPublicKey))
	if err != nil {
		return failure(1, fmt.Sprintf("resident public key %s.pub is malformed; run recover-stub and retry", configuredStub))
	}
	if actualKeyMaterial != expectedKeyMaterial {
		return failure(1, fmt.Sprintf("resident public key %s.pub does not match configured public key; run recover-stub and retry", configuredStub))
	}

	stubPublicKey, err := captureNativeOutput(config.SSHKeygenPath, "-y", "-f", configuredStub)
	if err != nil {
		return preflightNativeFailure(err, fmt.Sprintf("ssh-keygen rejected resident stub %s; run recover-stub and retry", configuredStub))
	}
	stubKeyMaterial, err := normalizePublicKey(string(stubPublicKey))
	if err != nil {
		return failure(1, fmt.Sprintf("ssh-keygen returned a malformed resident public key for %s; run recover-stub and retry", configuredStub))
	}
	if stubKeyMaterial != expectedKeyMaterial {
		return failure(1, fmt.Sprintf("resident stub %s does not match configured public key; run recover-stub and retry", configuredStub))
	}

	fingerprintListing, err := captureNativeOutput(config.SSHKeygenPath, "-lf", configuredStub+".pub")
	if err != nil {
		return preflightNativeFailure(err, fmt.Sprintf("ssh-keygen could not inspect resident public key %s.pub; run recover-stub and retry", configuredStub))
	}
	actualFingerprint, err := listedFingerprint(string(fingerprintListing))
	if err != nil {
		return failure(1, fmt.Sprintf("ssh-keygen returned a malformed fingerprint for %s.pub; run recover-stub and retry", configuredStub))
	}
	if actualFingerprint != expectedFingerprint {
		return failure(1, fmt.Sprintf("resident fingerprint %s does not match configured fingerprint %s; run recover-stub and retry", actualFingerprint, expectedFingerprint))
	}

	matchingIdentities, err := countConfiguredCTKIdentities(string(identityListing), ctkHash)
	if err != nil {
		return failure(1, "sc_auth returned malformed CTK identity state; run the signing doctor command")
	}
	if matchingIdentities != 1 {
		return failure(1, fmt.Sprintf("configured CTK identity %s does not match exactly one resident identity; complete first unlock or run recover-stub", ctkHash))
	}
	return runNativeSigning(arguments)
}

func requireNativePaths() error {
	if config.ScAuthPath == "" || config.ProviderPath == "" || config.SSHKeygenPath == "" {
		return failure(125, "packaged native signing paths are absent; restore the signer package and retry")
	}
	return nil
}

func signingStubArgument(arguments []string) (string, int, error) {
	stub := ""
	count := 0
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if argument == "-f" {
			if index+1 >= len(arguments) {
				return "", 0, errors.New("missing -f value")
			}
			stub = arguments[index+1]
			count++
			index++
			continue
		}
		if strings.HasPrefix(argument, "-f") {
			stub = strings.TrimPrefix(argument, "-f")
			count++
		}
	}
	return stub, count, nil
}

func captureNativeOutput(command string, arguments ...string) ([]byte, error) {
	process := exec.Command(command, arguments...)
	process.Stdin = os.Stdin
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			if process.Process != nil {
				_ = process.Process.Kill()
			}
		})
	}
	stdout := nativeOutputCapture{stop: stop}
	stderr := nativeOutputCapture{stop: stop}
	process.Stdout = &stdout
	process.Stderr = &stderr
	err := process.Run()
	if stdout.overflow || stderr.overflow {
		return nil, errOutputTooLarge
	}
	if err := relayNativeStderr(stderr.bytes()); err != nil {
		return nil, err
	}
	if err != nil {
		return nil, err
	}
	return stdout.bytes(), nil
}

func preflightNativeFailure(err error, diagnostic string) error {
	if errors.Is(err, errOutputTooLarge) {
		return failure(1, "native preflight output exceeded bounded capacity; inspect the configured signing tools and retry")
	}
	return failure(1, diagnostic)
}

func relayNativeStderr(contents []byte) error {
	for len(contents) > 0 {
		written, err := os.Stderr.Write(contents)
		if written > 0 {
			contents = contents[written:]
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

func runNativeSigning(arguments []string) error {
	process := exec.Command(config.SSHKeygenPath, arguments...)
	process.Stdin = os.Stdin
	process.Stdout = os.Stdout
	process.Stderr = os.Stderr
	process.Env = environmentWith("SSH_SK_PROVIDER", config.ProviderPath)
	if err := process.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "[git-mcp-secure-enclave-signer] Apple signing provider rejected the request; complete the first unlock after reboot and retry")
		return err
	}
	return nil
}

func environmentWith(name, value string) []string {
	prefix := name + "="
	environment := make([]string, 0, len(os.Environ())+1)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, prefix) {
			environment = append(environment, entry)
		}
	}
	return append(environment, prefix+value)
}

func readRegularNonEmptyFile(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return nil, errors.New("not a readable regular non-empty file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	contents, err := io.ReadAll(file)
	if err != nil || len(contents) == 0 {
		return nil, errors.New("could not read file")
	}
	return contents, nil
}

func requireReadable(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	return file.Close()
}

func requireExecutable(path string) error {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("not an executable regular file")
	}
	return nil
}

func normalizePublicKey(value string) (string, error) {
	fields := strings.Fields(value)
	if len(fields) < 2 || fields[0] != "sk-ecdsa-sha2-nistp256@openssh.com" || !keyDataPattern.MatchString(fields[1]) {
		return "", errors.New("invalid public key")
	}
	return fields[0] + " " + fields[1], nil
}

func listedFingerprint(value string) (string, error) {
	value = strings.TrimRight(value, "\n")
	firstSpace := strings.IndexByte(value, ' ')
	if firstSpace < 0 {
		return "", errors.New("invalid fingerprint")
	}
	fingerprint := value[firstSpace+1:]
	if nextSpace := strings.IndexByte(fingerprint, ' '); nextSpace >= 0 {
		fingerprint = fingerprint[:nextSpace]
	}
	if !fingerprintPattern.MatchString(fingerprint) {
		return "", errors.New("invalid fingerprint")
	}
	return fingerprint, nil
}

func countConfiguredCTKIdentities(listing, expectedHash string) (int, error) {
	headerSeen := false
	matchingCount := 0
	for _, line := range strings.Split(listing, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 {
			continue
		}
		if strings.Join(fields, " ") == "Key Type Public Key Hash Prot Label Common Name Email Address Valid To Valid" {
			if headerSeen {
				return 0, errors.New("duplicate CTK header")
			}
			headerSeen = true
			continue
		}
		if !headerSeen || (len(fields) != 8 && len(fields) != 9) {
			return 0, errors.New("invalid CTK row")
		}

		keyType := fields[0]
		publicHash := fields[1]
		protection := fields[2]
		label := fields[3]
		commonName := fields[4]
		emailAddress := ""
		dateIndex := 5
		if len(fields) == 9 {
			emailAddress = fields[5]
			dateIndex = 6
		}
		if !isSupportedCTKKeyType(keyType) || !listingHashPattern.MatchString(publicHash) ||
			(protection != "bio" && protection != "none") || label == "" || commonName == "" ||
			(emailAddress != "" && emailAddress == "-") || !listingDatePattern.MatchString(fields[dateIndex]) ||
			!listingTimePattern.MatchString(fields[dateIndex+1]) || fields[dateIndex+2] != "YES" {
			return 0, errors.New("malformed CTK identity")
		}
		if keyType == "p-256-ne" && protection == "none" && strings.EqualFold(publicHash, expectedHash) {
			matchingCount++
		}
	}
	if !headerSeen {
		return 0, errors.New("missing CTK header")
	}
	return matchingCount, nil
}

func isSupportedCTKKeyType(value string) bool {
	switch value {
	case "p-256", "p-256-ne", "p-384", "p-384-ne", "p-521":
		return true
	default:
		return false
	}
}
