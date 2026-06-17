# Brief: deskflow-config

## Problem
Deskflow (the keyboard/mouse-sharing KVM) is installed declaratively as a Homebrew
cask, but its settings are set interactively in the GUI and stored in a mutable
INI file the app rewrites on every launch. There is no declarative, reviewable,
reproducible way to define a host's Deskflow client/server configuration in
nix-config.

## Current State
- The `deskflow` cask is declared in `configurations/common-darwin/default.nix`
  (tap `deskflow/homebrew-tap`), version 1.26.0, installed on both hosts.
- Settings live in `~/Library/Deskflow/Deskflow.conf` (Qt `QSettings` IniFormat),
  NOT the macOS defaults domain. `~/Library/Preferences/org.deskflow.deskflow.plist`
  holds only the menubar icon position, so the
  `system.defaults.CustomUserPreferences` / `targets.darwin.defaults` pattern in
  `slack.nix` does NOT control Deskflow config.
- On launch Deskflow purges non-allowlisted and empty keys and writes runtime
  state (`cleanSettings`, `setupComputerName`); it gates writes on `isWritable()`.
- No Deskflow Home Manager module exists. Closest analog: `hammerspoon-keybindings`
  (HM module rendering a read-only config file + flake checks); the atuin
  activation-copy in `zsh.nix` is the writable-config alternative.

## Desired Outcome
A Home Manager module exposes a typed options schema for Deskflow supporting both
client and server roles, renders a curated subset of settings into a read-only
`~/Library/Deskflow/Deskflow.conf`, and for the server role renders an external
classic-Synergy screen-layout file referenced via `server/externalConfig`.
ShopifyLaptop is wired as a client. Both `darwinConfigurations` evaluate and flake
checks validate the rendered output.

## Approach
New `home-manager/common/deskflow.nix` module, `enable`-gated and role-aware
(`client` | `server`), imported in `home-manager/common/default.nix`.
- Render `Deskflow.conf` from a curated key set with a Nix INI generator; install
  read-only via `home.file."Library/Deskflow/Deskflow.conf".text`. The parent dir
  stays a real directory, so the TLS trust store and logs remain writable.
- Client role: `core/coreMode=1`, `client/remoteHost` (empty TODO-placeholder
  default), scroll + `languageSync` prefs.
- Server role: `core/coreMode=2`, `server/externalConfig=true` +
  `server/externalConfigFile=<path>`; render the screen layout
  (screens/links/aliases/options) from options via a custom text renderer; install
  read-only. The opaque GUI-managed `internalConfig` blob is deliberately avoided.
- Shared: computerName (default omit -> hostname), port (24800), TLS (on +
  fingerprint check), logging, GUI behavior (startCoreWithGui, closeToTray,
  autoHide).
- Eval-time assertions + flake checks validate role/key consistency and rendered
  output against fixtures.
- Concrete wiring: enable the client role on ShopifyLaptop with `remoteHost` left
  as a TODO placeholder. The server role is fully supported; assigning it to a host
  (and its physical layout values) is left to the operator.

## Scope
- **In**: the HM module + options schema; both roles; the curated key set;
  read-only `Deskflow.conf` rendering; read-only external server-layout rendering;
  TLS certificate-path pinning + key size and read-only trusted-peer fingerprint
  pre-seeding; ShopifyLaptop client wiring; eval assertions; flake checks with
  fixtures; module documentation of the read-only tradeoff.
- **Out**: the cask install (already in common-darwin); generating or encrypting
  the certificate material and the sops/age key lifecycle; runtime interactive
  trust additions and certificate auto-generation when a managed cert is supplied;
  managing the GUI `internalConfig` blob; the full settings surface (curated subset
  only); Linux/Windows paths; choosing a concrete server host or its real screen
  coordinates beyond schema + example; launchd/service-mode autostart of the core;
  migrating existing manual config.

## Boundary Candidates
- Options schema: `enable`, `role`, shared + client + server sub-options.
- `Deskflow.conf` INI rendering (curated keys).
- External server-layout text rendering (screens/links/aliases/options).
- Read-only file installation and `~/Library/Deskflow/` path layout.
- Host wiring (ShopifyLaptop as client).
- Verification: eval assertions + config-render flake checks.

## Out of Boundary
- The Homebrew cask declaration (stays in `common-darwin`).
- Certificate key-material generation/encryption and the sops/age key lifecycle.
- Runtime interactive trust additions (when the trust store is managed read-only).
- GUI-managed `internalConfig` screen layout.
- Non-macOS platforms.
- Core daemon / service-mode process management and autostart.

## Upstream / Downstream
- **Upstream**: the `deskflow` cask in `common-darwin`; home-manager `home.file`;
  both `darwinConfigurations`; the `home.<feature>` HM options namespace; the
  flake-checks harness; sops-nix (host-level) for the decrypted certificate path.
- **Downstream**: future server-host enablement; expansion of the curated key
  set; potential launchd autostart work.

## Existing Spec Touchpoints
- **Extends**: none.
- **Adjacent**: `hammerspoon-keybindings` (structural template: HM module ->
  read-only rendered config + flake checks; not a dependency). The `slack.nix`
  `CustomUserPreferences` pattern is explicitly NOT applicable to Deskflow.

## Constraints
- macOS / aarch64-darwin; Deskflow 1.26.0 (`QSettings` IniFormat; `cleanSettings`
  purge; `isWritable()` gating).
- Read-only store symlink chosen (prior decision): GUI edits and runtime
  persistence of curated keys will not save; acceptable. When trusted peers are
  pre-seeded, the trust file is delivered read-only too; otherwise it stays
  writable for interactive trust. The certificate is referenced by path
  (sops-nix-managed), never copied into the store.
- 1.26 nuance: server behaviors (lock-to-computer, switch delay, grid, protocol)
  live under `internalConfig` in 1.26; the external server text config is the
  stable declarative path, and only `externalConfig`/`externalConfigFile` are
  first-class `[server]` keys in this version.
- Pre-commit guards: nixfmt-rfc-style; no hardcoded `/Users/` (use `${username}` /
  `config.home.homeDirectory`); no `/tmp` paths.
- Curated subset only; do not pin volatile keys (`windowGeometry`,
  `shown*Message`) to avoid churn against the app's clean/upgrade passes.
- References: `memories/2026-06-16-deskflow-settings-model.md`; upstream
  `docs/user/configuration.md`, `src/lib/common/Settings.{h,cpp}`.
