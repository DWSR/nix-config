package stackmcp

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Target contains canonical local paths and the repository identity selected by
// an explicit Git remote.
type Target struct {
	Path       string
	GitDir     string
	CommonDir  string
	Remote     string
	Repository string
}

// ValidateCheckoutRemoteSelection requires checkout's implicit remote choices
// to resolve only to the already validated target. The remote Stack trunk is
// learned from GitHub by the extension, so every configured branch selector
// and the selector with no branch-specific settings must be safe.
func ValidateCheckoutRemoteSelection(target Target) error {
	soleRemote, err := requireSoleTargetRemote(target)
	if err != nil {
		return err
	}
	preferences, err := loadTargetRemotePreferences(target.Path)
	if err != nil {
		return err
	}

	// Remote checkout discovers its trunk from the API, then resolves a remote
	// using that trunk's branch config. Inspect every configured branch selector
	// and the generic selector; the latter covers a trunk with no branch config.
	branches := append([]string{""}, preferences.branchNames()...)
	for _, branch := range branches {
		if err := preferences.requireTargetRemote(branch, soleRemote, target.Remote); err != nil {
			return err
		}
	}
	return nil
}

// ValidateInitRemoteSelection checks the pinned CLI's implicit remote selection
// before init can fetch a missing trunk. The CLI resolves using the current
// branch; the approved guard contract also names the trunk, so both selectors
// must resolve to the validated remote. A local trunk, or the current trunk
// branch that init will use directly, needs no fetch-selection guard.
func ValidateInitRemoteSelection(target Target, trunk string) error {
	if trunk == "" || strings.ContainsAny(trunk, "\x00\r\n") {
		return fmt.Errorf("an init trunk branch is required for remote-selection validation")
	}
	currentBranch, err := targetCurrentBranch(target.Path)
	if err != nil {
		return err
	}
	trunkExists, err := targetLocalBranchExists(target.Path, trunk)
	if err != nil {
		return err
	}
	if currentBranch == trunk || trunkExists {
		return nil
	}

	soleRemote, err := requireSoleTargetRemote(target)
	if err != nil {
		return err
	}
	preferences, err := loadTargetRemotePreferences(target.Path)
	if err != nil {
		return err
	}
	for _, branch := range []string{currentBranch, trunk} {
		if err := preferences.requireTargetRemote(branch, soleRemote, target.Remote); err != nil {
			return err
		}
	}
	return nil
}

type targetBranchRemotePreference struct {
	pushRemote string
	remote     string
}

type targetRemotePreferences struct {
	branchPreferences map[string]targetBranchRemotePreference
	pushDefault       string
	savedRemote       string
}

func requireSoleTargetRemote(target Target) (string, error) {
	output, err := runTargetGit(target.Path, "list Git remotes for implicit selection", "remote")
	if err != nil {
		return "", err
	}
	remotes, err := gitOutputLines(output)
	if err != nil {
		return "", fmt.Errorf("read Git remotes for implicit selection: %w", err)
	}
	if len(remotes) != 1 {
		return "", fmt.Errorf("implicit Stack remote selection requires exactly one Git remote")
	}
	if remotes[0] != target.Remote {
		return "", fmt.Errorf("the sole Git remote does not match the validated target remote")
	}
	return remotes[0], nil
}

func loadTargetRemotePreferences(worktree string) (targetRemotePreferences, error) {
	preferences := targetRemotePreferences{
		branchPreferences: make(map[string]targetBranchRemotePreference),
	}
	var err error
	preferences.pushDefault, _, err = readTargetGitConfig(worktree, "remote.pushDefault")
	if err != nil {
		return targetRemotePreferences{}, err
	}
	preferences.savedRemote, _, err = readTargetGitConfig(worktree, "gh-stack.remote")
	if err != nil {
		return targetRemotePreferences{}, err
	}

	output, found, err := runTargetGitOptional(worktree, "list branch remote preferences", "config", "--name-only", "--get-regexp", `^branch\.`)
	if err != nil {
		return targetRemotePreferences{}, err
	}
	if !found {
		return preferences, nil
	}
	keys, err := gitOutputLines(output)
	if err != nil {
		return targetRemotePreferences{}, fmt.Errorf("read branch remote preference names: %w", err)
	}
	for _, key := range keys {
		branch, isPushRemote, ok := parseBranchRemotePreferenceKey(key)
		if !ok {
			continue
		}
		preference := preferences.branchPreferences[branch]
		if isPushRemote {
			preference.pushRemote, _, err = readTargetGitConfig(worktree, "branch."+branch+".pushRemote")
		} else {
			preference.remote, _, err = readTargetGitConfig(worktree, "branch."+branch+".remote")
		}
		if err != nil {
			return targetRemotePreferences{}, err
		}
		preferences.branchPreferences[branch] = preference
	}
	return preferences, nil
}

func parseBranchRemotePreferenceKey(key string) (branch string, isPushRemote bool, ok bool) {
	const prefix = "branch."
	lowerKey := strings.ToLower(key)
	if !strings.HasPrefix(lowerKey, prefix) {
		return "", false, false
	}
	var suffix string
	switch {
	case strings.HasSuffix(lowerKey, ".pushremote"):
		suffix = ".pushremote"
		isPushRemote = true
	case strings.HasSuffix(lowerKey, ".remote"):
		suffix = ".remote"
	default:
		return "", false, false
	}
	branch = key[len(prefix) : len(key)-len(suffix)]
	if strings.HasPrefix(branch, `"`) && strings.HasSuffix(branch, `"`) {
		unquoted, err := strconv.Unquote(branch)
		if err != nil {
			return "", false, false
		}
		branch = unquoted
	}
	if strings.ContainsAny(branch, "\x00\r\n") {
		return "", false, false
	}
	return branch, isPushRemote, true
}

func (preferences targetRemotePreferences) branchNames() []string {
	branches := make([]string, 0, len(preferences.branchPreferences))
	for branch := range preferences.branchPreferences {
		branches = append(branches, branch)
	}
	sort.Strings(branches)
	return branches
}

func (preferences targetRemotePreferences) resolve(branch, soleRemote string) string {
	branchPreference := preferences.branchPreferences[branch]
	for _, candidate := range []string{
		branchPreference.pushRemote,
		preferences.pushDefault,
		branchPreference.remote,
		preferences.savedRemote,
		soleRemote,
	} {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

func (preferences targetRemotePreferences) requireTargetRemote(branch, soleRemote, targetRemote string) error {
	if preferences.resolve(branch, soleRemote) != targetRemote {
		return fmt.Errorf("gh-stack's automatic Git remote selection does not match the validated target")
	}
	return nil
}

func readTargetGitConfig(worktree, key string) (string, bool, error) {
	output, found, err := runTargetGitOptional(worktree, "read Git remote-selection preference", "config", "--get", key)
	if err != nil || !found {
		return "", found, err
	}
	value := strings.TrimSuffix(string(output), "\n")
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", false, fmt.Errorf("Git remote-selection preference is malformed")
	}
	return value, value != "", nil
}

func targetCurrentBranch(worktree string) (string, error) {
	output, err := runTargetGit(worktree, "read current Git branch", "branch", "--show-current")
	if err != nil {
		return "", err
	}
	branch := strings.TrimSuffix(string(output), "\n")
	if strings.ContainsAny(branch, "\x00\r\n") {
		return "", fmt.Errorf("Git returned a malformed current branch")
	}
	return branch, nil
}

func targetLocalBranchExists(worktree, branch string) (bool, error) {
	_, found, err := runTargetGitOptional(worktree, "check for local init trunk", "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return found, err
}

func runTargetGitOptional(worktree, operation string, args ...string) ([]byte, bool, error) {
	commandArgs := append([]string{"-C", worktree}, args...)
	command := exec.Command("git", commandArgs...)
	command.Env = targetGitEnvironment()
	output, err := command.Output()
	if err == nil {
		return output, true, nil
	}
	var exitError *exec.ExitError
	if errors.As(err, &exitError) && exitError.ExitCode() == 1 {
		return nil, false, nil
	}
	return nil, false, fmt.Errorf("%s: %w", operation, err)
}

// ValidateTarget resolves the supplied worktree and validates one explicit
// remote without relying on the process working directory or inherited GH_REPO.
func ValidateTarget(path, remote string) (Target, error) {
	inputPath, err := resolveInputDirectory(path)
	if err != nil {
		return Target{}, err
	}
	if remote == "" || strings.TrimSpace(remote) == "" {
		return Target{}, fmt.Errorf("a Git remote name is required")
	}
	if strings.HasPrefix(remote, "-") || strings.ContainsAny(remote, "\x00\r\n") {
		return Target{}, fmt.Errorf("the Git remote name is invalid")
	}

	worktreeOutput, err := runTargetGit(inputPath, "resolve worktree root", "rev-parse", "--show-toplevel")
	if err != nil {
		return Target{}, err
	}
	worktreeRoot, err := resolveGitDirectory(inputPath, worktreeOutput, "worktree root")
	if err != nil {
		return Target{}, err
	}

	gitDirOutput, err := runTargetGit(worktreeRoot, "resolve worktree Git directory", "rev-parse", "--absolute-git-dir")
	if err != nil {
		return Target{}, err
	}
	gitDir, err := resolveGitDirectory(worktreeRoot, gitDirOutput, "worktree Git directory")
	if err != nil {
		return Target{}, err
	}

	commonDirOutput, err := runTargetGit(worktreeRoot, "resolve common Git directory", "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Target{}, err
	}
	commonDir, err := resolveGitDirectory(worktreeRoot, commonDirOutput, "common Git directory")
	if err != nil {
		return Target{}, err
	}

	remoteOutput, err := runTargetGit(worktreeRoot, "list Git remotes", "remote")
	if err != nil {
		return Target{}, err
	}
	remotes, err := gitOutputLines(remoteOutput)
	if err != nil {
		return Target{}, fmt.Errorf("read Git remote names: %w", err)
	}
	remoteFound := false
	for _, candidate := range remotes {
		if candidate == remote {
			remoteFound = true
			break
		}
	}
	if !remoteFound {
		return Target{}, fmt.Errorf("the selected Git remote does not exist")
	}

	fetchURLs, err := targetRemoteURLs(worktreeRoot, remote, false)
	if err != nil {
		return Target{}, err
	}
	var repository string
	for _, fetchURL := range fetchURLs {
		identity, err := parseRemoteRepository(fetchURL)
		if err != nil {
			return Target{}, fmt.Errorf("the selected remote has an invalid fetch URL")
		}
		if repository == "" {
			repository = identity
		} else if identity != repository {
			return Target{}, fmt.Errorf("the selected remote's fetch URLs identify different repositories")
		}
	}

	pushURLs, err := targetRemoteURLs(worktreeRoot, remote, true)
	if err != nil {
		return Target{}, err
	}
	if len(pushURLs) != 1 {
		return Target{}, fmt.Errorf("the selected remote must have exactly one push destination")
	}
	pushRepository, err := parseRemoteRepository(pushURLs[0])
	if err != nil {
		return Target{}, fmt.Errorf("the selected remote has an invalid push URL")
	}
	if repository != pushRepository {
		return Target{}, fmt.Errorf("the selected remote's fetch and push URLs identify different repositories")
	}

	return Target{
		Path:       worktreeRoot,
		GitDir:     gitDir,
		CommonDir:  commonDir,
		Remote:     remote,
		Repository: repository,
	}, nil
}

func resolveInputDirectory(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("a worktree path is required")
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("the worktree path must be absolute")
	}
	info, err := os.Stat(filepath.Clean(path))
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("the worktree path must name an existing directory")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve worktree path: %w", err)
	}
	return filepath.Clean(resolved), nil
}

func resolveGitDirectory(relativeTo string, output []byte, description string) (string, error) {
	line, err := gitOutputLine(output)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", description, err)
	}
	if line == "" {
		return "", fmt.Errorf("Git returned an empty %s", description)
	}
	if !filepath.IsAbs(line) {
		line = filepath.Join(relativeTo, line)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(line))
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", description, err)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("Git returned a non-directory %s", description)
	}
	return filepath.Clean(resolved), nil
}

func runTargetGit(worktree, operation string, args ...string) ([]byte, error) {
	commandArgs := append([]string{"-C", worktree}, args...)
	command := exec.Command("git", commandArgs...)
	command.Env = targetGitEnvironment()
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", operation, err)
	}
	return output, nil
}

func targetGitEnvironment() []string {
	environment := make([]string, 0, len(os.Environ()))
	for _, entry := range os.Environ() {
		name, _, ok := strings.Cut(entry, "=")
		if !ok || name == "GH_REPO" || strings.HasPrefix(name, "GIT_") {
			continue
		}
		environment = append(environment, entry)
	}
	return environment
}

func targetRemoteURLs(worktree, remote string, push bool) ([]string, error) {
	args := []string{"remote", "get-url"}
	operation := "read selected remote fetch URLs"
	if push {
		args = append(args, "--push")
		operation = "read selected remote push URLs"
	}
	args = append(args, "--all", remote)
	output, err := runTargetGit(worktree, operation, args...)
	if err != nil {
		return nil, err
	}
	urls, err := gitOutputLines(output)
	if err != nil || len(urls) == 0 {
		kind := "fetch"
		if push {
			kind = "push"
		}
		return nil, fmt.Errorf("the selected remote has no usable %s URL", kind)
	}
	return urls, nil
}

func gitOutputLine(output []byte) (string, error) {
	lines, err := gitOutputLines(output)
	if err != nil {
		return "", err
	}
	if len(lines) != 1 {
		return "", fmt.Errorf("expected one Git path")
	}
	return lines[0], nil
}

func gitOutputLines(output []byte) ([]string, error) {
	text := string(output)
	if text == "" {
		return nil, nil
	}
	text = strings.TrimSuffix(text, "\n")
	lines := strings.Split(text, "\n")
	for index, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		if line == "" {
			return nil, fmt.Errorf("Git returned an empty line")
		}
		lines[index] = line
	}
	return lines, nil
}

func parseRemoteRepository(remoteURL string) (string, error) {
	if remoteURL == "" || remoteURL != strings.TrimSpace(remoteURL) ||
		strings.ContainsAny(remoteURL, "\x00\r\n\t \\") || strings.ContainsAny(remoteURL, "?#%") {
		return "", fmt.Errorf("unsupported remote URL")
	}

	if strings.Contains(remoteURL, "://") {
		parsed, err := url.Parse(remoteURL)
		if err != nil || parsed.Opaque != "" {
			return "", fmt.Errorf("unsupported remote URL")
		}
		scheme := strings.ToLower(parsed.Scheme)
		if scheme != "https" && scheme != "ssh" {
			return "", fmt.Errorf("unsupported remote URL scheme")
		}
		if parsed.ForceQuery || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.RawFragment != "" {
			return "", fmt.Errorf("remote URL contains query or fragment data")
		}
		if scheme == "https" && parsed.User != nil {
			return "", fmt.Errorf("HTTPS remote URL contains credentials")
		}
		if scheme == "ssh" && parsed.User != nil {
			username := parsed.User.Username()
			_, hasPassword := parsed.User.Password()
			if hasPassword || username != "git" {
				return "", fmt.Errorf("SSH remote URL contains unsupported credentials")
			}
		}
		if parsed.Host == "" || strings.HasSuffix(parsed.Host, ":") {
			return "", fmt.Errorf("remote URL has an invalid host")
		}
		host, err := normalizeRepositoryHost(parsed.Hostname(), parsed.Port(), scheme)
		if err != nil {
			return "", err
		}
		return repositoryIdentity(host, parsed.Path)
	}

	return parseSCPRepository(remoteURL)
}

func parseSCPRepository(remoteURL string) (string, error) {
	colon := strings.IndexByte(remoteURL, ':')
	if colon <= 0 {
		return "", fmt.Errorf("unsupported remote URL")
	}
	authority := remoteURL[:colon]
	repositoryPath := remoteURL[colon+1:]
	username := ""
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		if strings.Contains(authority[:at], "@") {
			return "", fmt.Errorf("unsupported SSH remote credentials")
		}
		username = authority[:at]
		authority = authority[at+1:]
	}
	if username != "" && username != "git" {
		return "", fmt.Errorf("unsupported SSH remote credentials")
	}
	if authority == "" || strings.ContainsAny(authority, "/\\") || strings.HasPrefix(repositoryPath, "/") {
		return "", fmt.Errorf("unsupported SSH remote host")
	}
	host, err := normalizeRepositoryHost(authority, "", "ssh")
	if err != nil {
		return "", err
	}
	return repositoryIdentity(host, repositoryPath)
}

func normalizeRepositoryHost(hostname, port, scheme string) (string, error) {
	host := strings.TrimSuffix(strings.ToLower(hostname), ".")
	if host == "" {
		return "", fmt.Errorf("remote URL has an empty host")
	}
	if address := net.ParseIP(host); address != nil {
		if strings.Contains(host, ":") {
			host = "[" + host + "]"
		}
	} else if !validRepositoryDomain(host) {
		return "", fmt.Errorf("remote URL has an invalid host")
	}
	if port == "" {
		return host, nil
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", fmt.Errorf("remote URL has an invalid port")
	}
	if (scheme == "https" && portNumber == 443) || (scheme == "ssh" && portNumber == 22) {
		return host, nil
	}
	if strings.HasPrefix(host, "[") {
		return host + ":" + strconv.Itoa(portNumber), nil
	}
	return host + ":" + strconv.Itoa(portNumber), nil
}

func validRepositoryDomain(host string) bool {
	if len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, character := range label {
			if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '-' {
				return false
			}
		}
	}
	return true
}

func repositoryIdentity(host, repositoryPath string) (string, error) {
	if strings.ContainsAny(repositoryPath, "\x00\r\n\t \\%?#") {
		return "", fmt.Errorf("remote URL has an invalid repository path")
	}
	repositoryPath = strings.TrimPrefix(repositoryPath, "/")
	repositoryPath = strings.TrimSuffix(repositoryPath, "/")
	parts := strings.Split(repositoryPath, "/")
	if len(parts) != 2 {
		return "", fmt.Errorf("remote URL must identify one owner and repository")
	}
	owner := strings.ToLower(parts[0])
	repository := strings.ToLower(parts[1])
	repository = strings.TrimSuffix(repository, ".git")
	if !validRepositoryComponent(owner) || !validRepositoryComponent(repository) {
		return "", fmt.Errorf("remote URL has an invalid owner or repository")
	}
	return host + "/" + owner + "/" + repository, nil
}

func validRepositoryComponent(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') &&
			character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}
