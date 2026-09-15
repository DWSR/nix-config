# Global Agent Rules

# Version control: prefer the git MCP over the `git` CLI

For git operations, use the `git-mcp` server (a base MCP upstream on every
host) through the discover-then-invoke idiom — `retrieve_tools(query: "git
status")`, `retrieve_tools(query: "git commit")`, etc., then `call_tool_read`
/ `call_tool_write` against the returned `git-mcp:<tool>` — rather than
shelling out to the `git` CLI via bash.

- The opencode sandbox denies the `git_config` group and `~/.config/git`, so
  config-dependent bash `git` (commit identity, GPG/SSH signing, `~/.gitconfig`
  `[include]` directives) fails inside the sandbox. `git-mcp` runs OUTSIDE the
  sandbox as a child of mcpproxy, with full git config — it is the working path
  for commits and any config-dependent operation.
- Pass an explicit absolute `path: "/abs/repo"` on EVERY git-mcp call
  (`git_status`, `git_add`, `git_commit`, `git_diff`, ...) rather than
  setting a session working directory. `git_set_working_dir` sets a SINGLE
  working dir on the git-mcp server, which is one child of the shared
  mcpproxy daemon — that dir is global across ALL concurrent opencode
  sessions, so another session can silently repoint it mid-task. No
  `GIT_BASE_DIR` default is configured, so there is no fallback repo anyway.
- A `git_commit` "File not found" for a file you know exists, or a
  `git_status` reporting a branch you never checked out, signals a hijacked
  session working dir — re-issue the call with an explicit `path`.


# Commit messages

When writing a commit message:

- **Be concise.** Short subjects, tight bodies. Don't restate obvious
  context. One-line change → one-line message.
- **Use Conventional Commits style for titles and bodies.** Subject = type
  (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, etc.)
  + optional `(scope)` + imperative-mood lowercase summary. E.g.
  `feat(zellij): pin to 0.44.1`. Bodies (when needed) wrap at ~72 columns,
  full sentences.
- **Focus on why, not what.** The diff already shows what changed; the
  message explains why — the motivating bug, the preceding decision, the
  user-visible outcome, the constraint that forced the choice. Don't
  paraphrase the diff in prose.


# Time and dates: use the `time` MCP, not shell `date`

For the current time, today's date, or timezone conversions, use the
`time` MCP server (a base upstream on every host) through the
discover-then-invoke idiom — `retrieve_tools(query: "get current time")`,
then `call_tool_read` against the returned `time:<tool>`. Both tools are
read-only. Do NOT shell out to `date`.

- **Current date / time:** `time:get_current_time` with
  `args: { timezone: "<IANA name>" }` (local default: `America/Toronto`).
  Use this whenever you need today's date or the wall-clock time. Do not guess
  the date or derive it from unrelated artifacts (commit timestamps, file mtimes,
  the training cutoff).
- **Timezone conversion:** `time:convert_time` with
  `args: { source_timezone: "<IANA>", time: "HH:MM", target_timezone: "<IANA>" }`
  (24-hour clock, IANA zone names).
- The opencode sandbox denies `/bin/date` (macOS's only `date`; no
  coreutils on PATH), so bash `date` fails inside the sandbox. The `time`
  MCP runs OUTSIDE the sandbox as a child of mcpproxy — it is the working
  path for any clock or date read.
