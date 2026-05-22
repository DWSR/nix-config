# Working with Graphite (gt)

`gt` (Graphite CLI, invoked via mcpproxy's discover-then-invoke idiom
— `retrieve_tools(query: "gt run gt command")` returns
`gt-mcp:run_gt_cmd`, then invoke with
`call_tool_write(name: "gt-mcp:run_gt_cmd", args: { command: "<gt subcommand>" })`)
is the preferred tool for stacked PRs in internal Shopify repos.
Wraps git; has known failure modes around strict commit/rebase hooks,
shared worktree metadata, and state drift.

Full recovery catalog lives in the `graphite-pitfalls` skill. Load it
ONLY on an actual gt failure (triggers in Pitfall index below). For
new failure-mode investigation beyond the catalog, see
`memories/2026-04-30-graphite-pitfalls.md` in the Obsidian vault.

## Decide whether to use gt at all

Before any gt command:

- **Internal Shopify monorepos** (shop/world, infra-central,
  globaldb-yugabyte, similar): default to gt.
- **Open-source Shopify repos** (e.g. `Shopify/cli-kit`): plain git +
  `gh pr create`. ASK if unsure — explicit user policy.
- **Personal repos** (e.g. `DWSR/nix-config`): plain git unless the
  user is already using gt locally.

## Green path: gt-MCP-only stacks don't need `--force`

If every commit, rebase, and push in a stack went through the gt MCP
(mcpproxy's `call_tool_write` against `gt-mcp:run_gt_cmd` — discovered
via `retrieve_tools` — invoking `gt create`, `gt modify`, `gt submit`,
`gt restack`, `gt sync`, `gt track` via `args: { command: "<gt subcommand>" }`),
then `gt submit --no-interactive` succeeds WITHOUT `--force`. Metadata
stays in lock-step with the remote; no SHA divergence.

`--force` is only relevant when the stack was manipulated OUTSIDE the
gt MCP:

- Plain `git rebase`, `git commit --amend`, or `git reset` (→ B2).
- Teammate push to a shared branch.
- Graphite server-side auto-rebase after a downstream PR merge (→ B7).
- Manual `git push`.
- Cross-worktree cache poisoning (→ B3).

If reaching for `gt submit --force` on a stack only touched via the
MCP, stop and re-read the error. Most likely B7 (verify
diff-equivalence first) or B3 (try `gt sync`) — not real divergence.

Pre-emptive rule: track every direct git invocation against a stack
mentally. The moment you reach for `git rebase`, `git commit --amend`,
or direct `git push`, the stack has left the green path — `--force`
enters the picture from then on.

## Bypass autonomy rule

ALWAYS ask the user via the `question` tool before invoking any
`--no-verify`, `--force`, `--force-with-lease`, or git environment override
like `GIT_EDITOR=true`, regardless of how unambiguous the documented
recovery looks. Even when this guidance marks a bypass as "the documented
recovery", confirm with the user in the current session before applying it.
The cost of asking is low; the cost of an unauthorized force-push or
hook-bypass is high. No carve-outs, including the prek pre-rebase case.

This rule does NOT mean you should pre-emptively pass `--force` to every
`gt submit`. On a gt-MCP-only stack `gt submit --no-interactive` works
without any flag bypass (see "Green path" above) and no authorization
question is needed. Only ask for `--force` authorization when you have
classified the failure as B2 / B3 / B7 and confirmed force is the
recovery the catalog prescribes.

## Pitfall index

Classify the gt failure here, then load the `graphite-pitfalls` skill
for the bash recovery.

**Category A — hooks intercept gt's internal git invocations:**

- **A1** — gt argv mangling (parens/colons in commit messages → commitlint reject)
- **A2** — hook validation rejects (prek 0.2.17 missing `--pre-rebase-upstream`; commitlint flakiness; `gt modify` fails where direct amend succeeds)
- **A3** — `prepare-commit-msg` hook hangs `git rebase --continue` on an editor (npm policy blocked, `$EDITOR` never returns)

**Category B — Graphite metadata / state hygiene:**

- **B1** — untracked branch (`BAD_PARENT_NAME` in `.graphite_cache_persist`)
- **B2** — "Branch updated remotely outside of Graphite" after a local rebase (real SHA divergence)
- **B3** — cross-worktree cache poisoning ("Could not find branch X" for an unrelated branch)
- **B4** — `gt create` from a worktree where main is checked out elsewhere
- **B5** — phantom empty commits from a mid-stack restack
- **B6** — stale trunk in `.git/.graphite_repo_config` (every gt command errors `Could not find branch`)
- **B7** — local restack vs. remote auto-rebase produce different SHAs with identical diffs

**Category C — workflow / mental-model traps (silent UX, no error surfaced):**

- **C1** — `gt modify` commits on the CURRENT branch, not the file's owning PR
- **C2** — `gt submit --no-interactive` only submits downstack; needs `--stack` at the bottom
- **C3** — force-pushing the bottom of an N-PR stack invalidates approvals on all upstack PRs
- **C4** — open-source repos: don't use gt (use plain git + `gh pr create`)
- **C5** — `gt submit --no-interactive` always creates PRs as drafts (no override flag)
- **C6** — the `github:pull_request_review_write` tool (invoked via mcpproxy's `retrieve_tools` + `call_tool_write` idiom) has NO `resolve_thread` method; use `gh api graphql` instead
- **C7** — CI-fix cycles on stacked PRs are amplified-cost (~20 force-pushes per 5-cycle 4-PR debug session)

## Workflow rules summary

1. Try `gt <command>` as documented.
2. If it errors, classify via the Pitfall index above. On a gt-MCP-only
   stack `gt submit --no-interactive` should succeed without `--force`;
   if it doesn't, the stack left the green path (B2/B3/B7 most likely).
   Load the `graphite-pitfalls` skill for the recovery.
3. Apply the documented recovery.
4. If the recovery requires `--no-verify`, `--force`, `--force-with-lease`,
   or a git environment override like `GIT_EDITOR=true`, ASK THE USER
   FIRST via the `question` tool. No exceptions. Conversely, do NOT
   pre-emptively reach for these flags on a stack only touched via the
   gt MCP — the green path doesn't need them.
5. After every plain-git rebase or amend, validate with
   `git log --oneline origin/main..HEAD` for adjacent same-title or
   same-tree commits (phantom detection — see B5).
6. Before any `--force` push (B2/B7), verify diff-equivalence with
   `diff <(git diff origin/main...local) <(git diff origin/main...remote)`
   to confirm you're not clobbering teammate work. Differ → B2 (real
   divergence); identical → B7 (auto-rebase).
7. After every `gt restack` / `gt submit --force`, sanity-check the
   remote with `gh pr view <num> --json mergeable,mergeStateStatus` —
   `DIRTY` is "computing" (~30s lag); `MERGEABLE` or `BLOCKED` is settled.
8. After `gt submit --no-interactive`, verify each PR's title/body/isDraft
   with `gh pr view <num> --json title,body,isDraft` before declaring the
   work done; ask the user whether to leave as drafts or `gh pr ready`
   them (see C5).

When in doubt, present the failure and proposed workaround to the user
via the `question` tool before bypassing.
