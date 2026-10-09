# Brief: omlx-service

## Problem

The personal nix-darwin host runs the omlx inference server (`pkgs.omlx`, built
from source via uv2nix) and opencode's `provider.omlx` targets
`http://localhost:8000/v1`. Nothing keeps the server running: the old Homebrew
service (`omlx serve` via `brew services`) was removed with the brew path, so
after a reboot opencode's omlx provider is unreachable until the server is
started by hand.

## Current State

`pkgs.omlx` is installed in `configurations/personal/home-manager/default.nix`
(`home.packages`, line 43). `configurations/personal/home-manager/opencode.nix`
defines `provider.omlx` with `baseURL = "http://localhost:8000/v1"` and reads the
`omlx-api-key` keychain secret client-side. The repo has established launchd
user-agent patterns (`home-manager/common/agentmemory.nix:239-267`,
`home-manager/mcp/default.nix:1077-1121`) and a standalone HM-module render-test
pattern (`tests/personal-tailscale-service/hm-render.test.js`). No omlx service
module exists.

## Desired Outcome

A personal-only Home Manager module declares `omlx serve` as a launchd user
agent that auto-starts at login and restarts on crash. Defaults (host
127.0.0.1, port 8000) match opencode's provider. Service logs land under
`~/Library/Logs/omlx/`. Render tests assert the generated agent.

## Approach

Home Manager module with `options.home.omlx` (enable, package, port, host,
extraArgs). Emits `launchd.agents.omlx` with `Label "dev.dwsr.omlx"`,
`ProgramArguments [ "${cfg.package}/bin/omlx" "serve" ]` plus `--host`/`--port`
args, `RunAtLoad = true`, `KeepAlive = true`, `Standard{Out,Error}Path` under
`~/Library/Logs/omlx/`, and a `home.activation.omlxLogDir` mkdir. Wired through
the personal imports list at
`configurations/personal/home-manager/default.nix:22`.

Verified runtime behavior: `omlx serve` is a foreground uvicorn server (no
daemonize/reload), pre-binds the socket before model preload (fails fast on
port conflict), and needs no env or API key for a 127.0.0.1-bound instance.

## Scope

- **In**: option surface + launchd agent + log-dir activation + personal
  wiring + standalone render tests.
- **Out**: model provisioning, LAN host binding, API-key management, Swift app
  integration, port 8000 takeover by anything else.

## Boundary Candidates

- Personal module `configurations/personal/home-manager/omlx.nix` + import
  list entry.
- launchd agent + activation log-dir snippet.
- Standalone render test `tests/omlx-service/`.

## Out of Boundary

- `home-manager/common/` or shared-host wiring; only `Brandons-MacBook-Pro`
  consumes omlx.
- Server settings (`~/.omlx/settings.json`) beyond the CLI flags the module
  passes.
- Model download and management, auth configuration (the API key is a
  client-side opencode keychain env flow, not a service concern).
- Prewarm or health-check hooks beyond KeepAlive.

## Upstream / Downstream

- **Upstream**: `pkgs.omlx` (overlays/omlx uv2nix build), the
  `home.packages` entry, opencode `provider.omlx` at
  `configurations/personal/home-manager/opencode.nix:56-79`.
- **Downstream**: possible common-host promotion, a watchdog/health-check
  spec, tailscale-serve-style exposure of omlx to the tailnet.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `personal-tailscale-service` (HM module + render-test
  pattern), `sqlite-backup` and `agentmemory` (launchd agent conventions).

## Constraints

- Only the personal host, macOS user launchd agent.
- Port/host defaults must keep `http://localhost:8000/v1` working for
  opencode.
- KeepAlive=true means a persistent port-conflict yields a restart loop; the
  agent owns port 8000.
- Follow the repo's launchd agent shape and the tailscale render-test pattern.