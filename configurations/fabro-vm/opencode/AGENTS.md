# OpenCode server host rules (fabro VM guest)

You are OpenCode v1 running as a server on the fabro NixOS guest
(`opencode.service`, a systemd DynamicUser). The web console is exposed
on the tailnet as `svc:opencode`, and sessions start in the guest-local
workspace root at `/var/lib/opencode/workspace`.

## Tools on this host

- `git`, `gh` (with the `gh-stack` extension), and `nix` are installed
  and are the correct tools here. Use them directly in the bash tool.
  There is no git-mcp server, no mcpproxy, and no AgentMemory on this
  host; none of the mac host's MCP-based workflows apply.
- GitHub authentication comes from the service's dedicated token
  (`GITHUB_TOKEN` / `GH_TOKEN`); HTTPS remotes authenticate through
  `gh auth git-credential`, and commits are SSH-signed by the service's
  signing key. Do not add credentials of your own.
- Shell `date` is allowed: the `time` MCP server does not exist here.

## Workspace

- The workspace root is `/var/lib/opencode/workspace` — a guest-local
  directory, not a shared mount. Clone repos here and treat GitHub as
  the sync point with other machines. It is lost if the Lima VM is
  recreated; push before relying on any state.

## Commit messages

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
