# Brief: personal-tailscale-service

## Problem
The personal laptop needs a declarative way to expose local services over the tailnet without replacing the installed macOS Tailscale app with a Nix-managed `tailscaled` daemon. Hand-configured `tailscale serve` state is easy to lose track of and is not visible in the Nix configuration.

## Current State
`Brandons-MacBook-Pro` is the personal nix-darwin host and already installs Tailscale through the macOS app path. The repo has Home Manager module patterns for declarative options, activation scripts, launchd agents, and render tests, but no Tailscale Serve module or spec.

## Desired Outcome
The personal laptop can declare tailnet-private Tailscale Serve port/localhost proxy entries in Home Manager configuration. A Home Manager switch converges those declarations by invoking the existing macOS Tailscale app CLI in background Serve mode. The first implementation provides the reusable module and leaves concrete personal service entries empty.

## Approach
Create a reusable Home Manager module with an option namespace for Tailscale Serve exposure. The module renders an activation convergence script that runs `TAILSCALE_BE_CLI=1 /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg ...` by default, with the CLI path configurable for other macOS variants.

This approach keeps Tailscale ownership with the macOS app, makes the desired Serve state visible in Nix, and avoids a long-running launchd wrapper unless later requirements prove that a RunAtLoad reapply hook is necessary.

## Scope
- **In**: Reusable Home Manager option surface for tailnet-private Serve entries, activation-time convergence for declared entries, configurable CLI path, personal-host dormant render coverage, render tests for generated activation/config behavior.
- **Out**: Installing or managing `tailscaled`, replacing the macOS app, Tailscale Funnel/public internet exposure, file or directory serving, automatic first-run Serve/HTTPS consent flows.

## Boundary Candidates
- Home Manager module API and validation for declared Serve entries.
- Personal host evaluation that has the module available without initial service entries.
- Activation convergence script that translates declarations to `tailscale serve --bg` commands.
- Tests that assert option rendering and generated command shape.

## Out of Boundary
- Funnel support and public exposure controls.
- Serving static files or directories through the Mac App Store app.
- Managing Tailscale login state, tailnet ACLs, certificates, or device authorization.
- Imperatively clearing unmanaged Serve state beyond commands needed for declared entries.

## Upstream / Downstream
- **Upstream**: Tailscale.app installed on macOS, Tailscale Serve prerequisites enabled in the tailnet, Home Manager activation, existing nix-darwin personal host wiring.
- **Downstream**: Initial personal service declarations, additional personal service declarations, possible future RunAtLoad reapply hook, possible future Funnel/public exposure spec.

## Existing Spec Touchpoints
- **Extends**: None.
- **Adjacent**: `sqlite-backup` for reusable Home Manager options plus generated runtime behavior; `mcpproxy-migration` for launchd-managed local service patterns; personal Home Manager modules under `configurations/personal/home-manager/`.

## Constraints
Only tailnet-private `tailscale serve` is in scope. The first implementation targets port/localhost proxy entries because the Mac App Store Tailscale app is sandboxed and cannot serve files or directories. Noninteractive activation assumes any first-run Tailscale Serve/HTTPS consent has already been completed outside the Home Manager switch.
