# Design Document

## Overview

This feature delivers a declarative, always-on omlx inference server to the
personal nix-darwin host (`Brandons-MacBook-Pro`). A personal-only Home Manager
module declares `omlx serve` as a launchd user agent so the server starts at
login, restarts on crash, and stays reachable by opencode's `provider.omlx` at
`http://localhost:8000/v1`.

**Users**: the personal host operator, who currently must start the omlx server
by hand after every reboot.

**Impact**: replaces the manual/brew-era server lifecycle with a declarative
launchd agent. The omlx package itself (`pkgs.omlx`) is unchanged.

### Goals
- Declarative launchd user agent for `omlx serve` with login auto-start and
  crash restart.
- Host/port tunables defaulting to the endpoint opencode already targets.
- Log capture under `~/Library/Logs/omlx/` with the directory auto-created.
- Render tests that pin the generated agent configuration.

### Non-Goals
- Model provisioning, LAN host binding, API-key management.
- Swift app integration or shared-host / `home-manager/common/` wiring.
- Prewarm, health-check, or watchdog hooks beyond KeepAlive.

## Boundary Commitments

### This Spec Owns
- The personal Home Manager module `configurations/personal/home-manager/omlx.nix`
  and its option namespace `home.omlx`.
- The `launchd.agents.omlx` user agent and its `home.activation.omlxLogDir`
  log-directory snippet.
- The personal-host import wiring and the standalone render test.

### Out of Boundary
- The `pkgs.omlx` package (owned by `overlays/omlx`).
- opencode's `provider.omlx` and its keychain API-key flow.
- The generic `launchd-activation` override and HM's launchd module internals.

### Allowed Dependencies
- `pkgs.omlx` (overlay) — provides the server binary.
- Home Manager `launchd.agents` — provides the user-agent mechanism.
- `flake.overlays.omlx` in the test — provides `pkgs.omlx` to the standalone
  render test; requires exposing `omlx` in the `overlays/default.nix` output.

### Revalidation Triggers
- `pkgs.omlx` binary path or package name changes.
- opencode provider endpoint (host/port) changes.
- HM launchd agent option shape changes.

## Architecture

No new architectural seams. The module is a thin declarative wrapper over two
existing subsystems: the overlay-provided `pkgs.omlx` package and Home Manager's
`launchd.agents` user-agent mechanism. It adopts the repo's established launchd
agent pattern (`home-manager/common/agentmemory.nix:239-267`) and log-directory
activation pattern (`home-manager/mcp/default.nix:1070-1075`).

**Existing patterns preserved**: `launchd.agents.<name>` with `Label`,
`ProgramArguments`, `RunAtLoad`, `KeepAlive`, `Standard{Out,Error}Path`; a
`home.activation.<name>LogDir` mkdir gated after `writeBoundary`; a standalone
`node --test` HM render test under `tests/<feature>/`.

**New components**: one module file. No shared library extraction — the module
has a single consumer (the personal host) and no reusable seam beyond the option
namespace.

## Technology Stack

| Layer | Choice / Version | Role in Feature | Notes |
|-------|------------------|-----------------|-------|
| Config | Nix (Home Manager module) | Declares options + launchd agent | `options.home.omlx`, `launchd.agents.omlx` |
| Package | `pkgs.omlx` (overlay, uv2nix) | Server binary | `${cfg.package}/bin/omlx serve` |
| Runtime | macOS launchd (user agent) | Supervision | `RunAtLoad` + `KeepAlive` |
| Test | Node `node:test` | Render tests | standalone `homeManagerConfiguration` |

## File Structure Plan

### Directory Structure
```
configurations/personal/home-manager/
  omlx.nix                 # NEW: home.omlx options + launchd.agents.omlx + log-dir activation
tests/omlx-service/
  helpers.js               # NEW: nixEvalJson / nixEvalFailure / repoRoot helpers
  hm-render.test.js        # NEW: standalone HM render test
  package.json             # NEW: { "main": "hm-render.test.js" }
```

### Modified Files
- `overlays/default.nix` — expose the `omlx` overlay in the output attrset so
  `flake.overlays.omlx` resolves for the standalone render test.
- `configurations/personal/home-manager/default.nix` — add `./omlx.nix` to the
  personal imports list and set `home.omlx.enable = true;`.
- `flake.nix` — add an `omlx-service` check under `checks` mirroring the
  `personal-tailscale-service` runCommand (copy source, `node --test
  tests/omlx-service/`).

## System Flows

Not applicable — single declarative module, no multi-party flow.

## Requirements Traceability

| Requirement | Summary | Components | Interfaces | Flows |
|-------------|---------|------------|------------|-------|
| 1.1 | Login auto-start | launchd agent | `launchd.agents.omlx.config.RunAtLoad` | — |
| 1.2 | Restart on crash | launchd agent | `launchd.agents.omlx.config.KeepAlive` | — |
| 1.3 | Runs as user | launchd agent | `launchd.agents.*` (user agent) | — |
| 2.1 | Default host | module option | `home.omlx.host` default `127.0.0.1` | — |
| 2.2 | Default port | module option | `home.omlx.port` default `8000` | — |
| 2.3 | Custom host/port | module option | `home.omlx.host` / `home.omlx.port` | — |
| 2.4 | Extra args | module option | `home.omlx.extraArgs` | — |
| 3.1 | stdout log | launchd agent | `StandardOutPath` | — |
| 3.2 | stderr log | launchd agent | `StandardErrorPath` | — |
| 3.3 | mkdir log dir | activation | `home.activation.omlxLogDir` | — |
| 4.1 | Enabled registers | module gating | `lib.mkIf cfg.enable` | — |
| 4.2 | Disabled no register | module gating | `lib.mkIf cfg.enable` (omit) | — |
| 4.3 | Nix pkg default | module option | `home.omlx.package` default `pkgs.omlx` | — |
| 5.1 | Default render test | test | `tests/omlx-service/hm-render.test.js` | — |
| 5.2 | Custom render test | test | `tests/omlx-service/hm-render.test.js` | — |
| 5.3 | Disabled render test | test | `tests/omlx-service/hm-render.test.js` | — |

## Components and Interfaces

### Configuration Module

#### `configurations/personal/home-manager/omlx.nix`

| Field | Detail |
|-------|--------|
| Intent | Declare the omlx `serve` launchd user agent from `home.omlx` options |
| Requirements | 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3 |

**Responsibilities & Constraints**
- Expose `options.home.omlx`: `enable`, `package`, `host`, `port`, `extraArgs`.
- Emit `launchd.agents.omlx` and `home.activation.omlxLogDir` only when
  `cfg.enable` is true.
- Run `omlx serve` as a foreground process (launchd supervises it).

**Dependencies**
- Inbound: `pkgs.omlx` (overlay) — server binary (P0).
- Outbound: HM `launchd.agents` — user-agent supervision (P0).
- External: macOS launchd — process supervision (P0).

**Contracts**: State [x] — the module owns the agent's declarative state.

##### State Management
- State model: the rendered `launchd.agents.omlx.config` plist fields and the
  log-dir activation command.
- Persistence & consistency: launchd writes the plist to
  `~/Library/LaunchAgents/`; the module regenerates it on every HM switch.
- Concurrency strategy: single agent per user; no cross-host state.

**Rendered agent contract**
```nix
launchd.agents.omlx = {
  enable = true;
  config = {
    Label = "dev.dwsr.omlx";
    ProgramArguments = [
      "${cfg.package}/bin/omlx" "serve"
      "--host" cfg.host "--port" (toString cfg.port)
    ] ++ cfg.extraArgs;
    RunAtLoad = true;
    KeepAlive = true;
    StandardOutPath = "${config.home.homeDirectory}/Library/Logs/omlx/omlx.log";
    StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/omlx/omlx.error.log";
  };
};
```

**Implementation Notes**
- Integration: `--host`/`--port` are appended explicitly so the rendered
  `ProgramArguments` are self-contained; `extraArgs` follows them.
- Validation: `port` uses `lib.types.port`; `host` is a string.
- Risks: a persistent port-8000 conflict yields a KeepAlive restart loop; the
  agent owns port 8000.

### Render Test

#### `tests/omlx-service/hm-render.test.js`

| Field | Detail |
|-------|--------|
| Intent | Pin the generated launchd agent and log-dir activation |
| Requirements | 5.1, 5.2, 5.3 |

**Responsibilities & Constraints**
- Standalone `homeManagerConfiguration` render using `flake.overlays.omlx` for
  `pkgs.omlx`.
- Assert default, custom, and disabled variants.

**Dependencies**
- Inbound: `flake.inputs.home-manager`, `flake.overlays.omlx` (P0).
- External: `node --test` (P0).

**Implementation Notes**
- Integration: mirrors `tests/personal-tailscale-service/hm-render.test.js`.
- Validation: assert `ProgramArguments`, `RunAtLoad`, `KeepAlive`, log paths.
- Risks: overlay eval cost; keep assertions structural.

## Error Handling

### Error Strategy
- Port conflict: `omlx serve` pre-binds the socket before model preload and
  exits on conflict; `KeepAlive` restarts it. Documented as a restart-loop risk
  when port 8000 is held by another process.

### Error Categories and Responses
- **Port already in use**: server exits fast; launchd restarts (KeepAlive). The
  operator frees port 8000 or disables the module.
- **Missing log directory**: `home.activation.omlxLogDir` creates it before the
  agent starts.
- **Disabled module**: no agent is registered; an existing agent from a prior
  enabled switch is left to the operator to unload (out of scope to auto-remove).

### Monitoring
- Server logs: `omlx serve` writes `{base_path}/logs/server.log`; launchd
  stdout/stderr land in `~/Library/Logs/omlx/`.

## Testing Strategy

### Unit Tests
- Default variant: agent registered with host `127.0.0.1`, port `8000`,
  `RunAtLoad` and `KeepAlive` true, log paths under `~/Library/Logs/omlx/`.
- Custom variant: host/port/extraArgs reflected in `ProgramArguments`.
- Disabled variant: no `launchd.agents.omlx` registered.
- Log-dir activation: `home.activation.omlxLogDir` present and contains `mkdir -p`.

### Integration Tests
- Full personal-config render (via `nix flake check` darwin eval) confirms the
  module imports cleanly alongside the existing personal modules.

## Security Considerations
- The server binds `127.0.0.1` by default (loopback only), so no API key is
  required for the localhost-bound opencode provider.
- `extraArgs` allows a future LAN bind; that is an explicit operator choice and
  remains out of scope to guard.
