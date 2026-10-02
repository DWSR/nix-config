# Minimal GitHub-native Stack instructions

Use GitHub MCP for remote-only Stack work. Discover typed local Stack tools and
exact `name`/`call_with` for `stack_checkout`, `stack_rebase` start/guarded
continue, and `stack_push`; never run `gh stack` or imitate Stack work with
per-branch Git calls.

Before each local mutation, follow the skill's explicit-path Git-MCP and affected
GitHub MCP snapshots and preview exact scope. Call the typed local Stack MCP
tool without human authorization, including rebase, push, and verified retries.
Re-inspect `exited_unverified` or uncertain outcomes before success/retry; if
state changes, repeat the snapshots and preview.

Stage only explicit conflict paths through Git-MCP; continue only after the
skill's marker/preflight. Use a user-owned handoff with the exact command; stop
for unavailable tools, explicit CLI preference, abort (`gh stack rebase --abort`),
TUI (`gh stack modify`), or another unsupported operation. Never merge or
unstack.
