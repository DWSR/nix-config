# Research & Design Decisions

## Summary
- **Feature**: `omlx-service`
- **Discovery Scope**: Simple Addition (new Home Manager module following existing
  launchd-agent and render-test patterns)
- **Key Findings**:
  - `omlx serve` is a foreground uvicorn server (no daemonize/reload), pre-binds
    its socket before model preload, and needs no env or API key for a
    127.0.0.1-bound instance — a clean fit for a supervised launchd agent.
  - The repo has an established launchd user-agent pattern
    (`home-manager/common/agentmemory.nix:239-267`) and log-dir activation
    pattern (`home-manager/mcp/default.nix:1070-1075`) to adopt.
  - The standalone HM render test (`tests/personal-tailscale-service/`) sources
    pkgs from raw nixpkgs; omlx needs the overlay, available as the
    self-contained `flake.overlays.omlx`.

## Research Log

### Service runtime behavior
- **Context**: confirm `omlx serve` is suitable for launchd supervision.
- **Sources**: installed package at
  `/nix/store/wy85g3dnvsdswqgdb6bhmidd1f8v6drs-omlx-env/.../omlx` (`cli.py`,
  `settings.py`, `config.py`); `omlx serve --help`.
- **Findings**:
  - `serve_command` builds a `uvicorn.Config("omlx.server:app", host, port)`
    and runs it in the foreground; no reload, no daemonize.
  - The socket is bound before model preload, so a port conflict exits fast.
  - Defaults: host `127.0.0.1`, port `8000`, models from `~/.omlx/models`.
  - No API key is required when `settings.auth.api_key` is unset.
- **Implications**: a `RunAtLoad` + `KeepAlive` launchd user agent supervises the
  server directly; no wrapper or prewarm is needed.

### launchd agent pattern
- **Context**: mirror the repo's existing user-agent structure.
- **Sources**: `home-manager/common/agentmemory.nix:239-267`,
  `home-manager/mcp/default.nix:1070-1121`.
- **Findings**: agents use `launchd.agents.<name>` with `Label`,
  `ProgramArguments`, `RunAtLoad`, `KeepAlive`, `Standard{Out,Error}Path`; log
  dirs are created by a `home.activation.<name>LogDir` mkdir gated after
  `writeBoundary` because launchd does not create parent directories.
- **Implications**: the omlx module adopts this shape verbatim; Label
  `dev.dwsr.omlx`; logs under `~/Library/Logs/omlx/`.

### Test pkgs source
- **Context**: the standalone render test needs `pkgs.omlx`.
- **Sources**: `tests/personal-tailscale-service/hm-render.test.js`,
  `overlays/default.nix`, `flake.nix:2317`.
- **Findings**: the tailscale test uses raw `flake.inputs.nixpkgs`. The omlx
  overlay is exposed as the self-contained `flake.overlays.omlx` (inputs bound
  at import), so the test can apply just that overlay to raw nixpkgs.
- **Implications**: test expr uses
  `import flake.inputs.nixpkgs { system = ...; overlays = [ flake.overlays.omlx ]; }`.

### Flake check wiring
- **Context**: wire the render test into `nix flake check`.
- **Sources**: `flake.nix:1804-1820` (personal-tailscale-service check).
- **Findings**: checks are `pkgs.runCommand` with `nativeBuildInputs = [ pkgs.nix
  pkgs.nodejs ]`, copying the source tree and running `node --test
  tests/<dir>/`.
- **Implications**: add an `omlx-service` check mirroring this pattern.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Personal HM module | `configurations/personal/home-manager/omlx.nix` + launchd agent | Matches host-specific nature (port 8000 + keychain); minimal wiring | Single host only | Chosen |
| Shared common module | `programs.omlx` under `home-manager/common/`, enabled on personal | Reusable if a second host adopts omlx | More plumbing; no second consumer today | Rejected |
| Activation-only | Background-converge `omlx serve` on HM switch | Simplest; no launchd | No keep-alive across reboot/crash | Rejected — wrong fit for a long-running server |

## Design Decisions

### Decision: Module namespace `options.home.omlx`
- **Context**: choose the option namespace for a host-specific service module.
- **Alternatives Considered**:
  1. `options.home.omlx`
  2. `options.programs.omlx`
- **Selected Approach**: `options.home.omlx`.
- **Rationale**: matches the personal/host-specific precedent
  (`options.home.tailscaleServe`, `options.home.sqliteBackup`); the module is
  personal-only.
- **Trade-offs**: none material.
- **Follow-up**: none.

### Decision: Hard-code `RunAtLoad` + `KeepAlive`
- **Context**: the agreed service lifecycle.
- **Alternatives Considered**:
  1. Hard-code both as the module's fixed behavior
  2. Expose `runAtLoad`/`keepAlive` options
- **Selected Approach**: hard-code both.
- **Rationale**: the agreed surface is port + host only; the lifecycle is a
  fixed requirement, not a tunable.
- **Trade-offs**: a future need for manual control would add options.
- **Follow-up**: revisit if a use case for manual control appears.

### Decision: Log path from `config.home.homeDirectory`
- **Context**: compute the launchd log directory without adding an option.
- **Alternatives Considered**:
  1. Derive `~/Library/Logs/omlx` from `config.home.homeDirectory`
  2. Add a `logDir` option
- **Selected Approach**: derive inline.
- **Rationale**: keeps the option surface minimal; the log location is an
  implementation detail of the agent, not a user-facing knob.
- **Trade-offs**: less flexible if a custom log path is ever needed.
- **Follow-up**: none.

### Decision: Test pkgs via `flake.overlays.omlx`
- **Context**: the standalone render test must resolve `pkgs.omlx`.
- **Alternatives Considered**:
  1. Apply `flake.overlays.omlx` to raw nixpkgs in the test expr
  2. Use the full darwin system pkgs
- **Selected Approach**: apply `flake.overlays.omlx`.
- **Rationale**: minimal, fast, and self-contained; matches the tailscale test's
  raw-nixpkgs pattern.
- **Trade-offs**: pays the omlx overlay eval cost on each test run.
- **Follow-up**: `overlays/default.nix` currently returns only `custom-packages`;
  expose `omlx = omlx;` in its output attrset so `flake.overlays.omlx` resolves.
  Confirm the overlay evals cleanly in the standalone context during
  implementation.

## Risks & Mitigations
- Port 8000 conflict → KeepAlive restart loop — document; agent owns port 8000;
  operator frees the port or disables the module.
- Overlay eval cost in the standalone test — keep assertions structural and the
  test focused.
- `extraArgs` enables a future LAN bind — document as an explicit operator
  choice; not guarded.

## References
- `home-manager/common/agentmemory.nix:239-267` — launchd agent shape.
- `home-manager/mcp/default.nix:1070-1075` — log-dir activation pattern.
- `tests/personal-tailscale-service/hm-render.test.js` — standalone render test.
- `flake.nix:1804-1820` — flake check wiring.
- `overlays/omlx/default.nix` — the omlx package this module consumes.
