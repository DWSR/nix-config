# OpenCode v1 Web Console on the fabro Host — Implementation Handoff

## Objective

Run OpenCode v1 as a systemd **DynamicUser** service on the fabro NixOS guest,
serving its web console on loopback and exposing it on the tailnet as
`svc:opencode` (`https://opencode.tuxedo-musical.ts.net`). The service is a
vanilla OpenCode install (the repo's pinned `opencode-pinned` package, no
`nono`, no wrapper preflights) with:

- the local LiteLLM gateway (`http://127.0.0.1:4000/v1`) as the model provider,
- a dedicated GitHub token plus `gh` and the `gh-stack` extension,
- `git` (token auth over HTTPS) with SSH commit signing via a key provisioned
  from sops,
- `nix` on PATH so sessions can build derivations on the host,
- a guest-local workspace where repos are cloned (GitHub is the sync point
  with the mac).

This document authorizes implementation. It does not authorize commits,
secret syncing, or deployment — those are gated on the user (see
"User actions" and "Deploy").

Planning date: 2026-10-14. Repo: `/Users/brandonmcnama/repos/github.com/DWSR/nix-config`,
branch `main`, HEAD `8765bac` ("chore(fabro): bump to 0.386.0-nightly.0").

## Locked decisions

1. **Guest-local workspace.** A DynamicUser cannot write a Lima virtiofs share
   (VZ maps shares to the cidata user; see `configurations/fabro-vm/fabro.nix`
   comments). Repos live in the VM; sync via GitHub.
2. **Config: reuse the common opencode config, adapted.** Port settings,
   `AGENTS.md`, subagents, skills, LSP set, and env exports. Drop everything
   that assumes the mac's nono sandbox / mcpproxy / AgentMemory. `git`/`gh`/
   `nix` must be allowed in the bash tool (the common config denies `git`
   because git-mcp is the mac path; there is no git-mcp on the guest).
3. **Provider: local LiteLLM**, declarative, no OpenCode `auth.json` (the
   provider key comes from the rendered env file; the gateway keeps the
   upstream credentials).
4. **Session headers: dynamic, never static.** The provider id must start
   with `opencode` so OpenCode itself sends `x-opencode-session` and
   `x-opencode-session-id` for every request. Forwarding is group-scoped:
   the gateway forwards client headers to a logical model's group when the
   catalog marks any of its deployments' providers with
   `requiresClientSessionHeader`. Do **not** add static provider
   `options.headers`.
5. **Server password** via sops (`OPENCODE_SERVER_PASSWORD`), in addition to
   the tailnet ACL.
6. **GitHub token**: new sops secret `opencode-github-token` sourced from
   `op://Private/GitHub/Tokens/OpenCode` (user creates the field later).
7. **Commit signing now**: the signing key is a 1Password **SSH Key item**
   (not a text field, no base64 in 1P). The sync script gains multi-line
   support; the guest installs the key from a systemd credential.

## Verified evidence (do not re-derive)

### opencode v1.19.0 session headers

Inspected the mac build of the pinned package
(`/nix/store/c2r891br1lq63c5ykglv7wj0k63szf6g-opencode-1.19.0/bin/.opencode-wrapped`,
bun-compiled). The provider-request header logic is:

```js
headers: {
  "x-opencode-session-id": o.sessionID,
  ...(o.parentSessionID
    ? {"x-opencode-parent-session-id": o.parentSessionID}
    : {}),
  ...(o.model.providerID.startsWith("opencode")
    ? { ...(W ? {"x-opencode-project": W} : {}),
        "x-opencode-session": o.sessionID,
        "x-opencode-request": o.user.id,
        "x-opencode-client": o.flags.client,
        "User-Agent": Cs }
    : { "x-session-affinity": o.sessionID,
        "X-Session-Id": o.sessionID,
        "User-Agent": Cs }),
  ...(o.parentSessionID ? {"x-parent-session-id": o.parentSessionID} : {}),
  ...o.model.headers
}
```

So `x-opencode-session` (what the Go/Zen gateway requires; see the comment in
`configurations/fabro-vm/fabro.nix` around `default_headers."x-opencode-session"`)
is emitted **only when the provider id starts with `"opencode"`**. Other
`startsWith("opencode")` branches in the bundle are cosmetic/benign (provider
list ordering, prompt-cache-key default, model suggestion priority).

### LiteLLM header forwarding

`configurations/fabro-vm/litellm.nix` drives
`litellm_settings.model_group_settings.forward_client_headers_to_llm_api`
from the catalog:

```nix
litellm_settings.model_group_settings.forward_client_headers_to_llm_api =
  catalog.forwardClientHeaders;
```

The catalog lists a logical model in that setting when any of its
deployments' providers sets `requiresClientSessionHeader = true`; every
sibling in the group then forwards the same headers, including a ChatGPT
sibling of a unified group. The allowlist is every `x-*` header except
`x-stainless-*`, plus `anthropic-beta`. LiteLLM strips `Authorization` and
its special authentication headers before forwarding, so credentials and
content-type never leave the gateway.

Forwarding matches on the logical model name, which is provider-free (e.g.
`deepseek-v4.1-flash`), so OpenCode's per-session headers reach the
OpenCode Go/Zen upstream unchanged.

### systemd facts

- `LoadCredential=` credentials (and `$CREDENTIALS_DIRECTORY`) are available to
  `ExecStartPre=` since systemd 252 (PR #24734). NixOS 26.05 ships ≥257.
- `StateDirectory=` accepts nested paths (e.g. `opencode/workspace`) since
  systemd 256. Fallback if rejected: `WorkingDirectory=/var/lib/opencode` plus
  an `sh -c 'cd … && exec …'` ExecStart.
- `EnvironmentFile=` is read by systemd as root before dropping to the service
  user, so root-only 0400 sops templates work (as `fabro-env` already proves).

### gh extensions layout

Home Manager installs `programs.gh.extensions` as
`~/.local/share/gh/extensions/<pname> -> <pkg>/bin` (linkFarm;
`modules/programs/gh.nix`). Replicate exactly: a symlink
`$XDG_DATA_HOME/gh/extensions/gh-stack -> ${pkgs.unstable.gh-stack}/bin`.

### opencode config layout (Home Manager module, same paths to mirror)

`$XDG_CONFIG_HOME/opencode/`: `opencode.json` (settings, with
`"$schema": "https://opencode.ai/config.json"`), `AGENTS.md`, `agents/<name>.md`,
`skills/<name>/…`, `plugins/*.ts`. The service installs the same layout.

## Target design

### systemd unit (`systemd.services.opencode`)

- `DynamicUser = true`; dynamic user name resolves to `opencode`.
- `StateDirectory = [ "opencode" "opencode/workspace" ]` (nested entry creates
  the workspace with correct ownership; see fallback above).
- `WorkingDirectory = "/var/lib/opencode/workspace"`.
- `after = [ "litellm.service" ]`, `wants = [ "litellm.service" ]` (soft: a
  stopped litellm should not take opencode down, unlike fabro's hard requires).
- `EnvironmentFile = config.sops.templates."opencode-env".path`.
- `Environment` (exact set):
  - `HOME=/var/lib/opencode`
  - `XDG_CONFIG_HOME=/var/lib/opencode/config`
  - `XDG_DATA_HOME=/var/lib/opencode/share`
  - `XDG_CACHE_HOME=/var/lib/opencode/cache`
  - `XDG_STATE_HOME=/var/lib/opencode/state`
  - `OPENCODE_EXPERIMENTAL_LSP_TOOL=true`
  - `OPENCODE_DISABLE_LSP_DOWNLOAD=true`
  - `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true`
- `path` (NixOS systemd module sets PATH for all Exec\*): `pkgs.git`, `pkgs.gh`,
  `pkgs.nix`, `pkgs.ripgrep`, `pkgs.openssh`, `pkgs.unstable.gh-stack`,
  `pkgs.cc-sdd`, the cc-sdd-init helper, and the common LSP set:
  `bash-language-server`, `clang-tools`, `gopls`, `nixd`, `pyright`, `rubocop`,
  `rust-analyzer`, `terraform-ls`, `typescript-language-server`,
  `vscode-langservers-extracted`, `yaml-language-server`.
- `LoadCredential = "opencode-signing-key:${config.sops.secrets."opencode-signing-key".path}"`.
- `ExecStartPre` (runs as the service user; literal paths; use
  `''${CREDENTIALS_DIRECTORY}` inside Nix indented strings):
  1. `mkdir -p /var/lib/opencode/.ssh /var/lib/opencode/share/gh/extensions`
  2. `rm -rf /var/lib/opencode/config` then
     `cp -r ${opencodeConfig} /var/lib/opencode/config` (declarative-wins)
  3. `ln -sfn ${pkgs.unstable.gh-stack}/bin /var/lib/opencode/share/gh/extensions/gh-stack`
  4. `install -m 0644 ${opencodeGitconfig} /var/lib/opencode/.gitconfig`
  5. `install -m 0600 "$CREDENTIALS_DIRECTORY/opencode-signing-key" /var/lib/opencode/.ssh/opencode_signing_key`
  6. Derive the public key (a redirect needs a shell — systemd Exec lines
     do not run via sh):

     ```sh
     sh -c '${pkgs.openssh}/bin/ssh-keygen -y \
       -f /var/lib/opencode/.ssh/opencode_signing_key \
       > /var/lib/opencode/.ssh/opencode_signing_key.pub'
     ```

- `ExecStart` runs `${pkgs.opencode-pinned}/bin/opencode serve` with
  `--hostname 127.0.0.1 --port 4096`.
- `ExecStartPost` health gate (mirror `fabroHealthGate`/`litellmHealthGate`
  style, ~30 attempts): accept HTTP 200 **or 401** from
  `http://127.0.0.1:4096/` as "listening" (401 = basic auth active; do not put
  the password in argv).
- `Restart = "on-failure"`, `RestartSec = 5`, `LimitNOFILE = 65536`.
- Hardening in the fabro-service style: `NoNewPrivileges`, `PrivateTmp`,
  `ProtectSystem = "strict"`, `ProtectHome = true`, `ProtectKernel*`,
  `RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ]`,
  `ReadWritePaths = [ "/var/lib/opencode" ]` (StateDirectory already implies
  this; keep explicit for clarity).

### Filesystem layout (`/var/lib/opencode`)

```text
config/            regenerated each start (settings, agents, skills)
share/gh/extensions/gh-stack -> ${gh-stack}/bin
cache/, state/
workspace/         service cwd; repos cloned here
.ssh/opencode_signing_key{,.pub}
.gitconfig
```

Persists across restarts and switches; **lost if the Lima instance is
recreated** — GitHub is the source of truth.

### opencode settings (`opencode.json`, adapted from `home-manager/common/opencode.nix`)

```nix
{
  "$schema" = "https://opencode.ai/config.json";
  model = "opencode-litellm/deepseek-v4.1-flash";
  subagent_depth = 10;
  snapshot = false;        # parity with the mac config; git is the rollback path
  autoupdate = false;      # binary is nix-pinned
  agent.title.disable = true;
  agent.summary.disable = true;
  lsp.eslint.command = [ "vscode-eslint-language-server" "--stdio" ];
  lsp.typescript.command = [ "typescript-language-server" "--stdio" ];
  skills.paths = [ ".claude/skills" ];
  permission.bash."*" = "allow";          # NO git/gt denies on this host
  permission.external_directory = "allow";
  provider.opencode-litellm = {
    npm = "@ai-sdk/openai-compatible";
    name = "OpenCode (LiteLLM)";
    options = {
      baseURL = "http://127.0.0.1:4000/v1";
      apiKey = "{env:LITELLM_MASTER_KEY}";
    };
    models = {
      "gpt-6-luna" = { name = "GPT-6 Luna (xhigh)"; };
      "gpt-6-luna-none" = { name = "GPT-6 Luna (no thinking)"; };
      "gpt-6-astra" = { name = "GPT-6 Astra (xhigh)"; };
      "gpt-6.1-sol" = { name = "GPT-6.1 Sol (xhigh)"; };
      "deepseek-v4.1-flash" = { name = "DeepSeek V4.1 Flash"; };
      "glm-5.3-flash" = { name = "GLM-5.3 Flash"; };
      "beam-free" = { name = "Beam Free"; };
      "omen-alpha" = { name = "Omen Alpha"; };
      "longcat-2.0" = { name = "LongCat 2.0"; };
      "big-pickle" = { name = "Big Pickle"; };
    };
  };
}
```

Notes:

- The model map is `catalog.openCode.models` and the default is
  `catalog.openCode.defaultModel`, both generated from
  `configurations/fabro-vm/litellm-catalog.nix`. Do not hand-edit the map:
  a catalog edit reaches `opencode.json` at the next service restart.
- The provider id **must start with `opencode`** (hence
  `opencode-litellm`); that is the entire mechanism for OpenCode's dynamic
  `x-opencode-session` and `x-opencode-session-id` headers. Do not rename
  it to `litellm` and do not pin a static session id at the provider level.
- The ChatGPT OAuth login is a precondition for gateway startup, not just
  for ChatGPT calls: LiteLLM 1.86 holds proxy startup in the device-code
  flow while loading each ChatGPT deployment. Without `auth.json` in
  `CHATGPT_TOKEN_DIR`, `/health/liveliness` never answers and
  `litellm.service` fails its health gate. Run the in-guest
  `litellm-chatgpt-login` procedure before starting the gateway; once it
  completes, every catalog model works, including the OpenCode Go and Zen
  deployments.
- Model ids in the picker read `opencode-litellm/<logical-id>`.

### Fabro model surface

`configurations/fabro-vm/fabro.nix` sets
`llm.providers.litellm.models = catalog.fabro.models`. Each record is keyed
by a provider-free logical id and carries:

- `api_model` equal to its key, with no provider prefix;
- `limits` from the group's deployments;
- `capabilities.caching` and `capabilities.cache_routing` set to `true` on
  every record, which is what makes Fabro emit its conversational
  `prompt_cache_key`;
- `reasoning_effort` from the catalog's effort-level map where present.

`default_model`, `cli.exec.model.name`, and `run.model.name` all use
`catalog.fabro.defaultModel`, which is `deepseek-v4.1-flash` today. The
provider-level `default_headers."x-opencode-session" = "fabro-litellm"`
satisfies the OpenCode Go upstream requirement; it is not the affinity
identity (see "Session identity").

### Adding a model

Add the model to `configurations/fabro-vm/litellm-catalog.nix`. Both client
surfaces are generated projections of the validated catalog: OpenCode reads
`catalog.openCode.models` and Fabro reads `catalog.fabro.models`, so each
client picks the model up on its next service restart. Do not add it to
`configurations/fabro-vm/opencode.nix` or
`configurations/fabro-vm/fabro.nix` by hand, and do not update only one
client: the two surfaces move together. The full catalog edit procedure is
in `docs/litellm-routing-runbook.md`.

### Session identity

Affinity pins are keyed by logical model plus session identity. The gateway
takes the identity from one of three request sources:

- **OpenCode's `x-opencode-session-id`.** OpenCode sends it per session;
  LiteLLM writes it to `metadata.session_id` before the request reaches
  the router, so a header always wins over a body key. No client
  configuration is involved.
- **Fabro's `prompt_cache_key`.** Fabro emits a per-conversation key for
  every catalog record because each record sets `caching` and
  `cache_routing`. The in-process bridge in
  `configurations/fabro-vm/litellm_affinity_bridge.py` hashes the key to
  `bridge:v1:<producer>:<sha256>`, using the `User-Agent` product token as
  the producer, then drops the key from the outbound body.
- **The static `x-opencode-session: fabro-litellm`.** Fabro attaches it at
  the provider level to satisfy the OpenCode Go upstream requirement. It
  is not an identity: it does not match LiteLLM's session-header pattern,
  so a Fabro request carrying it still derives its identity from the cache
  key.

Pins are in-process, keyed by logical model and identity, and expire after
6 hours idle. A gateway restart clears every pin; Fabro restarts with the
gateway because of its hard dependency. When ids change, the gateway and
both clients move together in the same change; there are no aliases for
removed ids.

### `AGENTS.md` (server variant)

Compose at eval time: a new server chunk (write it at
`configurations/fabro-vm/opencode/AGENTS.md`) plus
`home-manager/common/agents-cc-sdd.md` appended verbatim (verified to contain
no nono/mcpproxy/AgentMemory references). The server chunk must state:

- Git/gh/nix CLIs are available and are the correct tools here; there is no
  git-mcp, no mcpproxy, and no AgentMemory on this host.
- Shell `date` is allowed (the time MCP does not exist here).
- Commit conventions (copy from `home-manager/common/agents.md`): Conventional
  Commits, concise subjects, why-not-what bodies, ~72-col wrap.
- Workspace root is `/var/lib/opencode/workspace`.

### Subagents, skills, LSP

- Agents (copy verbatim from `home-manager/common/agents/`, appending
  `home-manager/common/opencode/caveman-lite.md` to each, matching the personal
  host's `enableCaveman = true`): `nix-pkg.md`, `kiro-spec-orchestrator.md`,
  `nvim-tailor.md`, `security-auditor.md`.
- Skills:
  - `fabro-workflow` and `process-flow-diagram` from `home-manager/common/skills/`
    (the latter sourced from the `Cocoon-AI/process-flow-diagram-generator`
    fetch already pinned in `home-manager/common/opencode.nix`).
  - `architecture-diagram` from the `Cocoon-AI/architecture-diagram-generator`
    fetch pinned in `configurations/personal/home-manager/opencode.nix`
    (rev `4b9087d55268c79a935105439dbcd37b630fc3f3`).
  - All 17 `kiro-*` skills from `pkgs.cc-sdd-skills/skills` (enumerate with
    `builtins.readDir`, mirroring `home-manager/common/cc-sdd.nix`).
  - **Exclude `github-native-stacks`** — its workflow depends on the MCP stack
    tooling that does not exist on this host.
- Plugins are **not** ported (see Out of scope).

### git config (`.gitconfig`)

```ini
[user]
  name = Brandon McNama
  email = brandonmcnama@outlook.com
  signingkey = /var/lib/opencode/.ssh/opencode_signing_key.pub
[init]
  defaultBranch = main
[pull]
  rebase = true
[push]
  autoRemoteSetup = true
[credential "https://github.com"]
  helper = !gh auth git-credential
[url "https://github.com/"]
  insteadOf = "git@github.com:"
[commit]
  gpgsign = true
[gpg]
  format = ssh
[branch]
  sort = -committerdate
[rerere]
  enabled = true
```

`ssh-keygen` (openssh, already on PATH) is the default signer; no
`gpg.ssh.program` needed. The pubkey is derived in ExecStartPre, so GitHub
registration must match the private key exactly.

### Tailscale

Add a third line to `systemd.services.tailscale-serve` ExecStart in
`configurations/fabro-vm/tailscale.nix`:

```text
${lib.getExe cfg.package} serve --service=svc:opencode --https=443 http://127.0.0.1:4096
```

The `svc:opencode` service must exist in the Tailscale admin console (user
action) or the command fails until it does (the unit retries via
`Restart = "on-failure"`).

## Secrets and user actions

Three new sops secrets in `secrets/fabro.fabro.yaml` (same store, same
`&host_fabro` recipient; `.sops.yaml` unchanged):

- `opencode-github-token` from `op://Private/GitHub/Tokens/OpenCode`:
  used for `GITHUB_TOKEN` + `GH_TOKEN` in the service.
- `opencode-server-password` from
  `op://Private/OpenCode/Server Password`: used for
  `OPENCODE_SERVER_PASSWORD` (basic auth user defaults to `opencode`).
- `opencode-signing-key` from
  `op://Private/OpenCode Signing Key/private key` (SSH Key item; field-id
  form `privateKey` as fallback): installed as the git SSH signing key.

New template `sops.templates."opencode-env"` (mode default 0400 root is fine —
systemd reads EnvironmentFile as root):

```text
GITHUB_TOKEN=${config.sops.placeholder."opencode-github-token"}
GH_TOKEN=${config.sops.placeholder."opencode-github-token"}
LITELLM_MASTER_KEY=${config.sops.placeholder."litellm-master-key"}
OPENCODE_SERVER_PASSWORD=${config.sops.placeholder."opencode-server-password"}
```

with `restartUnits = [ "opencode.service" ]`. Reusing `litellm-master-key` in a
second template is fine.

### User actions (must happen before sync/deploy)

1. **GitHub PAT** (dedicated): GitHub → Developer settings → token with at
   least `repo` + `workflow` (+ `read:org`) scopes. Store in the existing
   `GitHub` item, field `Tokens/OpenCode`.
2. **Server password**: generate in 1Password; store on the `OpenCode` item as
   field `Server Password`.
3. **Signing key**: 1Password → New Item → **SSH Key** → Generate (Ed25519),
   vault `Private`, name `OpenCode Signing Key`. Copy the item's **public key**
   into GitHub → Settings → SSH and GPG keys → New SSH key → key type
   **Signing Key**.
4. **Tailscale console**: define service `opencode` (tcp:443), approve
   `tag:fabro` as host (same flow as `svc:fabro`), grant the user's devices.
5. `op signin`, then run the sync (see Deploy). All three 1Password sources
   must resolve or the sync exits 3 without touching the store.

## Implementation tasks

1. **`scripts/fabro-sync-from-1password.nix` — multi-line value support.**
   The current emit writes single-quoted scalars; a multi-line PEM would be
   folded to spaces and corrupted. Change the emit loop to:

   ```bash
   if [[ "$v" == *$'\n'* ]]; then
     v_escaped="${v//\\/\\\\}"
     v_escaped="${v_escaped//\"/\\\"}"
     v_escaped="${v_escaped//$'\n'/\\n}"
     printf '%s: "%s"\n' "$key" "$v_escaped"
   else
     v_escaped="${v//\'/\'\'}"
     printf "%s: '%s'\n" "$key" "$v_escaped"
   fi
   ```

   (escape order: backslash, quote, newline). This keeps every key on one
   physical line, so the line-based carry-forward parser and the coverage gate
   remain valid verbatim. Update the header "Token shape assumption" comment
   (multi-line values are emitted as YAML double-quoted scalars). Carry-forward
   re-emits the exact scalar text, so a carried multi-line value round-trips.

2. **`configurations/fabro-vm/opencode.nix` (new).** The service module per
   "Target design": unit, config tree assembly, gitconfig, health gate,
   credential handling. Build the config tree with `pkgs.runCommand`
   (`$out` contains `opencode.json`, `AGENTS.md`, `agents/*.md`, `skills/*`);
   generate `opencode.json` with `pkgs.formats.json`, `AGENTS.md` with
   `pkgs.writeText`, gitconfig with `pkgs.writeText`.

3. **`configurations/fabro-vm/opencode/AGENTS.md` (new).** The server chunk
   per "AGENTS.md" above.

4. **`configurations/fabro-vm/default.nix`.**
   - `imports` += `./opencode.nix`.
   - `fabro.onePasswordSecrets` += the three URIs from the table.
   - `sops.secrets` += the three names.
   - `sops.templates."opencode-env"` as specified.

5. **`configurations/fabro-vm/tailscale.nix`.** Third ExecStart line for
   `svc:opencode` (fabro/litellm lines unchanged).

6. **`flake.nix`.**
   - fabro-vm inline module: extend
     `nixpkgs.overlays = [ outputs.overlays.fabro ]` to also include
     `outputs.overlays.unstable-packages` and `outputs.overlays.custom-packages`
     (needed for `pkgs.opencode-pinned` and `pkgs.unstable.gh-stack`; both are
     lazy, no effect unless referenced). Mirror the darwin host's overlay set.
   - Extend `fabro-vm-guest-eval` asserts: `systemd.services ? opencode`;
     `DynamicUser == true`; `StateDirectory` contains `"opencode"`;
     `EnvironmentFile == sops.templates."opencode-env".path`;
     `path` contains `git`, `gh`, `nix` (by pname); `LoadCredential` references
     the signing-key sops path; template content has `GITHUB_TOKEN=`,
     `OPENCODE_SERVER_PASSWORD=`, and the placeholders; template
     `restartUnits == [ "opencode.service" ]`; the three new `sops.secrets`
     exist; `tailscale-serve` ExecStart has length 3 and contains
     `--service=svc:opencode --https=443 http://127.0.0.1:4096`. Update the
     check's summary string.

7. **`secrets/README.md`.** Add the three rows to the fabro-store table
   (matching the existing row format) and note that `opencode-signing-key`
   comes from an SSH Key item and is multi-line (the sync supports it).

8. **Formatting/gates.** `nix fmt` (nixfmt-rfc-style); statix/deadnix clean;
   `nix build .#checks.aarch64-darwin.fabro-vm-guest-eval` green.

## Deploy

1. `git add` every new file (untracked files are invisible to the flake fetch
   used by `nix eval`/`nix run`; tracked-file edits are fine uncommitted).
2. `nix build .#checks.aarch64-darwin.fabro-vm-guest-eval`.
3. After the user completes the 1Password items:
   `nix run .#fabro-sync-from-1password` (requires `op signin`). Round-trip
   check the key:

   ```sh
   nix shell nixpkgs#sops --command sops -d \
     --extract '["opencode-signing-key"]' secrets/fabro.fabro.yaml \
     | ssh-keygen -l -f /dev/stdin
   ```

4. `lima-vm-deploy` from the repo root (streams the tree into the guest and
   runs `nixos-rebuild switch --flake .#fabro-vm` in-guest; the mac has no
   Linux builder). The first switch builds `opencode-pinned` for
   aarch64-linux — see Risks. Optional pre-flight inside the streamed tree:
   `nix build .#nixosConfigurations.fabro-vm.pkgs.opencode-pinned` (a failure
   here aborts before the switch and leaves the current generation running).

## Verification

In-guest (SSH via `ssh -F ~/.local/state/lima/fabro/ssh.config lima-fabro`):

- `systemctl status opencode` → active; `journalctl -u opencode -n 100` clean.
- `curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4096/` → 200 or
  401; `curl -fsS http://127.0.0.1:4096/doc` if unauthenticated.
- `tailscale serve status` shows three services incl. `svc:opencode`.
- `sudo -u` is not possible for a dynamic user; validate the key via
  `sudo ssh-keygen -l -f /var/lib/opencode/.ssh/opencode_signing_key` and the
  gh-extension symlink via `sudo ls -l /var/lib/opencode/share/gh/extensions/`.

Through the web console (`https://opencode.tuxedo-musical.ts.net`, basic auth
`opencode` / server password), open a session in `workspace/` and run:

- `gh auth status` (token present), `gh stack --help` (extension resolves),
- `gh repo clone <repo>` and a `git commit` → shows **Verified** on GitHub,
- a prompt against `opencode-litellm/deepseek-v4.1-flash`
  (validates provider + dynamic session headers end-to-end),
- `nix build` of a small derivation.

## Risks and fallbacks

- **`opencode-pinned` on aarch64-linux** (first build of the fork's packaging
  for linux-arm64): if the fork's per-platform node_modules hash is missing,
  the build fails before activation (current generation stays up). Fallback:
  pin nixpkgs `unstable.opencode` or file the gap upstream. Build it early.
- **`serve` serving the web UI**: v1 documents the UI on the server; if the
  root is API-only, switch ExecStart to `opencode web` (watch for a
  browser-open attempt; it should degrade harmlessly without `xdg-open`).
- **Nested `StateDirectory`** requires systemd ≥256 (26.05 is fine). Fallback:
  `WorkingDirectory=/var/lib/opencode` + `sh -c 'cd …/workspace && exec …'`.
- **Sync script change**: low risk; the one-line-per-key invariant is
  preserved. Validate with the round-trip command above.
- **Tailscale ordering**: `tailscale serve --service=svc:opencode` fails until
  the console service exists; the unit retries on failure.
- **Resources**: the VM has 10 vCPU / 8 GiB / 60 GiB, shared with litellm,
  fabro, and the podman container engine. Heavy parallel builds may contend;
  bump Lima memory later if needed.
- **Workspace volatility**: guest-local, lost on VM recreation; GitHub is the
  source of truth. The fabro state share is unaffected.

## Out of scope / follow-ups

- Porting plugins: `session-compaction.ts`, `subagent-context-budget.ts`
  (both viable follow-ups — copy the `.ts` files and their env vars), and
  `rtk.ts` / `zellij-attention.ts` (mac/TUI-specific, do not port).
- `github-native-stacks` skill (MCP-dependent).
- mcpproxy / AgentMemory / git-mcp on the guest (deliberately absent; fabro's
  guest-eval asserts forbid mcpproxy).
- Container-engine (podman) socket access for the opencode user;
  trusted-users relaxation for `nix`
  per-invocation options; direct OpenCode Go/Zen provider (declined — litellm
  only).

## Implementation conventions

- Use the git-mcp server for git operations (the agent sandbox denies the
  `git` CLI); pass an explicit absolute `path` on every call. Do not commit,
  amend, push, or deploy unless the user asks.
- New `.nix` files must be nixfmt-rfc-style formatted (prek hooks rewrite
  otherwise); keep statix/deadnix clean.
- The guest's own shell (cidata user) uses real `git`/`gh` — that is expected
  and unrelated to the sandbox.
- Current branch is `main`; the previous fabro-vm stack is merged. One commit
  for this change set (plus the re-encrypted store) is the intended shape,
  subject to the user's direction.
