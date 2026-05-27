# Brief: git-clone-isolation

## Problem

The user works with Graphite-managed PR stacks in Git repositories where Git
worktrees share repository metadata. Graphite can read or mutate shared `.git`
state across worktrees, causing cross-worktree cache poisoning and branch-state
errors. The user needs fast setup for isolated workspaces without sharing the
same `.git` directory.

## Current State

This repo already provides Git configuration, hook management, `~/scratch`, and
the `zellij-worktree` plugin. Worktrees are cheap, but they share Git metadata
and do not isolate Graphite's `.git/.graphite_*` files. Creating a fresh clone
from the network avoids shared metadata, but it is slower and wasteful for large
repositories.

## Desired Outcome

A local tool can maintain a reconstructable bare cache of an upstream
repository's main branch and create fast, fully isolated working clones from it.
Each generated clone has its own `.git` directory, its `origin` remote points to
the original upstream, and Graphite state is isolated per clone.

## Approach

Implement a Nix/Home Manager module plus CLI. The CLI maintains a bare,
main-only cache under `$XDG_STATE_HOME/git-clone-isolation` using explicit Git
fetch refspecs instead of a full mirror. It creates working clones with
`git clone --reference-if-able` plus `--dissociate` so the clone copies needed
objects and does not depend on the cache after creation. After cloning, it
rewrites `origin` to the original upstream and checks out the requested base
branch. Working clones default under `~/scratch`, with an explicit destination
override.

## Scope

- **In**:
  - CLI commands to initialize/update the bare main-branch cache and create an
    isolated clone.
  - Home Manager wiring that installs the CLI on both hosts with configurable
    cache root, clone root, and default branch.
  - Safe remote handling: cache remote points to upstream; generated clone
    `origin` points to upstream, not the cache.
  - Main-branch-only cache by default, with refspecs that avoid mirroring every
    branch and tag.
  - Validation using local fixture repositories to prove cache update, clone
    creation, remote rewrite, and `.git` isolation.

- **Out**:
  - Replacing Graphite, wrapping every `gt` command, or modifying Graphite
    metadata directly.
  - Managing Git worktrees or changing `zellij-worktree` behavior.
  - Multi-branch or full-repository mirrors beyond the selected default branch.
  - Background daemons or automatic scheduled cache refresh.
  - Synchronizing uncommitted work between isolated clones.

## Boundary Candidates

- CLI implementation and argument parsing in `scripts/`.
- Home Manager module and package exposure for both hosts.
- Fixture-based tests for Git cache/clone behavior.

## Out of Boundary

- Graphite pitfall recovery flows such as force pushes, stale trunk repair, or
  `gt repo init` handling.
- Zellij UI integration for choosing or opening clones.
- Repo-specific Graphite stack creation policies.

## Upstream / Downstream

- **Upstream**: Git CLI semantics for bare repositories, fetch refspecs,
  `git clone --reference-if-able --dissociate`, and `git remote set-url`.
  Existing nix-config script packaging and Home Manager module patterns.
- **Downstream**: Future shell/zellij convenience wrappers, Shopify-specific
  defaults for internal repositories, or Graphite workflow guidance that points
  users at isolated clones instead of worktrees.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**:
  - `cc-sdd-integration` for spec/task boundary conventions.
  - `subagent-context-budget` only because tests share flake-check patterns.
  - Existing zellij worktree configuration, which remains unchanged.

## Constraints

- Must keep generated clones fully isolated from the bare cache after creation;
  no persistent alternates dependency.
- Must be safe to delete and rebuild the cache because it is non-authoritative
  state under `$XDG_STATE_HOME`.
- Must avoid network fetches during tests by using local fixture remotes.
- Must work on both nix-darwin hosts through declarative Nix/Home Manager
  installation.
