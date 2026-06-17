# Implementation Plan

- [ ] 1. Deskflow renderer (settings, server layout, trust)
- [x] 1.1 Render the curated settings content
  - Emit grouped `[section]` INI text with a QSettings-safe value stringifier: string values double-quoted (so a comma-separated remote host is read as one string), integers/booleans/floats bare.
  - Map the role to client or server mode and emit the curated keys: network port, TLS enablement and peer-fingerprint checking, certificate path, key size, logging level/destination, GUI behavior, the client remote host, scroll inversion/scale, and language sync, and the server external-config keys.
  - Omit any managed value that is unset (no empty `key=` lines); omit the computer name when unset (so the hostname is used); omit the certificate path when unset.
  - Abort evaluation with a message naming the role option when the role is unset; when the client remote host is unset, emit a commented TODO placeholder instead of an empty key and still produce valid output.
  - Observable: a client snapshot renders `coreMode=1`, a quoted remote-host value when set (else a `;`-comment TODO and no remote-host key), `tlsEnabled=true`, and zero empty-valued lines; a server snapshot renders `coreMode=2` with the external-config keys; an enabled snapshot with no role aborts naming the role option.
  - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 8.1, 8.2, 8.6_
  - _Boundary: Deskflow renderer_

- [x] 1.2 Render the external server screen layout
  - Emit the textual server config with screens, links, aliases, and global options sections, rendering screens before links and aliases so every name is defined before use.
  - Abort evaluation with a clear message when the server role declares no screens, or when any link or alias references a screen that is not defined.
  - Observable: a server fixture renders ordered screen and link blocks containing each declared screen and link; a fixture whose link references an unknown screen aborts evaluation naming that screen.
  - _Requirements: 4.3, 4.4, 4.5_
  - _Boundary: Deskflow renderer_

- [ ] 1.3 Render the trusted-peer fingerprint list
  - Normalize each provided fingerprint (strip separators, lowercase) and emit one `v2:sha256:<hex>` line per peer; accept a SHA-1 (40 hex) value as `v2:sha1:<hex>`.
  - Abort evaluation identifying any entry that is not valid 64-hex or 40-hex; produce no trust output when the list is empty.
  - Observable: a fingerprint fixture renders the expected `v2:sha256:` lines; an invalid-length entry aborts evaluation; an empty list produces no trust text.
  - _Requirements: 8.3, 8.4, 8.5_
  - _Boundary: Deskflow renderer_

- [ ] 2. Options module and read-only delivery
- [ ] 2.1 Define the options schema
  - Expose the enable toggle (default off) and the role selector constrained to client or server, plus shared settings (computer name, port, TLS enablement and fingerprint checking, certificate path, key size constrained to 2048 or 4096, logging, GUI behavior), client settings (remote host, scroll inversion, scroll scale, language sync), and server settings (screens, links, aliases, options).
  - Default TLS enablement and fingerprint checking on; the role and key-size enums reject invalid values at evaluation.
  - Observable: evaluating the options shows the documented defaults (module disabled, TLS on); supplying a key size other than 2048/4096 or a role other than client/server is rejected at evaluation.
  - _Requirements: 1.1, 1.2, 2.5, 3.4, 8.2_
  - _Boundary: Deskflow module_

- [ ] 2.2 Deliver rendered files read-only and reference the certificate by path
  - When enabled, install the rendered settings content at Deskflow's user settings location read-only; for the server role also install the external layout file; when trusted peers are provided, install the role-appropriate trust file read-only.
  - Define the external-config path once and use it for both the rendered external-config setting and the layout file's delivery location (kept lock-step).
  - Set the certificate setting to the provided path only; never copy certificate or key material into the store; leave the settings directory otherwise writable for Deskflow's runtime files.
  - Observable: an enabled client config exposes a read-only settings file containing client mode; a server config additionally exposes the layout file at the path the settings reference; a trusted-peers fixture exposes a read-only trust file at the role-appropriate location; no delivered file carries certificate key material.
  - _Requirements: 1.4, 3.3, 5.1, 5.2, 5.3, 5.4, 8.1, 8.3, 8.5_
  - _Depends: 1.1, 1.2, 1.3_
  - _Boundary: Deskflow module_

- [ ] 3. Module registration and host enablement
- [ ] 3.1 Register the module for both hosts
  - Add the Deskflow module to the shared home-manager module set so its options exist on both hosts, disabled by default.
  - Ordering: the renderer and module files (tasks 1 and 2) must exist before this import resolves.
  - Observable: both host configurations evaluate with the Deskflow options present and the module disabled.
  - _Requirements: 1.1_
  - _Boundary: common home-manager module set_

- [ ] 3.2 Enable the client role on ShopifyLaptop
  - Add a ShopifyLaptop home-manager entry that enables the module in the client role and register that entry in the host's home-manager import set so it takes effect.
  - Leave the remote host, certificate path, and trusted fingerprints unset as TODO placeholders; keep the other host disabled unless it opts in.
  - Observable: ShopifyLaptop evaluates with the module enabled in client mode and the TODO placeholder present; the other host stays disabled; both host configurations evaluate without error.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 8.5, 8.6_
  - _Depends: 3.1_
  - _Boundary: ShopifyLaptop host wiring_

- [ ] 4. Verification checks
- [ ] 4.1 (P) Add the renderer check
  - Add a build check that exercises the renderer with client, server, trusted-fingerprint, and invalid-fingerprint fixtures.
  - Assert the client output has client mode and a quoted remote host; the server output has the expected ordered screens and links; the trust output has the expected `v2:sha256:` lines; no curated key renders empty; an invalid-fingerprint fixture fails the build.
  - Observable: the renderer check builds green on the valid fixtures and fails when a fixture is corrupted (empty curated value or malformed fingerprint).
  - _Requirements: 7.2, 7.3, 7.4_
  - _Depends: 1.1, 1.2, 1.3_
  - _Boundary: flake checks_

- [ ] 4.2 Add the host-wiring check
  - Add a build check that evaluates both hosts and asserts ShopifyLaptop has the module enabled in client mode with the expected curated keys present, and the other host disabled.
  - Observable: the host-wiring check builds green for the current wiring and fails if ShopifyLaptop's role or enablement regresses.
  - _Requirements: 6.1, 6.3, 7.1_
  - _Depends: 3.2_
  - _Boundary: flake checks_

## Implementation Notes
- 1.2: Req 4.5 alias validation is key-only. `server.aliases : attrsOf (listOf str)` models `{ screenKey = [ newAltNames ]; }`; only the KEY references a screen (the values are new alternate names, by definition not existing screens). The design Error-Handling table phrase "alias key/value" (design.md ~L366) is a secondary-doc imprecision vs requirements.md Req 4.5 ("a link or alias references a screen that is not defined") and the design's own aliases grammar/schema; reviewer confirmed key-only is correct. If design.md is ever revised, tighten "key/value" to "key".

## Deferred (intentional)
- Declaring a live sops-nix certificate secret for a specific host is deferred: no host enables managed TLS yet (ShopifyLaptop leaves the certificate path and trusted fingerprints unset, like the remote host). Requirement 8 is satisfied as a capability — the certificate-path option, key size, trust rendering, and their validation are built (tasks 1.1, 1.3, 2.1, 2.2) and verified by fixtures (task 4.1). When a host adopts a managed cert, the operator declares the system-level secret and sets the path/fingerprints per the design's host-wiring notes.
