# Implementation Plan

## Task Format Template

- [x] 1. Expose the omlx overlay
  - Add `omlx = omlx;` to the output attrset in `overlays/default.nix` so
    `flake.overlays.omlx` resolves.
  - Observable completion: `nix eval '.#overlays.omlx' --apply 'x: true'`
    returns `true` without error.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: overlays/default.nix_

- [x] 2. Create the omlx Home Manager module
  - Add `configurations/personal/home-manager/omlx.nix` with `options.home.omlx`
    (`enable`, `package`, `host`, `port`, `extraArgs`).
  - Emit `launchd.agents.omlx` (Label `dev.dwsr.omlx`, `ProgramArguments`
    `${cfg.package}/bin/omlx serve --host <host> --port <port>` + `extraArgs`,
    `RunAtLoad`, `KeepAlive`, `Standard{Out,Error}Path` under
    `~/Library/Logs/omlx/`) gated by `lib.mkIf cfg.enable`.
  - Add `home.activation.omlxLogDir` mkdir gated after `writeBoundary`.
  - Observable completion: the module evals and renders a `launchd.agents.omlx`
    with the expected plist fields when enabled, and no agent when disabled.
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_
  - _Boundary: configurations/personal/home-manager/omlx.nix_
  - _Depends: 1_

- [x] 3. Add the standalone render test
  - Add `tests/omlx-service/` (`helpers.js`, `hm-render.test.js`, `package.json`)
    mirroring `tests/personal-tailscale-service/`.
  - Source pkgs via `import flake.inputs.nixpkgs { system = ...; overlays = [
    flake.overlays.omlx ]; }`.
  - Assert default (host `127.0.0.1`, port `8000`, `RunAtLoad`/`KeepAlive` true,
    log paths), custom (host/port/extraArgs reflected), and disabled (no agent)
    variants, plus the log-dir activation.
  - Observable completion: `node --test tests/omlx-service/` passes.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: tests/omlx-service/_
  - _Depends: 1, 2_

- [ ] 4. Wire the module and test into the personal config and flake checks
  - Add `./omlx.nix` to the personal imports list and set
    `home.omlx.enable = true;` in `configurations/personal/home-manager/default.nix`.
  - Add an `omlx-service` check under `checks` in `flake.nix` mirroring the
    `personal-tailscale-service` runCommand.
  - Observable completion: `nix flake check` runs the omlx-service test and the
    personal config evals with the agent registered.
  - _Requirements: 4.1, 4.2, 5.1, 5.2, 5.3_
  - _Boundary: configurations/personal/home-manager/default.nix, flake.nix_
  - _Depends: 2, 3_
