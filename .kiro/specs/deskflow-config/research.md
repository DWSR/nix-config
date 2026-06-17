# Gap Analysis: deskflow-config

## Analysis Summary
- Brownfield with strong precedents: the module is new, but every mechanism it
  needs already exists in-repo.
- Deskflow stores settings in an INI file (`~/Library/Deskflow/Deskflow.conf`),
  not the macOS defaults domain; the server screen layout is a separate bespoke
  text format. See `memories/2026-06-16-deskflow-settings-model.md` and upstream
  `src/lib/common/Settings.{h,cpp}` + `docs/user/configuration.md`.
- Net-new work: the role-aware options schema, the server-layout text renderer,
  and Deskflow-specific flake checks. Everything else reuses an existing pattern.
- Effort M, Risk Low-Medium (main risks: QSettings/INI compatibility details and
  server-layout renderer correctness).

## Current State Investigation

### Existing assets (reusable)
- HM modules with `home.<feature>` options live in `home-manager/common/*.nix`;
  `home-manager/common/default.nix` `imports` is where a new module registers.
- Read-only self-writing-config precedent: `configurations/shopify/home-manager/tec.nix`
  uses `home.file.<rel>.text` to symlink a store file so the app's own writes fail
  by design. This is exactly the mechanism the brief mandates for `Deskflow.conf`.
- INI rendering precedent: `configurations/shopify/home-manager/dev.nix:36`
  `lib.generators.toINI { mkKeyValue = lib.generators.mkKeyValueDefault {} " = "; } {...}`.
  TOML precedent: `wish.nix` (`pkgs.formats.toml`).
- Writable-config alternative (NOT chosen): atuin activation-copy in
  `home-manager/common/zsh.nix:55-61`.
- Flake checks: `flake.nix` `checks.<system>` (aarch64-darwin). House pattern: eval
  `self.darwinConfigurations.<host>.config.home-manager.users.brandonmcnama`, force
  `pkgs.lib.assertMsg` assertions, emit a report via a trivial `pkgs.runCommand`.
  Render checks import the renderer directly and assert with `pkgs.lib.hasInfix`
  (see `hammerspoon-caffeinate-wiring`, `flake.nix:784`).
- Cask already declared in `configurations/common-darwin/default.nix`
  (`homebrew.casks` includes `"deskflow"`) — out of scope to change.

### Conventions
- Single HM user `brandonmcnama`; hosts `ShopifyLaptop`, `Brandons-MacBook-Pro`.
- Per-host wiring: `configurations/shopify/default.nix` does
  `home-manager.users.${username} = import ./home-manager`, and
  `configurations/shopify/home-manager/default.nix` imports sibling modules. Same
  shape under `configurations/personal/`.
- Pre-commit: nixfmt-rfc-style; no hardcoded `/Users/` (use
  `config.home.homeDirectory` / `${username}`); no `/tmp`.

### Integration surfaces (Deskflow contract)
- INI sections `[core] [client] [server] [security] [gui] [log] [daemon]`.
- `core/coreMode`: `1` = client, `2` = server.
- Server external layout: `server/externalConfig=true` +
  `server/externalConfigFile=<path>`; layout text format is
  `section: screens|links|aliases|options … end` (names must be defined before use).
- On launch Deskflow purges empty-valued and non-allowlisted keys; a read-only
  file means runtime/GUI writes silently no-op (acceptable per the brief).

## Requirement-to-Asset Map
| Req | Need | Existing asset | Gap |
|:--|:--|:--|:--|
| R1 | enable + role enum | `home.<feature>` module pattern | Missing: new module |
| R2 | curated INI render | `lib.generators.toINI` (dev.nix) | Constraint: `=` separator, omit-empty, bool `true/false` |
| R3 | client subset + TODO placeholder | toINI + options | Missing: client options; Constraint: comment-vs-warning placeholder |
| R4 | server layout text | none | Missing: bespoke renderer; Constraint: name-before-use validation |
| R5 | read-only delivery, parent writable | `tec.nix` `home.file` symlink | Reuse; Unknown: leaf-only linking keeps `~/Library/Deskflow/` writable |
| R6 | ShopifyLaptop client wiring | `configurations/shopify/home-manager` | Missing: enable entry |
| R7 | flake checks | `flake.nix` checks pattern | Missing: deskflow checks |

## Implementation Approach Options
- **Option B — new component (recommended)**: new `home-manager/common/deskflow.nix`
  (options + renderers) registered in `home-manager/common/default.nix`; client
  enablement in `configurations/shopify/home-manager/` (new `deskflow.nix` or an
  entry in its `default.nix`); new flake checks. Clean separation; mirrors the
  hammerspoon module. ✅ isolated/testable ❌ a few new files.
- **Option A — extend an existing common module**: rejected; distinct domain, no
  natural host module, would bloat an unrelated file.
- **Option C — hybrid (extract a shared INI helper)**: only worthwhile if a second
  consumer appears; over-engineered for one module today.

## Effort & Risk
- **Effort: M** — one module + two renderers (INI + server-layout) + flake checks +
  host wiring; all patterns are known in-repo.
- **Risk: Low-Medium** — Low for module/wiring/read-only delivery (direct
  precedents). Medium for (a) QSettings IniFormat compatibility of `toINI` output
  and (b) server-layout renderer correctness/validation.

## Research Needed (carry to design)
1. QSettings IniFormat read-compat of `lib.generators.toINI` (verified against Qt 6
   docs): use `=` (no spaces) and `[section]` headers. Numbers are read back as
   `QString` and recovered via `toInt`/`toDouble`, so ints/floats render bare and
   bools as `true`/`false`. CRITICAL: an unquoted value containing a comma is
   parsed by QSettings as a `QStringList`, so `client/remoteHost` with a
   comma-separated host list would be misread (its `toString()` yields empty). The
   renderer must be type-aware: double-quote string values (at minimum any
   containing a comma), leave numbers/bools bare. This rules out the default
   `mkValueStringDefault`; a custom value stringifier is required.
2. Unset-client-remoteHost placeholder: confirm QSettings ignores `;`/`#` comment
   lines on read (so a comment placeholder is safe) vs. a non-fatal build warning;
   pick one. Must stay non-fatal (operator chose a TODO placeholder).
3. `home.file` leaf-vs-dir linking: confirm `home.file."Library/Deskflow/Deskflow.conf"`
   creates `~/Library/Deskflow/` as a real dir (leaf symlink only) so the TLS
   trust store and logs remain writable.
4. Server-layout renderer: define options→text mapping (screens/links/aliases/
   options), name-before-use ordering, link direction/range syntax, and validation
   depth. In 1.26 only `externalConfig`/`externalConfigFile` are first-class
   `[server]` keys; tuning lives in `internalConfig` and is out of scope.
5. Omit-when-default policy: decide whether shared keys equal to Deskflow defaults
   are written or omitted (affects churn and the "only curated keys" assertion).

## Recommendations for design
- Adopt Option B. Expose `home.deskflow.{enable, role, computerName, port, tls.*,
  log.*, gui.*, client.*, server.*}`; render `Deskflow.conf` via `toINI` (`=`
  separator, omit-empty) and the server layout via a dedicated text builder with
  name validation; deliver both read-only via `home.file`; add a
  `deskflow-host-wiring` check plus a render check (client + server fixture);
  enable the client role on ShopifyLaptop with an empty `remoteHost` placeholder.
- Finalize research items 1-5 during design.

---

## Design Synthesis (decisions, post design-validation)
- **Adopt Option B**: `home-manager/common/deskflow/{default.nix,render.nix}` (pure
  renderer + module split, mirroring hammerspoon-keybindings).
- **Item 1 resolved**: type-aware value renderer — strings double-quoted (comma
  safety), ints/bools bare. Custom `mkValueString`, not `mkValueStringDefault`.
- **Item 2 resolved**: unset client `remoteHost` -> omit key + `;`-comment TODO
  (non-fatal). QSettings ignores `;` lines on read.
- **Item 3 resolved**: `home.file` links the leaf only; `~/Library/Deskflow/` stays
  a real writable dir (TLS/logs unaffected) — same as `tec.nix`.
- **Item 4 resolved**: typed `server.{screens,links,aliases,options}`; screens
  render before links/aliases; name-before-use validated. `externalConfigFile` is
  derived (computed under `~/Library/Deskflow/`), not operator-settable.
- **Item 5 resolved**: write ALL managed keys explicitly (reproducible); omit only
  null/empty-by-design keys (`computerName`, `log.file`, empty `remoteHost`).
- **Validation mechanism (design-validation Issue 1)**: enforce via `lib.assertMsg`/
  `throw` gating the rendered text, NOT home-manager `assertions` (forcing
  `config.assertions` is fragile here — memory `2026-05-22-home-manager-assertion-forcing.md`).
  Flake checks force `.text` so 1.3/4.4/4.5 are exercised in CI.
- **Open risk (Issue 2)**: server-role runtime (read-only external config load) is
  unverifiable in CI and unexercised; manual one-time check when a server host is
  first enabled.

---

## TLS certificate + trust store (added for the certificate-management requirement)

### Trust-store format (verified, `src/lib/net/{FingerprintDatabase,Fingerprint}.{h,cpp}` @ v1.26.0)
- Trust files are TEXT, read by `FingerprintDatabase::read(path)` / `readStream`:
  `~/Library/Deskflow/tls/trusted-servers` and `.../trusted-clients`
  (`Settings::tlsTrustedServersDb()` / `tlsTrustedClientsDb()` = `<settingsPath>/tls/...`).
- Line format: `v2:<type>:<lowerhex>`, `type` ∈ {`sha256`,`sha1`} (`Fingerprint::toDbLine`).
  SHA-256 = 32 bytes = 64 hex; SHA-1 = 20 bytes = 40 hex. Empty/invalid lines skipped.
  So declarative pre-seeding = render `v2:sha256:<hex>` lines, one per trusted peer.
- Role mapping: a CLIENT verifies servers against `trusted-servers`; a SERVER verifies
  clients against `trusted-clients` (`SecureSocket::verifyCertFingerprint`,
  `MainWindow::trustedFingerprintDatabase`). So a host writes the file for the peers
  IT trusts, chosen by its own role.
- Fingerprints are public hashes (not secret) -> safe to render via `home.file.text`.
- Tradeoff: a read-only trust file means Deskflow cannot append interactively; with
  `checkPeerFingerprints=true` only pre-seeded peers connect. Render the file ONLY
  when fingerprints are provided; otherwise leave it unmanaged/writable.

### Certificate (identity)
- `security/certificate` (default `<tlsDir>/deskflow.pem`) is a PEM holding BOTH the
  cert and its private key (OpenSSL loads cert + key from the same file). The
  advertised fingerprint is SHA-256 of the cert. `security/keySize` ∈ {2048,4096}
  is used only when Deskflow self-generates; pin it to match a supplied cert.
- Generate once: `openssl req -x509 -nodes -newkey rsa:2048 -keyout k.pem -out c.pem
  -days N -subj "/CN=Deskflow"; cat c.pem k.pem > deskflow.pem`. Fingerprint:
  `openssl x509 -in c.pem -noout -fingerprint -sha256`.

### sops-nix integration (darwin) — see memory `2026-05-11-sops-nix-darwin-module-internals.md`
- The HM sops module is broken on darwin (Mic92/sops-nix#801); declare the secret at
  the SYSTEM level: `sops.secrets."deskflow-cert" = { owner = <username>; mode = "0400"; }`.
  Decrypts to `/run/secrets/deskflow-cert` (RAM disk). Owner must be the user so the
  user-run Deskflow can read it.
- Bridge into HM: home-manager passes `osConfig` to HM modules under nix-darwin, so the
  host enablement sets `home.deskflow.tls.certificateFile = osConfig.sops.secrets."deskflow-cert".path`.
  The HM module stays decoupled: it takes an absolute path, never the key material.

## Design Synthesis (certificate management)
- **Cert decoupling**: HM `tls.certificateFile : nullOr str` (absolute path) -> pin
  `security/certificate`; null -> omit (Deskflow self-generates). sops secret +
  `osConfig` bridge live in host wiring, not the module (keeps the module pure and
  off the secret path).
- **keySize**: `tls.keySize : enum [2048 4096] = 2048` -> `security/keySize`.
- **Trust**: `tls.trustedFingerprints : listOf str` (sha256/sha1 hex, case-insensitive,
  colons tolerated). Rendered read-only to the role's trust file as `v2:sha256:<hex>`;
  empty -> file unmanaged. `lib.assertMsg` validates hex length (64 or 40) per entry.
- **No private key in store**: certificate is referenced by path only; only the public
  fingerprint file and the INI go through `home.file`.
