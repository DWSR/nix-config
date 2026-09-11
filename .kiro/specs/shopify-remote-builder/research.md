# Research and Gap Analysis

## Scope

This analysis maps the approved requirements to the current two-host
nix-darwin configuration and verifies Nix/Tecnix/Lix behavior that constrains
the design. It records findings and viable options; `design.md` owns the final
component choices.

## Existing Assets

- Both live hosts are `aarch64-darwin` and share
  `configurations/common-darwin/default.nix`.
- `configurations/common-darwin/local-binary-cache.nix` already provides a
  dependency-injected post-build hook, durable GC-root queue, asynchronous
  Attic publisher, diagnostics, and strict option assertions.
- `configurations/personal/default.nix` enables the cache server, consumer,
  and publisher under Lix 2.95.
- `configurations/shopify/default.nix` enables cache consumption/publication,
  retains the externally owned `nix.conf.d/shopify.conf`, and exposes Shopify
  AWS credentials only to the local Nix daemon environment.
- `configurations/common-darwin/default.nix` already declares the login user a
  trusted Nix user, which permits per-command daemon setting overrides.
- `home-manager/common/ssh.nix` configures only an interactive SSH client. No
  SSH daemon, builder account, daemon key, host-key pin, or remote-build
  configuration exists.
- `tests/local-binary-cache/` supplies reusable `lib.evalModules`, isolated
  script-fixture, render, queue, outage, and two-host smoke-test patterns.

## Requirement-to-Asset Map

| Requirements | Reusable assets | Gap / constraint |
|---|---|---|
| 1 Explicit requests | `writeShellApplication` scripts; trusted Shopify user | **Missing:** guarded command, immutable-ref resolver, allowlist, per-invocation state |
| 2 Public eligibility | Clean-environment pattern in the cache hook preflight | **Missing:** graph walker, restricted evaluator, source classifier, replay proof, graph binding |
| 3 Remote/fallback | Nix daemon and matching host platform | **Missing:** builder SSH service/account/key and invocation orchestration; **Constraint:** post-commit failures are terminal |
| 4 Cache publication | Existing hooks, pending roots, Attic jobs on both hosts | **Constraint:** both hosts may enqueue one remote result; existing queues are host-local and idempotent |
| 5 LAN trust/secrets | Per-host SOPS files and path-only secret convention | **Missing:** Shopify client SSH key, personal authorization, committed host trust, LAN-only service policy |
| 6 Diagnostics | Existing cache readiness/diagnostics package pattern | **Missing:** eligibility, SSH, protocol, and execution diagnostics |
| 7 Verification | Nix/Node/shell harnesses and manual two-host phases | **Missing:** remote-builder fixtures, contaminated-store cases, cross-version smoke phase |

## External Findings

### Remote protocol and scheduling

- `ssh://` runs `nix-store --serve --write` but cannot carry Check mode through
  Tecnix's remote-build hook. Direct `ssh-ng://` negotiates worker protocol
  1.35 and preserves Normal and Check modes across the target versions.
- A trusted Shopify user can override an empty global `builders` setting, but
  Tecnix forces Check builds local and omits BuildMode from its remote hook.
  Native `--builders` scheduling cannot guarantee a personal rebuild.
- `nix.distributedBuilds = false` renders an empty global builder setting in
  pinned nix-darwin. The selected direct-store path does not change it.
- The current cache assertion at
  `configurations/common-darwin/local-binary-cache.nix:848` blocks only the
  global nix-darwin distributed-build option. The guarded approach may require
  revalidation and tests rather than removal of that assertion.
- The direct remote-store CLI initiates SSH as the Shopify login user. Its
  passphrase-free private key must be user-readable at a runtime path outside
  `/nix/store`; the personal service account must be trusted by its Nix daemon.
- References: [Nix distributed builds](https://nix.dev/manual/nix/2.34/advanced-topics/distributed-builds),
  [Nix SSH store](https://nix.dev/manual/nix/2.34/store/types/ssh-store), and
  [pinned nix-darwin module](https://github.com/LnL7/nix-darwin/blob/adda04f0bf4819575b1978c2f8d78401b3c2be12/modules/nix/default.nix).

### Failure classification

- Tecnix 2.34 and Lix 2.95 collapse an accepted remote derivation failure and
  a post-accept transport exception into the same miscellaneous failure.
- Exit status and `internal-json` output do not provide a stable typed
  distinction. Log-message parsing would bind correctness to unstable prose.
- Initial readiness failure can be detected before remote acceptance. After
  acceptance, all failures must share one no-local-retry policy unless the
  scope adds a remote job agent or protocol patch.
- Requirements 3 and 6 were narrowed accordingly during gap validation.
- References: [Tecnix remote hook](https://github.com/Shopify/tecnix/blob/9e5caaa107d6dff09d449a11f8201e3e45285ead/src/nix/build-remote/build-remote.cc),
  [Lix remote hook](https://github.com/lix-project/lix/blob/ddc4e4131c4e6f0c4ba2e4dc0b33cea672a93d96/lix/legacy/build-remote.cc), and
  [Lix log-format warning](https://docs.lix.systems/manual/lix/2.95/command-ref/opt-common.html#opt-log-format).

### Public-source proof

- Nix has scheduler labels but no public-provenance label. A package name,
  fixed-output hash, HTTPS URL, or binary-cache hit does not prove anonymous
  source availability.
- Distributed builds copy every missing input closure. A normal personal store
  or the shared Attic cache can hide a private source previously published by
  Shopify and cannot serve as eligibility evidence.
- A fresh diverted local store can preserve logical `/nix/store` paths while
  isolating evaluation state on Darwin. It can fetch flake inputs, emit
  derivations, and enumerate `inputDrvs`/`inputSrcs`, but macOS cannot execute
  builds when logical and physical store roots differ.
- A second temporary store with matching logical/physical roots can replay a
  bounded allowlist of recognized fixed-output fetchers without substitution.
  The validator must reject unknown/custom fetchers, IFD, dynamic or
  content-addressed derivations, local paths, mutable refs, private schemes,
  and unapproved redirects.
- Restricted evaluation must use fresh HOME/XDG/Nix state, no registry or
  flake config, no access tokens/netrc/SSH agent/proxy/AWS variables, no
  substituters, no plugins, and an explicit public URI allowlist.
- The target's immutable reference, attribute, system, evaluator settings,
  recursive graph digest, and top derivation path form the approval identity.
  Tecnix and Lix graph mismatch means local fallback.
- A signed dependency closure queried directly from an approved anonymous
  public cache can terminate provenance traversal. This cut is unavailable to
  the requested top output and never trusts the local Attic, Shopify cache,
  normal stores, or persistent narinfo state.
- This proves anonymous refetchability at check time only for the bounded
  fetcher class. Arbitrary Nix graphs require a VM or stronger broker, both out
  of scope.
- References: [Nix local store](https://nix.dev/manual/nix/2.34/store/types/local-store),
  [Nix derivation JSON](https://nix.dev/manual/nix/2.34/command-ref/new-cli/nix3-derivation-show),
  and [Nix configuration](https://nix.dev/manual/nix/2.34/command-ref/conf-file.html).

### Cache handoff

- The personal daemon runs its post-build hook for outputs it actually builds.
  Native remote scheduling can run the Shopify hook after import, but the
  selected direct `nix copy` return path is an import and does not.
- Personal publication therefore satisfies Requirement 4 without a new cache
  transport. A later Shopify local build may enqueue the same output; existing
  Attic idempotency covers that case.
- Substituted dependencies do not invoke the post-build hook.

### Forced execution and source egress

- For a direct `ssh-ng://` store, a missing output is primed in Normal mode and
  every eligible request ends with Check mode. Check executes on Lix, compares
  the result, and synchronously runs the personal post-build hook.
- Verified outputs return through `nix copy --from <remote> --to daemon`; the
  trusted Shopify user permits unsigned transfer from the host-key-pinned
  personal store.
- Tecnix forwards explicitly overridden client settings to a trusted remote
  daemon. Every direct-store subprocess therefore needs a fresh minimal Nix and
  SSH environment so Shopify hooks, private substituters, tokens, AWS paths,
  and proxies cannot replace personal settings.
- `base64-ssh-public-host-key` expects the Base64 of a `key-type key-data`
  record; that Base64 value is percent-encoded in the URI. Hostname and comment
  are not part of the stored artifact.
- Recognized source replays use a transient Dante SOCKS5h policy proxy. The
  proxy listens on unprivileged port 1080, binds a declared non-VPN interface,
  permits only outbound TCP port 443, and rejects IANA non-global IPv4/IPv6
  destinations for every connection.
- Standard pinned `fetchurl`, `fetchzip`, and constrained HTTPS `fetchgit`
  profiles receive an explicit proxy configuration in validator-owned replay
  derivations. Unknown or modified fetcher shapes remain local.
- Uncached branches receive source replay; dependency branches whose entire
  closures have fresh trusted narinfos from an approved public cache are
  recorded as invocation-scoped `PublicCacheCut` attestations.
- Using Shopify's daemon as `--eval-store` would still upload the complete `.drv`
  and input-source closure beneath a cache cut. The selected flow independently
  evaluates and roots the graph in the personal daemon store, then invokes the
  remote `.drv` with primary and evaluation stores both set to that remote.
- Existing personal paths under a cache cut must match freshly signed narinfo
  metadata and a recomputed local NAR hash. Generic copy success and
  content-addressed-path trust are insufficient.
- A request-scoped personal lease roots the derivation/input-source graph,
  replayed sources, cache-cut closures, selected input outputs, and final output
  through the return copy. Explicit release plus TTL cleanup bounds interrupted
  leases.
- Lease expiry is inactivity-based. A long-lived keeper holds an active lock and
  refreshes a heartbeat across prepare, Check, and copy; cleanup skips that lock
  regardless of age and reaps only inactive stale manifests.
- macOS cannot force arbitrary FOD code through the proxy without a VM or
  packet-filter policy. Exact fetcher pinning makes this an accidental-routing
  safeguard, consistent with the declared threat model, not an adversarial
  egress boundary.

## Implementation Options

### Option A: Extend the cache module

Add builder options, SSH services, eligibility scripts, and diagnostics to
`local-binary-cache.nix`.

- **Benefits:** Reuses one role model and diagnostics surface.
- **Costs:** Conflates storage/publication with execution policy, expands an
  already large module, and reverses the existing spec boundary.

### Option B: Standalone remote-builder feature

Add a separate typed module and scripts; treat the existing cache hook as an
unchanged downstream integration.

- **Benefits:** Clear ownership and no global distributed-build setting.
- **Costs:** Cache readiness and duplicate-publication expectations can drift
  unless tests explicitly span both modules.

### Option C: Hybrid integration

Create a standalone module/scripts and add only explicit compatibility tests or
a narrow diagnostics seam to the cache module.

- **Benefits:** Keeps eligibility/execution separate while making the cache
  handoff and global-distributed-build prohibition deliberate.
- **Costs:** Requires cross-module fixtures and careful option dependency
  direction.

## Complexity and Risk

- **Effort:** L (1–2 weeks). New restricted-evaluation workflow, system SSH
  integration, two-host orchestration, and broad negative fixtures are needed.
- **Risk:** High. Public-source classification is fail-closed but necessarily
  bounded, and actual Tecnix-to-Lix behavior lacks a published support matrix.

## Remaining Validation Work

- Verify direct `ssh-ng://` Check builds, pre-commit fallback, post-commit
  no-retry behavior, both-host hooks, and cache reuse on the actual machines.
- Require Lix 2.95.2 or newer because earlier 2.95 releases contain a remote
  NAR parser memory-safety fix.
- Use pinned `nixpkgs#cxx-prettyprint` for the initial smoke target and recheck
  that its output remains absent from configured public caches before rollout.

## Design Synthesis

- **Generalization**: Resolution, cross-host comparison, source proof, remote
  execution, and diagnostics share one immutable `GraphIdentity`; no stage may
  substitute a looser package-name or repository-only identity.
- **Build vs. adopt**: Direct `ssh-ng://`, OpenSSH forced commands, Nix Check
  mode, Dante, SOPS runtime paths, and the existing cache hook cover transport,
  access, execution, egress policy, secrets, and publication. New code is
  limited to guarded orchestration and bounded eligibility validation.
- **Simplification**: Keep `nix.buildMachines` empty, retain
  `nix.distributedBuilds = false`, store no reusable approval, add no remote
  job agent, and leave `local-binary-cache.nix` unchanged.
- **Source proof**: A clean diverted store proves pure graph evaluation and
  evaluator inputs. Signed anonymous public-cache closures cut dependency
  branches; recognized FODs in remaining branches are forced to rebuild under a
  sanitized, sandboxed invocation through the policy proxy with substitution
  disabled. Pre-existing local outputs never count as proof.
- **Execution boundary**: A successful validator and readiness handshake is
  the commit point. Pre-commit failures fall back locally; every subsequent
  Nix failure returns without local retry.
- **Remote output**: Missing outputs are primed before a mandatory Check build;
  successful Check proves personal execution and post-build enqueue before the
  output is copied back to Shopify.
- **Transfer boundary**: Validation produces a personal graph lease. Check uses
  that remote `.drv` directly with no Shopify evaluation store, so no Shopify
  derivation/input-source closure crosses the boundary.
