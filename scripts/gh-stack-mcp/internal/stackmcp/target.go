package stackmcp

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	GitPath    string
	Remote     string
	Repository string
}

const maxTargetStateFileSize = 4 << 20

type targetRebaseStateMarker struct {
	CurrentBranchIndex        *int              `json:"currentBranchIndex"`
	ConflictBranch            string            `json:"conflictBranch"`
	RemainingBranches         *[]string         `json:"remainingBranches"`
	OriginalBranch            string            `json:"originalBranch"`
	OriginalRefs              map[string]string `json:"originalRefs"`
	UseOnto                   bool              `json:"useOnto,omitempty"`
	OntoOldBase               string            `json:"ontoOldBase,omitempty"`
	CommitterDateIsAuthorDate bool              `json:"committerDateIsAuthorDate,omitempty"`
	NoTrunk                   bool              `json:"noTrunk,omitempty"`
	TrunkRef                  string            `json:"trunkRef,omitempty"`
	TrunkSHA                  string            `json:"trunkSha,omitempty"`
	StartIndex                *int              `json:"startIndex,omitempty"`
	EndIndex                  *int              `json:"endIndex,omitempty"`
}

type targetStackFile struct {
	SchemaVersion int           `json:"schemaVersion"`
	Repository    string        `json:"repository"`
	Stacks        []targetStack `json:"stacks"`
}

type targetStack struct {
	ID       string              `json:"id,omitempty"`
	Number   int                 `json:"number,omitempty"`
	Trunk    targetStackBranch   `json:"trunk"`
	Branches []targetStackBranch `json:"branches"`
}

type targetStackBranch struct {
	Branch      string                  `json:"branch"`
	Head        string                  `json:"head,omitempty"`
	Base        string                  `json:"base,omitempty"`
	PullRequest *targetStackPullRequest `json:"pullRequest,omitempty"`
}

type targetStackPullRequest struct {
	Number int    `json:"number"`
	ID     string `json:"id,omitempty"`
	URL    string `json:"url,omitempty"`
	Merged bool   `json:"merged,omitempty"`
}

type targetModifyStateMarker struct {
	Phase              *string `json:"phase"`
	PriorRemoteStackID string  `json:"prior_remote_stack_id"`
}

// ValidateRebaseContinueState verifies that typed continue has matching Stack
// recovery metadata and a well-formed Git rebase in this worktree's GitDir.
func ValidateRebaseContinueState(target Target) error {
	if err := validateTargetStateGitDir(target.GitDir); err != nil {
		return fmt.Errorf("validate worktree Git directory for Stack recovery: %w", err)
	}
	markerData, err := readTargetStateFile(target, "gh-stack-rebase-state", "read Stack rebase marker")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("Stack rebase recovery marker is missing")
		}
		return err
	}

	var marker targetRebaseStateMarker
	if err := decodeTargetStateJSON(markerData, &marker, "Stack rebase marker"); err != nil {
		return err
	}
	if marker.CurrentBranchIndex == nil {
		return fmt.Errorf("Stack rebase marker is missing currentBranchIndex")
	}
	if *marker.CurrentBranchIndex < 0 {
		return fmt.Errorf("Stack rebase marker has an invalid currentBranchIndex")
	}
	if !validTargetStateBranch(marker.ConflictBranch) {
		return fmt.Errorf("Stack rebase marker is missing a valid conflictBranch")
	}
	if !validTargetStateBranch(marker.OriginalBranch) {
		return fmt.Errorf("Stack rebase marker is missing a valid originalBranch")
	}
	if marker.OriginalRefs == nil {
		return fmt.Errorf("Stack rebase marker is missing originalRefs")
	}

	stackData, err := readTargetStateFile(target, "gh-stack", "read tracked Stack metadata")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("tracked Stack metadata is missing")
		}
		return err
	}
	var stackFile targetStackFile
	if err := decodeTargetStateJSON(stackData, &stackFile, "tracked Stack metadata"); err != nil {
		return err
	}
	if err := validateTargetStackFile(stackFile); err != nil {
		return err
	}

	stack, err := findTargetRecoveryStack(stackFile.Stacks, marker.ConflictBranch, marker.OriginalBranch)
	if err != nil {
		return err
	}
	branchIndex := *marker.CurrentBranchIndex
	if branchIndex >= len(stack.Branches) || stack.Branches[branchIndex].Branch != marker.ConflictBranch {
		return fmt.Errorf("Stack rebase marker branch index does not match its conflictBranch")
	}
	if err := validateTargetOriginalRefs(target, marker.OriginalRefs, stack, marker.ConflictBranch); err != nil {
		return err
	}
	if err := validateTargetRemainingBranches(marker.RemainingBranches, stack, branchIndex, marker.StartIndex, marker.EndIndex); err != nil {
		return err
	}

	if err := validateActiveTargetGitRebase(target, marker); err != nil {
		return err
	}
	return nil
}

// ValidateSubmitState rejects the pinned extension's headless pending-submit
// recovery path, which can unstack the previous remote Stack.
func ValidateSubmitState(target Target) error {
	if err := validateTargetStateGitDir(target.GitDir); err != nil {
		return fmt.Errorf("validate worktree Git directory before submit: %w", err)
	}
	data, err := readTargetStateFile(target, "gh-stack-modify-state", "read Stack modify state")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("cannot verify Stack modify state before submit: %w", err)
	}

	var state targetModifyStateMarker
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("Stack modify state is malformed; submit was rejected: %w", err)
	}
	if state.Phase == nil || *state.Phase == "" || strings.TrimSpace(*state.Phase) != *state.Phase || strings.ContainsAny(*state.Phase, "\x00\r\n") {
		return fmt.Errorf("Stack modify state has no valid phase; submit was rejected")
	}
	if *state.Phase == "pending_submit" && state.PriorRemoteStackID != "" {
		return fmt.Errorf("headless submit is rejected while Stack modify state is pending_submit because it can unstack a previous remote Stack")
	}
	return nil
}

func readTargetStateFile(target Target, relativePath, description string) ([]byte, error) {
	if err := validateTargetStateGitDir(target.GitDir); err != nil {
		return nil, fmt.Errorf("%s: %w", description, err)
	}
	path := filepath.Join(target.GitDir, relativePath)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", description, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s: state path is not a regular file", description)
	}
	if info.Size() > maxTargetStateFileSize {
		return nil, fmt.Errorf("%s: state file exceeds the size limit", description)
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", description, err)
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("%s: inspect state file: %w", description, err)
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		return nil, fmt.Errorf("%s: state file changed while it was opened", description)
	}
	if openedInfo.Size() > maxTargetStateFileSize {
		return nil, fmt.Errorf("%s: state file exceeds the size limit", description)
	}

	data, err := io.ReadAll(io.LimitReader(file, maxTargetStateFileSize+1))
	if err != nil {
		return nil, fmt.Errorf("%s: read state file: %w", description, err)
	}
	if len(data) > maxTargetStateFileSize {
		return nil, fmt.Errorf("%s: state file exceeds the size limit", description)
	}
	return data, nil
}

func validateTargetStateGitDir(gitDir string) error {
	if gitDir == "" || !filepath.IsAbs(gitDir) {
		return fmt.Errorf("worktree Git directory is not an absolute path")
	}
	info, err := os.Lstat(gitDir)
	if err != nil {
		return fmt.Errorf("inspect worktree Git directory: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("worktree Git directory is not a directory")
	}
	return nil
}

func decodeTargetStateJSON(data []byte, destination any, description string) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("parse %s: %w", description, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return fmt.Errorf("parse %s: trailing JSON data", description)
		}
		return fmt.Errorf("parse %s: %w", description, err)
	}
	return nil
}

func validateTargetStackFile(stackFile targetStackFile) error {
	if len(stackFile.Stacks) == 0 {
		return fmt.Errorf("tracked Stack metadata has no stacks")
	}
	for stackIndex, stack := range stackFile.Stacks {
		if !validTargetStateBranch(stack.Trunk.Branch) || len(stack.Branches) == 0 {
			return fmt.Errorf("tracked Stack metadata contains an incomplete stack at index %d", stackIndex)
		}
		seen := map[string]struct{}{stack.Trunk.Branch: {}}
		for _, branch := range stack.Branches {
			if !validTargetStateBranch(branch.Branch) {
				return fmt.Errorf("tracked Stack metadata contains an invalid branch at stack index %d", stackIndex)
			}
			if _, exists := seen[branch.Branch]; exists {
				return fmt.Errorf("tracked Stack metadata contains duplicate branch %q", branch.Branch)
			}
			seen[branch.Branch] = struct{}{}
		}
	}
	return nil
}

func findTargetRecoveryStack(stacks []targetStack, conflictBranch, originalBranch string) (targetStack, error) {
	var match *targetStack
	for index := range stacks {
		stack := &stacks[index]
		if targetStackBranchIndex(*stack, conflictBranch) < 0 || !targetStackContains(*stack, originalBranch) {
			continue
		}
		if match != nil {
			return targetStack{}, fmt.Errorf("Stack rebase marker matches more than one tracked stack")
		}
		match = stack
	}
	if match == nil {
		return targetStack{}, fmt.Errorf("Stack rebase marker branches do not match one tracked stack")
	}
	return *match, nil
}

func targetStackBranchIndex(stack targetStack, branch string) int {
	for index, candidate := range stack.Branches {
		if candidate.Branch == branch {
			return index
		}
	}
	return -1
}

func targetStackContains(stack targetStack, branch string) bool {
	if stack.Trunk.Branch == branch {
		return true
	}
	return targetStackBranchIndex(stack, branch) >= 0
}

func validateTargetOriginalRefs(target Target, originalRefs map[string]string, stack targetStack, conflictBranch string) error {
	trackedBranches := make(map[string]targetStackBranch, len(stack.Branches))
	for _, branch := range stack.Branches {
		trackedBranches[branch.Branch] = branch
	}
	for branch, objectID := range originalRefs {
		if _, ok := trackedBranches[branch]; !ok {
			return fmt.Errorf("Stack rebase marker originalRefs contain an untracked branch")
		}
		if !validTargetObjectID(objectID) {
			return fmt.Errorf("Stack rebase marker originalRefs contain an invalid object ID")
		}
	}
	if _, ok := originalRefs[conflictBranch]; !ok {
		return fmt.Errorf("Stack rebase marker originalRefs omit the conflict branch")
	}

	for branchName, branch := range trackedBranches {
		objectID, markerHasRef := originalRefs[branchName]
		localRefExists, err := targetLocalBranchExistsWithPath(target.GitPath, target.Path, branchName)
		if err != nil {
			return fmt.Errorf("check local Stack branch ref: %w", err)
		}
		if localRefExists {
			if !markerHasRef {
				return fmt.Errorf("Stack rebase marker originalRefs omit a branch with a local branch ref")
			}
			continue
		}
		if branch.Head != "" {
			if !markerHasRef {
				return fmt.Errorf("Stack rebase marker originalRefs omit a deleted branch's tracked Head fallback")
			}
			if !strings.EqualFold(objectID, branch.Head) {
				return fmt.Errorf("Stack rebase marker originalRefs do not match a deleted branch's tracked Head fallback")
			}
			continue
		}
		if markerHasRef {
			return fmt.Errorf("Stack rebase marker originalRefs contain a branch with no local ref or tracked Head source")
		}
	}
	return nil
}

func validateTargetRemainingBranches(remainingBranches *[]string, stack targetStack, currentBranchIndex int, startIndex, endIndex *int) error {
	if remainingBranches == nil {
		return fmt.Errorf("Stack rebase marker is missing remainingBranches")
	}
	if currentBranchIndex < 0 || currentBranchIndex >= len(stack.Branches) {
		return fmt.Errorf("Stack rebase marker has an invalid currentBranchIndex for remainingBranches")
	}
	start := 0
	if startIndex != nil {
		start = *startIndex
	}
	if start < 0 || start > currentBranchIndex {
		return fmt.Errorf("Stack rebase marker has an invalid startIndex for remainingBranches")
	}
	if endIndex == nil {
		return fmt.Errorf("Stack rebase marker is missing endIndex for remainingBranches")
	}
	end := *endIndex
	if end <= currentBranchIndex || end > len(stack.Branches) {
		return fmt.Errorf("Stack rebase marker has an invalid endIndex for remainingBranches")
	}
	expected := stack.Branches[currentBranchIndex+1 : end]
	if len(*remainingBranches) != len(expected) {
		return fmt.Errorf("Stack rebase marker remainingBranches do not match the selected rebase range")
	}
	for index, branch := range *remainingBranches {
		if !validTargetStateBranch(branch) || branch != expected[index].Branch {
			return fmt.Errorf("Stack rebase marker remainingBranches do not match the selected rebase range")
		}
	}
	return nil
}

func validateActiveTargetGitRebase(target Target, marker targetRebaseStateMarker) error {
	mergeActive, err := targetStateDirectoryExists(target, "rebase-merge")
	if err != nil {
		return err
	}
	applyActive, err := targetStateDirectoryExists(target, "rebase-apply")
	if err != nil {
		return err
	}
	if mergeActive == applyActive {
		if mergeActive {
			return fmt.Errorf("Git rebase state is inconsistent: both rebase directories are present")
		}
		return fmt.Errorf("no active Git rebase state is present in the worktree")
	}

	var rebaseHead string
	if mergeActive {
		rebaseHead, err = validateTargetMergeRebaseState(target, marker)
	} else {
		rebaseHead, err = validateTargetApplyRebaseState(target, marker)
	}
	if err != nil {
		return err
	}
	if !validTargetObjectID(rebaseHead) {
		return fmt.Errorf("active Git rebase has an invalid REBASE_HEAD")
	}
	return nil
}

func validateTargetMergeRebaseState(target Target, marker targetRebaseStateMarker) (string, error) {
	const directory = "rebase-merge"
	headName, err := readTargetStateLine(target, filepath.Join(directory, "head-name"), "read Git rebase head-name")
	if err != nil {
		return "", err
	}
	if headName != "refs/heads/"+marker.ConflictBranch {
		return "", fmt.Errorf("active Git rebase branch does not match the Stack conflict branch")
	}
	if _, err := readTargetObjectID(target, filepath.Join(directory, "onto"), "read Git rebase onto"); err != nil {
		return "", err
	}
	originalHead, err := readTargetObjectID(target, filepath.Join(directory, "orig-head"), "read Git rebase original head")
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(originalHead, marker.OriginalRefs[marker.ConflictBranch]) {
		return "", fmt.Errorf("active Git rebase original head does not match the Stack recovery marker")
	}
	if _, err := readTargetStateFile(target, filepath.Join(directory, "git-rebase-todo"), "read Git rebase todo"); err != nil {
		return "", fmt.Errorf("active Git rebase state is incomplete: %w", err)
	}
	return readTargetObjectID(target, "REBASE_HEAD", "read active Git REBASE_HEAD")
}

func validateTargetApplyRebaseState(target Target, marker targetRebaseStateMarker) (string, error) {
	const directory = "rebase-apply"
	headName, err := readTargetStateLine(target, filepath.Join(directory, "head-name"), "read Git rebase head-name")
	if err != nil {
		return "", err
	}
	if headName != "refs/heads/"+marker.ConflictBranch {
		return "", fmt.Errorf("active Git rebase branch does not match the Stack conflict branch")
	}
	if _, err := readTargetObjectID(target, filepath.Join(directory, "onto"), "read Git rebase onto"); err != nil {
		return "", err
	}
	originalHead, err := readTargetObjectID(target, filepath.Join(directory, "orig-head"), "read Git rebase original head")
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(originalHead, marker.OriginalRefs[marker.ConflictBranch]) {
		return "", fmt.Errorf("active Git rebase original head does not match the Stack recovery marker")
	}
	if _, err := readTargetStateFile(target, filepath.Join(directory, "rebasing"), "read Git apply-rebase marker"); err != nil {
		return "", fmt.Errorf("active Git rebase state is incomplete: %w", err)
	}
	for _, name := range []string{"next", "last"} {
		value, err := readTargetStateLine(target, filepath.Join(directory, name), "read Git apply-rebase progress")
		if err != nil {
			return "", err
		}
		progress, err := strconv.Atoi(value)
		if err != nil || progress < 1 {
			return "", fmt.Errorf("active Git rebase has invalid %s progress", name)
		}
	}
	if _, err := readTargetObjectID(target, filepath.Join(directory, "original-commit"), "read Git apply-rebase original commit"); err != nil {
		return "", err
	}
	return readTargetObjectID(target, "REBASE_HEAD", "read active Git REBASE_HEAD")
}

func targetStateDirectoryExists(target Target, relativePath string) (bool, error) {
	if err := validateTargetStateGitDir(target.GitDir); err != nil {
		return false, err
	}
	path := filepath.Join(target.GitDir, relativePath)
	info, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("inspect active Git rebase state: %w", err)
	}
	if !info.IsDir() {
		return false, fmt.Errorf("active Git rebase state path is not a directory")
	}
	return true, nil
}

func readTargetStateLine(target Target, relativePath, description string) (string, error) {
	data, err := readTargetStateFile(target, relativePath, description)
	if err != nil {
		return "", err
	}
	line := string(data)
	if strings.HasSuffix(line, "\n") {
		line = strings.TrimSuffix(line, "\n")
	}
	if line == "" || line != strings.TrimSpace(line) || strings.ContainsAny(line, "\x00\r\n") {
		return "", fmt.Errorf("%s is malformed", description)
	}
	return line, nil
}

func readTargetObjectID(target Target, relativePath, description string) (string, error) {
	value, err := readTargetStateLine(target, relativePath, description)
	if err != nil {
		return "", err
	}
	if !validTargetObjectID(value) {
		return "", fmt.Errorf("%s is not a valid Git object ID", description)
	}
	return value, nil
}

func validTargetObjectID(value string) bool {
	if (len(value) != 40 && len(value) != 64) || strings.Trim(value, "0") == "" {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func validTargetStateBranch(branch string) bool {
	return branch != "" && branch == strings.TrimSpace(branch) && !strings.ContainsAny(branch, "\x00\r\n")
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
	preferences, err := loadTargetRemotePreferences(target.Path, target.GitPath)
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
	currentBranch, err := targetCurrentBranchWithPath(target.GitPath, target.Path)
	if err != nil {
		return err
	}
	trunkExists, err := targetLocalBranchExistsWithPath(target.GitPath, target.Path, trunk)
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
	preferences, err := loadTargetRemotePreferences(target.Path, target.GitPath)
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
	output, err := runTargetGitWithPath(target.GitPath, target.Path, "list Git remotes for implicit selection", "remote")
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

func loadTargetRemotePreferences(worktree, gitPath string) (targetRemotePreferences, error) {
	preferences := targetRemotePreferences{
		branchPreferences: make(map[string]targetBranchRemotePreference),
	}
	var err error
	preferences.pushDefault, _, err = readTargetGitConfigWithPath(worktree, "remote.pushDefault", gitPath)
	if err != nil {
		return targetRemotePreferences{}, err
	}
	preferences.savedRemote, _, err = readTargetGitConfigWithPath(worktree, "gh-stack.remote", gitPath)
	if err != nil {
		return targetRemotePreferences{}, err
	}

	output, found, err := runTargetGitOptionalWithPath(gitPath, worktree, "list branch remote preferences", "config", "--name-only", "--get-regexp", `^branch\.`)
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
			preference.pushRemote, _, err = readTargetGitConfigWithPath(worktree, "branch."+branch+".pushRemote", gitPath)
		} else {
			preference.remote, _, err = readTargetGitConfigWithPath(worktree, "branch."+branch+".remote", gitPath)
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

func readTargetGitConfigWithPath(worktree, key, gitPath string) (string, bool, error) {
	output, found, err := runTargetGitOptionalWithPath(gitPath, worktree, "read Git remote-selection preference", "config", "--get", key)
	if err != nil || !found {
		return "", found, err
	}
	value := strings.TrimSuffix(string(output), "\n")
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", false, fmt.Errorf("Git remote-selection preference is malformed")
	}
	return value, value != "", nil
}

func targetCurrentBranchWithPath(gitPath, worktree string) (string, error) {
	output, err := runTargetGitWithPath(gitPath, worktree, "read current Git branch", "branch", "--show-current")
	if err != nil {
		return "", err
	}
	branch := strings.TrimSuffix(string(output), "\n")
	if strings.ContainsAny(branch, "\x00\r\n") {
		return "", fmt.Errorf("Git returned a malformed current branch")
	}
	return branch, nil
}

func targetLocalBranchExistsWithPath(gitPath, worktree, branch string) (bool, error) {
	_, found, err := runTargetGitOptionalWithPath(gitPath, worktree, "check for local branch ref", "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return found, err
}

func runTargetGitOptionalWithPath(gitPath, worktree, operation string, args ...string) ([]byte, bool, error) {
	commandArgs := append([]string{"-C", worktree}, args...)
	command := exec.Command(gitExecutable(gitPath), commandArgs...)
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
// Production callers provide the fixed Git executable path; the optional form
// without a path is retained for package-local unit fixtures.
func ValidateTarget(path, remote string, fixedGitPath ...string) (Target, error) {
	if len(fixedGitPath) > 1 {
		return Target{}, fmt.Errorf("at most one fixed Git executable path may be provided")
	}
	gitPath := ""
	if len(fixedGitPath) == 1 {
		gitPath = fixedGitPath[0]
		if gitPath == "" || !filepath.IsAbs(gitPath) || strings.ContainsRune(gitPath, '\x00') {
			return Target{}, fmt.Errorf("the fixed Git executable path must be absolute")
		}
		gitPath = filepath.Clean(gitPath)
	}

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

	worktreeOutput, err := runTargetGitWithPath(gitPath, inputPath, "resolve worktree root", "rev-parse", "--show-toplevel")
	if err != nil {
		return Target{}, err
	}
	worktreeRoot, err := resolveGitDirectory(inputPath, worktreeOutput, "worktree root")
	if err != nil {
		return Target{}, err
	}

	gitDirOutput, err := runTargetGitWithPath(gitPath, worktreeRoot, "resolve worktree Git directory", "rev-parse", "--absolute-git-dir")
	if err != nil {
		return Target{}, err
	}
	gitDir, err := resolveGitDirectory(worktreeRoot, gitDirOutput, "worktree Git directory")
	if err != nil {
		return Target{}, err
	}

	commonDirOutput, err := runTargetGitWithPath(gitPath, worktreeRoot, "resolve common Git directory", "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Target{}, err
	}
	commonDir, err := resolveGitDirectory(worktreeRoot, commonDirOutput, "common Git directory")
	if err != nil {
		return Target{}, err
	}

	remoteOutput, err := runTargetGitWithPath(gitPath, worktreeRoot, "list Git remotes", "remote")
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

	fetchURLs, err := targetRemoteURLs(worktreeRoot, remote, false, gitPath)
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

	pushURLs, err := targetRemoteURLs(worktreeRoot, remote, true, gitPath)
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
		GitPath:    gitPath,
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

func runTargetGitWithPath(gitPath, worktree, operation string, args ...string) ([]byte, error) {
	commandArgs := append([]string{"-C", worktree}, args...)
	command := exec.Command(gitExecutable(gitPath), commandArgs...)
	command.Env = targetGitEnvironment()
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("%s: %w", operation, err)
	}
	return output, nil
}

func gitExecutable(gitPath string) string {
	if gitPath == "" {
		return "git"
	}
	return gitPath
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

func targetRemoteURLs(worktree, remote string, push bool, gitPath string) ([]string, error) {
	args := []string{"remote", "get-url"}
	operation := "read selected remote fetch URLs"
	if push {
		args = append(args, "--push")
		operation = "read selected remote push URLs"
	}
	args = append(args, "--all", remote)
	output, err := runTargetGitWithPath(gitPath, worktree, operation, args...)
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
