# Research: iii-engine-on-the-fabro-host

External and repository findings behind `design.md`. Sources were read on
2026-11-16 against iii `iii/v0.26.0`, the live worker registry, and the
repository at the requirements-locked revision.

## Summary

- **Feature**: `iii-engine-on-the-fabro-host`
- **Discovery scope**: new feature (packaging + one NixOS service + one Serve entry)
- **Key findings**:
  - iii 0.26.0 publishes `iii-aarch64-unknown-linux-gnu.tar.gz` and
    `iii-aarch64-apple-darwin.tar.gz`; each archive is one executable named `iii`.
  - The Linux engine and 71 of 73 cataloged worker binaries are glibc-linked to
    `/lib/ld-linux-aarch64.so.1`, so the packages need an ELF fixup to run from
    the Nix store; `mesh` and `whatsapp` are static.
  - `config.yaml` may declare only `configuration`, `iii-worker-manager`,
    `iii-http-functions`, and the deprecated `iii-stream`; any other name aborts
    startup with `[UNSUPPORTED_CONFIG_WORKERS]`.
  - `iii-worker-manager` defaults to `0.0.0.0:49134`, so the loopback bind must be
    explicit in the config.
  - The registry lists 93 entries: 76 binary workers, 73 with both required
    `aarch64-unknown-linux-gnu` and `aarch64-apple-darwin` artifacts; the three
    without both are `harness-e2e`, `voice`, and `ios-simulator`.
  - Registry artifacts are one executable at the archive root; `acp` is the only
    cataloged worker whose executable is not named after the worker (`iii-acp`).
  - AgentMemory's `iii-engine` 0.11.5 is a separate Darwin-only derivation with
    its own consumers; nothing in this feature may reuse or rename it.

## Sources

| Ref | Source | Used for |
|-----|--------|----------|
| R1 | <https://api.github.com/repos/iii-hq/iii/releases/tags/iii%2Fv0.26.0> | Release date, release commit, asset names, SHA-256 digests |
| R2 | <https://iii.dev/docs/using-iii/engine> (0.26 docs page) | Allowed engine workers, `config.yaml` shape, `--config`, config reload |
| R3 | <https://iii.dev/docs/upgrading/workers-to-compose> | `UNSUPPORTED_CONFIG_WORKERS`, Compose migration errors, engine worker list |
| R4 | <https://iii.dev/docs/cli-reference/index> | `-c/--config`, `--no-update-check`, engine start semantics, telemetry switch |
| R5 | <https://api.workers.iii.dev/w?page_size=100> | Registry inventory, per-worker type/version/targets, pagination |
| R6 | <https://api.workers.iii.dev/w/{name}/versions> | Per-target artifact URL and SHA-256 for every cataloged worker |
| R7 | `iii-hq/iii` `iii/v0.26.0`: `engine/src/workers/config.rs`, `engine/src/workers/worker/mod.rs`, `engine/src/main.rs` | `EngineConfig` validation, injected workers, default host/port, CLI config loading |
| R8 | `cdn.iii.cloud` and `iii-hq/workers` release assets | Archive contents and digest verification (all 73 Linux artifacts, four Darwin spot checks) |
| R9 | Repository files: `overlays/{default,agentmemory}.nix`, `configurations/fabro-vm/*`, `flake.nix`, `tests/agentmemory-opencode/host-matrix.nix` | Existing overlay, guest, Serve, and check patterns |

## Engine release facts

- Tag `iii/v0.26.0`, release commit
  `93baa39a4bcd841bd66f2a8db4e6b9bc04d1f4a5`, published
  `2026-11-09T22:44:49Z` (R1).
- Required artifacts (both are single-file tar.gz archives; the unpacked
  executable is named `iii`, mode `0755`, verified by downloading each):

| Nix system | Target | URL | SHA-256 (hex) | SHA-256 (SRI) |
|------------|--------|-----|---------------|---------------|
| `aarch64-linux` | `aarch64-unknown-linux-gnu` | `https://github.com/iii-hq/iii/releases/download/iii/v0.26.0/iii-aarch64-unknown-linux-gnu.tar.gz` | `e2ee44d1eb38f0e337d3e77b3b8601da26ff1bd934cc8a4c849b9bcf414ab40b` | `sha256-4u5E0es48OM30+d7O4YB2ib/G9k0zIpMhJubz0FKtAs=` |
| `aarch64-darwin` | `aarch64-apple-darwin` | `https://github.com/iii-hq/iii/releases/download/iii/v0.26.0/iii-aarch64-apple-darwin.tar.gz` | `2730296a08ae5843757b2e7913ad65b6282901c98b951dbc23018e0eb425e285` | `sha256-JzApagiuWEN1ey55E61ltigpAcmLlR28IwGODrQl4oU=` |

- The release also publishes `x86_64`, `armv7`, and Windows assets; the feature
  takes only the two assets above.
- Immutability: the download URL is tag-pinned and the recorded SHA-256 makes
  the fetch content-addressed. Both are required (R1, and the download audit).

## Linux ELF linkage facts

- The engine and 71 of the 73 cataloged Linux worker binaries are dynamically
  linked against glibc. Their ELF interpreter is
  `/lib/ld-linux-aarch64.so.1`; `DT_NEEDED` is `libgcc_s.so.1`, `libm.so.6`,
  `libc.so.6`, and `ld-linux-aarch64.so.1`. Five workers (`iii-directory`,
  `judge-clef`, `judge-decider`, `judge-laya`, `judge-semif`) additionally need
  `libstdc++.so.6`. `mesh` and `whatsapp` are statically linked (no
  `PT_INTERP`).
- An unpatched binary extracted into a Nix store path fails to start on a
  non-FHS system with `cannot execute: required file not found`, because NixOS
  does not provide `/lib/ld-linux-aarch64.so.1`. This was reproduced with the
  engine fixture.
- `autoPatchelfHook` with `glibc` and `stdenv.cc.cc.lib` in `buildInputs`
  rewrites the interpreter and RPATH deterministically; the engine then reports
  `0.26.0`, the `database` worker prints its `--help` text, and the static
  `mesh` binary is skipped by the hook. A missing dependency fails the build,
  which is the desired signal for a future worker that adds a library.
- A local smoke run of the patched engine with the one-entry worker-manager
  config logged `Engine listening on address: 127.0.0.1:49134`; a socket probe
  connected on loopback, and `/proc/net/tcp` showed the listener bound to
  `127.0.0.1` rather than `0.0.0.0`. The injected observability/telemetry
  workers registered functions but opened no additional TCP listener.
- Darwin artifacts are Mach-O binaries using system libraries; they need no
  patching and are installed with `dontFixup = true`.

## Engine configuration and CLI facts

- CLI shape: `iii [OPTIONS] [COMMAND]`; running with no subcommand starts the
  engine. `-c, --config <CONFIG>` selects the config file (default
  `config.yaml`); `--no-update-check` disables background update and security
  advisory checks (R4).
- `engine/src/main.rs` reads the config file before serving; a missing file is
  created only when absent, so an existing `--config` path is opened read-only
  (R7).
- `EngineConfig` has `registration_namespace_grace_ms`, `observers`, `modules`,
  `workers`, and `sandbox`; the file is parsed with `serde_yaml` after
  `${VAR:default}` expansion (R7).
- `validate_declared_workers` accepts only the engine-coupled worker names
  (`configuration`, `iii-worker-manager`, `iii-http-functions`,
  `iii-stream`). Any other declared name aborts with
  `[UNSUPPORTED_CONFIG_WORKERS]` plus the
  `https://iii.dev/docs/upgrading/workers-to-compose` link (R3, R7).
- Missing mandatory workers are injected by `normalize_worker_entries`; a
  declared `iii-worker-manager` entry supplies that worker's configuration
  instead of the injected default (R7).
- The worker-manager defaults are `DEFAULT_PORT = 49134` and
  `default_host() = "0.0.0.0"`; the loopback bind exists only when the entry
  sets `host: 127.0.0.1` (R7).
- `iii-stream` is deprecated and defaults to `0.0.0.0:3112`; omitting it leaves
  that listener absent (R2, R3).
- The engine watches the config file. A valid change reloads affected engine
  workers; an invalid change stops the engine so it cannot run a configuration
  different from the file (R2).
- Deployed worker set: `iii-worker-manager` only. The engine injects
  configuration/engine functions/telemetry/observability, which are outbound
  exporters or in-process registries rather than additional listeners; the
  deprecated stream worker is the only other configurable listener and is
  omitted (R2, R7).
- Telemetry is on by default; `III_TELEMETRY_ENABLED=false` disables it (R4).

## Worker registry facts

### API and inventory

- `GET https://api.workers.iii.dev/w?page_size=100` returns `workers[]` with
  `name`, `type`, `version`, `supported_targets`, `dependencies`, `repo`, and
  `pagination.next_cursor`; page through `cursor` until `has_more` is false (R5).
- `GET https://api.workers.iii.dev/w/<name>/versions` returns
  `versions[].binaries.<target>.{url,sha256}` plus `version`, `created_at`,
  `dependencies`, `license`, and `tags`; the registry exposes no explicit
  engine-compatibility field (R6).
- Inventory on 2026-11-16: 93 entries — 76 `binary`, 12 `bundle`, 4 `engine`,
  1 `executable` (R5).

| Class | Count | Names |
|-------|-------|-------|
| Binary, both required targets | 73 | cataloged set |
| Binary, missing a required target | 3 | `harness-e2e` (no `aarch64-unknown-linux-gnu`), `voice` (no `aarch64-unknown-linux-gnu`), `ios-simulator` (no Linux target) |
| Bundle, official (`author = iii`) | 8 | `claude-code`, `cursor`, `onboarding`, `opencode`, `opengantry`, `openwiki`, `pi`, `vscode` |
| Bundle, third party | 4 | `audit-log`, `hello-node`, `hello-python`, `tabstack` |
| Engine kind | 4 | `configuration`, `iii-observability`, `iii-sandbox`, `iii-worker-manager` |
| Executable | 1 | `registry-cli` |

- `harness-e2e` and `voice` publish `aarch64-apple-darwin` but no
  `aarch64-unknown-linux-gnu`; `ios-simulator` publishes no Linux artifact at
  all. All three are excluded by requirement 2.3 (R5).
- The 73-worker set is the official binary set; third-party bundles are not
  binary workers and are outside the catalog (requirement 2.10 names the eight
  official bundles, `registry-cli`, and the four engine entries).

### Artifact URLs and layout

- Default URL rule:
  `https://cdn.iii.cloud/workers/<name>/<version>/<name>-<target>.tar.gz`.
- Three cataloged workers do not follow the default rule; the manifest records
  full per-target URLs, not a derived template:
  - `acp`: `https://cdn.iii.cloud/workers/acp/0.4.3/acp-iii-acp-<target>.tar.gz`
  - `compose-ui`: `https://github.com/iii-hq/workers/releases/download/build-ff0797e0ed83137d92719a7d2788dbe17b07d796/compose-ui-<target>.tar.gz`
  - `mcp`: `https://github.com/iii-hq/workers/releases/download/mcp/v0.5.9/mcp-<target>.tar.gz`
- Every downloaded archive contains exactly one regular file at the archive
  root, mode `0755`. The executable name equals the worker name for 72 of 73;
  `acp` ships `iii-acp` (verified on both `aarch64-unknown-linux-gnu` and
  `aarch64-apple-darwin`).
- All 73 Linux artifacts were downloaded and hash-verified against the registry
  metadata; the Darwin spot checks (`acp`, `compose-ui`, `database`, `mcp`)
  matched as well (R8).
- The `database` binary embeds `iii-sdk-0.26.0` in its build paths. Because the
  registry has no engine-version field, the repository declares
  `passthru.iiiEngineVersion = "0.26.0"` on every cataloged package
  (requirement 2.8).
- The registry is mutable (`latest` moves, new versions appear). The manifest
  must pin the name/version/URL/digest snapshot below; it must not resolve
  `latest` at build time.

## Worker catalog snapshot (2026-11-16)

`<target>` below is `aarch64-unknown-linux-gnu` or `aarch64-apple-darwin`.
Unless listed in the URL exceptions above, the URL is
`https://cdn.iii.cloud/workers/<name>/<version>/<name>-<target>.tar.gz`.
The `binary` column is the archive-root executable name.

| Worker | Version | Linux SHA-256 | Darwin SHA-256 | Binary |
|--------|---------|---------------|----------------|--------|
| `a2ui` | 0.2.2 | `56b5f01b39385eaaf8be8aaa8be802b66a45f265835b8efd712080e94b2b37e4` | `cd1ffd11ffc688352a494f63668ae1c7c0d57628b7f22aaa907694db5bcb0394` | `a2ui` |
| `acp` | 0.4.3 | `7dd3fab731ca7cfd3221e2a71cb3655f631bcf26ab6b413e0d6c433d7fafe827` | `e209a688b001e42d3545af72b0bf5083cc8c9834a9c73b20bce188413fbc37e0` | `iii-acp` |
| `ade` | 1.10.7 | `026a07a847198008bdf3b5d8d5a90b5305a796ce6101ada45aa533fb8a29b368` | `3ea064756ad62352b999505a70079b7c0d1cee8a53463bd0063a9f62038982e0` | `ade` |
| `approval-gate` | 1.1.3 | `a2ede5638d3c0dc23409c170bd922627ff099727fb6ebf2c3bcf354243f3383c` | `86ee577ea07d7e1a87cd73af0ce0daae330298853f19057e04b364efce5e3a82` | `approval-gate` |
| `bridge` | 0.2.2 | `36080687923f9036d07cf3af6654a1d8bb57688367dcd2f6e22a41c8bbe71e11` | `1fe4cbe8da6169f2f633afa45939cc6320b96e34b4cb488f2f20e56219ad0f6a` | `bridge` |
| `browser` | 0.3.4 | `959d82509b4754f09f7dd6cf34edf99de5e132dbadba54b6cf87f16a7b4e0daf` | `da29e70ac777e5e1a255f8f03ba5204ced5c55a67e6d346a1221c9a8ce1f694f` | `browser` |
| `canvas` | 0.2.1 | `db45c37e04291789f38785ad8b93774621d596739c96ecbc45b243c9576a38ab` | `bab388a28d3d7165b0c0208581a8178646fcd8efcf59449c3c07751178cdc21c` | `canvas` |
| `code-runner` | 0.2.2 | `727a3be12c357f433429a4aa033e3305aa580666901a59e76a477fdc81caee8f` | `aa588fe4ace6ebd0c7bf1afefa233494f6c5d595d8df97ccbb24493f1fdfe946` | `code-runner` |
| `codex` | 0.2.1 | `defaa9dd436747aab6bfcc6f4aa6c9f420987da7a2f3ad23568e3b102e44d2e7` | `09577c10c89ffcee9dba7ac903f48d8121869a42cce2de447d7801259a475da8` | `codex` |
| `compose-ui` | 0.1.9 | `362a7a3689e27edf5e30f06119607c33d0a5da510b5601e18f89af99069f6e32` | `54e6c335eb2bdf542ff2538d97965f0acb81347b3948e577fa2cbd2d23d09ec8` | `compose-ui` |
| `computer` | 0.2.3 | `693b5723f01e5bf000e967e40983a969478617fae16e3830ae2758083fcc3266` | `71dcbd36c604f22b1754b19ea72fe4c6d1524f44fc28b90a105cf56a9e1bae35` | `computer` |
| `context-manager` | 1.2.3 | `2761c06d526f6a6c0af32df1dcbdc23feaeb425340913ef13eea684515401fb7` | `84bc6a2d52804c57080fbbc82be2f7149cb459723e91e9dc071cae1e388926d3` | `context-manager` |
| `cron` | 0.22.1 | `90b598dce51dc0603739c5e83e9d78fd6529382e2525995715ca3f92d59c0bba` | `8c74731376cdbc423bdc31813c52069cd1f8580543de1ad1f43079178f1ea006` | `cron` |
| `database` | 0.6.3 | `245f4e61f5ef80f4b0c20ee3e15892b5ee5c9265c3dccbba9e9c9a5fdba271a4` | `9be61b0080ab458a082919c8eb9d966c0abf7390667ea95c0438d19aaf585f25` | `database` |
| `document` | 0.2.1 | `dad2a8fae588db49c6d01bbb88dc63ae7d1372f79da9ef22a1f46862ddc0623a` | `79a6775eb87d7fd056be7f610e83d4966774d72387ce53c3006158ee3bfdc15d` | `document` |
| `email` | 0.2.1 | `883cc101c76338ce2996b02fab31526e8f9f48870c722961bcfabb9566460f78` | `0a04df9b03892890da3166bc358546ee0f30a0f530a5e83046aeab482ac63ece` | `email` |
| `eval` | 0.3.4 | `889ff0e559d488f59ef5d22fba195d072b7bc1274b719fa347ca2a83c832adb5` | `1b2332148e3ffdd794775c8a8d15634747bea216d91286697eb0f735e103af2e` | `eval` |
| `fp` | 0.3.1 | `caf07ec16d69b298b563723be39844f2db370878548daffca5ec1081cbc8777d` | `6c5e7ff7ba71297c2bb4dc57578ae14a7b84958e1c29f8899977efc6af736c7a` | `fp` |
| `github` | 0.5.3 | `e082ff4e31d7613f6fa6917e3c4ac0ea76ee21340a5b12aa05dde17f67fa4b24` | `ca443caa2049f49e507a540ca65c2df3170e3e91f4eb06879b258357410a4a9c` | `github` |
| `harness` | 1.9.9 | `78ee21f0e671007ea61bf6379d0a5a0fae82ddbbc4b54303ae4095dbe4a3fa5f` | `f7730288864b352c7c42f06698b1c2a59189612a759289fab195c081a66dd5bc` | `harness` |
| `http` | 0.23.3 | `37b6caa3c750d0bb4469d86f21bb638ab09c18310dc0f6c8824cedbdc6744bb2` | `474832680acd7e17597defc85cf44ae83e0fcd66efba795708e3b49e4d4d836e` | `http` |
| `ide` | 0.13.5 | `0f96798030b305cbb36ec8cec2533065ddcf9df6baa741c3aca9d7b5e7eeefdd` | `ca62dd468e27ba4733dcc4b69c05ad43c63e42e69dd5fbb407de0fc79728074a` | `ide` |
| `iii-directory` | 1.3.5 | `e05a9835583d912c2996c97fdb6761d8670010ce138ed78defc9ea4b4372d720` | `ee815b9451b01789d22009ea44360b1f94d42eecadd37654c61c3dc90f659012` | `iii-directory` |
| `image-resize` | 0.2.1 | `981a8acfec1fe137d0bf1927c563f155ba9c056cf1230adb767d372c65da1125` | `799f2bd2db4034e0e0f207371b4b399838642ae5c95ddbe86cba6372955e734c` | `image-resize` |
| `judge` | 0.3.3 | `ceaf3c074b0dfb1acd5ae4316bbca3b2c1c73d2e50e9fadea5faa05e0476592e` | `b80ef1c2be0c703bc093e8ca1af82307493801133c41a6c5191f8ee35b90390c` | `judge` |
| `judge-clef` | 0.3.2 | `898b0b85ef9a63d456cee950770e8006601ac90b7048f8abd1a4409e4a637958` | `ba4cc811ca823bdce7375824d70b8b55729dc92697edc452e6d732ca0871aa95` | `judge-clef` |
| `judge-decider` | 0.3.2 | `7fb40358ed648c773ef194640f7f35fb5ce07f677884cadfdc3bb3e89ae7c893` | `ef985971e93de6a6b164d4aef19b63f25523738dfc735f0e2ab48f1a1e4c9307` | `judge-decider` |
| `judge-laya` | 0.3.2 | `24e0113a226407caff96da0c218fe28371a9db246ffc09cdbcc8d60d75150377` | `9a161f093fffc42f75fe773a2927653bdc6ab9660a5f74e15e08a0bd3be180d1` | `judge-laya` |
| `judge-openai` | 0.3.2 | `bd990b558631259aec0657a306a06f7fd7969c3c57980c10b4aed37bf5549e02` | `506e5980e5e1b2c0090e606265b5e76b9522b329c09710afc793c9d8cb12df17` | `judge-openai` |
| `judge-semif` | 0.3.2 | `7cb37ee0e42fc6f54123aaf116d14e35df17abeb5dc2834ab03472608e6074ac` | `a7724a8d59d8274d8e81290c156aee9f01f3265d56c7c3ec865e361f3cf77436` | `judge-semif` |
| `judge-typesafe` | 0.3.2 | `947ec464de3363d574be830ef92597c043635cc0d6ec34d572342225ec3736f0` | `ebc8d6a4c3965da19017cb732b1c38eec67e59fe271e3f237502e73f796f9c24` | `judge-typesafe` |
| `kanban` | 0.2.2 | `e1ee82817b3b2a24d57234e57fe7ae2e6492bbc8a005f24d5677e67617c40f17` | `ce052c2712b052badd2fa96c759c100444bbbe8fd27778057c4b3ae1e692bf8b` | `kanban` |
| `llm-router` | 1.5.3 | `2742722dad733f9d6ab94218f2aa654a3ba15dbb6e60fb37f0ffa07e91990434` | `43fb53133a9be4628fd40feb5f3a85b6f52529b51338133726b34ae043bb6670` | `llm-router` |
| `lsp` | 0.2.0 | `af076a6a7186aa19f974eba6d266f23276c6d395b612804d3729eb6b713509fd` | `b515a149921d1de2857f8a5ddc8374f205eafa8dfaf8ea388288b8dce2e115aa` | `lsp` |
| `mcp` | 0.5.9 | `6e0bbdc0674a8dcbfe3a4a59a26bba7972352d111f0e3cc75716f8e5719c29fa` | `0175db5a8358d1daeb58180c3b6b97788dacd1a24bafe677569f9a40a7942942` | `mcp` |
| `memory` | 0.3.4 | `f028b3da861ebd0f7c2cf7185a92b457835309ce58b3fc316720e68bf4371f04` | `106b5bb2d5122a8d10d63dcff454554fec5dabd9569e352d41934d8557c78211` | `memory` |
| `memory-consolidate` | 0.2.3 | `58b8cfc3ca0e105d7fd87bd21e9c8efc5007ed927febabbc13c69c5cae5c29fa` | `fa3eba354a9c6b7eddd0b41ea3eeb30ea697e2a078eab4e8de190e59e32fd9aa` | `memory-consolidate` |
| `mesh` | 0.3.2 | `384755ce70cfeb9967d3ceec5195b869bfb0d29458cfdd63dfec272588983008` | `f34602a91f7dd36c12b5ebbb1fc489a2e3248f33ab653098ca0423f48aa79431` | `mesh` |
| `pdf` | 0.2.2 | `386112a1c2e948a4d8b200057dc9b6ae4d844d7997a36772c6570f3d1d9ccd8f` | `cd3616bdf641a0e372c11a4e32affa4410347fee7c21c544c223bfb48406951c` | `pdf` |
| `provider-anthropic` | 1.3.2 | `1b47183d27fca1af6085fb0db13fc509959472e01ede5c929d3639fb649cdb56` | `e7e2b6a6b1ba9b37ec5cbd96f2a26c2d12c8cc29c09a76eb589b104a9eedf9bd` | `provider-anthropic` |
| `provider-claude-code` | 0.2.4 | `222b0149ed78628940561813b1ac206f99eb3b7d20ce6166feb30971d2391222` | `03e5dea2380a42d201c32a43acdfc90cd74656d0848952b1a34e37732d0bcc8e` | `provider-claude-code` |
| `provider-command-code` | 0.2.0 | `3f79df23af5ebb9ffc02fd524fad32968c526bb15e3282e55f7d6b8131c63e5a` | `dc43dc853709d2c446ce6fc494f2440e63b8f7325379a51697439aa200d2f53d` | `provider-command-code` |
| `provider-deepseek` | 0.2.0 | `bfd5b72f8e01cc7cdc6f4fa1d47519dfbdcae11f8885d87f3642ef958da3d913` | `9052a750e8293632a8479ca2261d8600e54c26e1371a0094247924c59e7ae956` | `provider-deepseek` |
| `provider-elevenlabs` | 0.2.0 | `09f1bafedc804fe197fa438bc13408efe32d98232541ce3e24420e9e9eadc5ad` | `603ab7797fcab2dc417b083b02f3f010c891f9047e1b3d87eb5dbb12fdc2ad51` | `provider-elevenlabs` |
| `provider-github-copilot` | 0.2.0 | `5357beeecc756e37dfb1d0f5c4fc3e3f81762460d7f3165cf477afb96970b36e` | `9e8846efe7746fd25b5c4fc6d3ad1156b26134718ab71488809fc8c515fc4afd` | `provider-github-copilot` |
| `provider-kimi` | 1.2.1 | `5218487bf9661d02dc2bf0c8e2d4356a2a46d3ad7158d6d90471579970d1d9ba` | `d8180c1e8673b2fa38f164bfbe7d9ae3e88e02aa678aa46d72942cf6c7fa7311` | `provider-kimi` |
| `provider-llamacpp` | 0.4.1 | `b6919dee852d250daa00b1e2da5270fb069c81b25c95f3fa80a5306d5bb7e1aa` | `992fe88c97ad6298fe7917e1987a8f82de3d3e9afb16779d888dc64eb8117b4e` | `provider-llamacpp` |
| `provider-openai` | 1.3.1 | `2b1c0eadab75f382b11788cfb56261e401e4758af677fd66780840e50a2242ab` | `cb79427b4a38c3f6eb07196ae0a4a52ab9074fad664142d3c23a1a932e604aa5` | `provider-openai` |
| `provider-openai-codex` | 0.5.1 | `87df276b23e4d22574eb2bb5d859980cf8d908c774541c2d1328a198f12755a6` | `8d51348f9190c0caa17057928d63e5b56062332269600c63ec4370d156718c49` | `provider-openai-codex` |
| `provider-opencode-go` | 0.1.0 | `36e62f232608e3cc546d45952d170da05e7a8bc60aba604031f73b60ee08be4c` | `38e1bbc39249dd8a3efad4bcbf7b2082ff3402dd9844015b2e1decf9ca7919db` | `provider-opencode-go` |
| `provider-openrouter` | 0.2.0 | `8870351c65e4886df9902ac7abcf5b161b6c12c28e237cd2befaf8fb59eb9682` | `c836ef1a8e044e581f7d85bd0037de723ba6a0b07b2b626cbbe37d3732917339` | `provider-openrouter` |
| `provider-sarvam` | 0.2.0 | `f66c82c71d39679d36f61663048e51ce9b2e33847101d7fd1f66215accaa5f80` | `631c12e6cb82ad1a7f2957dee1f95f155f76c042ee91e0877d42e9233f3c02eb` | `provider-sarvam` |
| `provider-xai` | 1.4.2 | `2616e58b775b0e395b980cec47e28b84094161396b4c0601bf245813dce4a2be` | `2f817ba07a073379fb52b6a52c3d74109f2418f52ac38ceb96169763f3dd52d2` | `provider-xai` |
| `provider-zai` | 0.6.0 | `2c355f529fc19b317fad8362be95c4d59e725cef978b40a40ff58d90b94499d7` | `b4ae0e8748a7ec5cdd2257eebc95f8475ff65f95efbd12dfc52c12ae39c2cf0c` | `provider-zai` |
| `queue` | 0.22.2 | `0eb97866b954c3d21aadf6eac7223ba2ba33ce202a45abc21d5713072a63be60` | `246eb416a9179ed0762c36fa157a37e013eae98d5f54017af21ea29260ce8263` | `queue` |
| `quick-tunnel` | 0.2.4 | `32b53b8aea91142be5fcabb0a95f24863d0cfd51169f857853f0f02b6818937a` | `8e1a7f37e6f12372f2173c78439a4a3520d08c5bd9eafa92015b440decf00ee0` | `quick-tunnel` |
| `rbac-proxy` | 1.1.5 | `aa41e67aa814dbfe877661cbce6d851f44d53acc89910084a3c9df3e3efd9a96` | `07fbd16319848a2365bf20af2cd684b00e52338eac5eb2a233a625187abeb9cd` | `rbac-proxy` |
| `sandbox-libkrun` | 0.4.3 | `4ebadd09193e64b9029c664eeb42acd21ae0bda98a6cc8519cf7e8349a44578d` | `0bdb050a50ac668b026569bddeebdd0c6bb5c03cc1f96d02c15ec675a952a6a0` | `sandbox-libkrun` |
| `secrets` | 0.2.2 | `c045c3565e78f8f4375c9a0d203c401de948e35807354c6f024cea3831ef16e8` | `5230800be324915605760c5c3d9d6ceac68710f3a5ac93a9e95b3c77fd3683f5` | `secrets` |
| `security-scan` | 0.2.4 | `3600fd05f3ce24960f0454e4f12ade20832af979dfdf03e658b90b40b9cf108b` | `eaf8edf5a04e842b1bf7a7eedbdd149ce897b6a11b29bfa25fac961099c41b5c` | `security-scan` |
| `sentinel` | 0.2.5 | `d94a1d247dd99096f832e12d6e81b48f7bec6dc1f1423f69f09e6278ae274801` | `2a7556c8a36449d9827d0eb7407561388409e90ac5b35d9baa755c4880ebbe8f` | `sentinel` |
| `session-manager` | 1.1.1 | `cbae17e37e8bfea141aa506c3446baa4e76e15bd13c3a8cb691369418310a32c` | `ea8037761e26c45f8248981f481c9dd0e6430ca75fb3ec9a7f9377dec9a7d506` | `session-manager` |
| `slack` | 0.2.1 | `6c740d6519f9e5a9a283d9ac5ef8c74b7ae724f60b7bada4cc565361d6de3625` | `80755d8f8ba0b737cc5f25db1688c3398dc5d3c7dd4d5d314d8e44caa1d8e8b0` | `slack` |
| `state` | 0.23.1 | `7c1d648e81b5f41c8d7200c1090db36c040bd0df1f71aa6870225c3a83a52a7e` | `9420e8186be0335e584d6de23d8d9da2376283371c536447fc9a439d98adfd4e` | `state` |
| `storage` | 0.2.3 | `7538b238cc763e3cd5633091eceae0240f21a14d94185fb636c82e7d49eb4827` | `6d5447ac2a1bbb5a791a4a953f0ae403de9a9fb76a64ac05401254a26fdf8ff9` | `storage` |
| `stories` | 0.2.1 | `afeea71dd49e0dae989730b0db3ff718b9b396aa7f365806c971827c1a3e34fd` | `22a1159cf4b9012ac862f900196e1e4442ef0dbdc8543b7c2c6ce4f2e445e971` | `stories` |
| `tailscale` | 0.2.1 | `b5f1f7ab79ca79464b81cd521bcf73f2a8bee06ea22aa3a9b8617217effda348` | `8f9c33a52ffcb2813901457e5d688f1158ef8823fbf5b835ffbf4ba832a8df40` | `tailscale` |
| `telegram-bot` | 0.4.3 | `f22599a42b15d944ce20087a3d814c91aff2374a44ff857251b33c9fb36ff139` | `2ba677fe81ac0b75a5d8379a8f183c998b4a642021386b6608eafb510331cc96` | `telegram-bot` |
| `tmux` | 0.2.9 | `a6f2ab35ac210cd6dbfd2b653e182f1ec977290e51280979a0b506b7fdfbcbfa` | `9b0660095eb644ce6bf20f745f6c44099c3fc89b307c4c67948f4c706883828e` | `tmux` |
| `web` | 1.3.1 | `cd273ac326196602a83b13f110104db270051b541df1b1ad16a4d3abd94d7613` | `ab8aa526dba47ab9ba8b7b3be81790fa646d30c3e6805abbf70d39680e6ae96d` | `web` |
| `whatsapp` | 0.3.2 | `9332e1c8beb3d42ae8800a82e08820217120ce03abc05a96fa47fe8a74c4fcf2` | `47c43ea9316471a66021ac0fc66d854fff9fa2f9a390a1167186a4fa495d3631` | `whatsapp` |
| `workflow` | 0.3.0 | `295ac35210e4e172156a8b1a2be98e9f5364c1c676500886a4a539fe9b117da6` | `437c5dec8e0fa5e497870e12a782d3020f963d62197119200e3f9b51381ed26f` | `workflow` |
| `worktree` | 0.4.3 | `473a61e6a26ea36b9528c8088636d9b8803300337cbf5c17f8ac914f7aeb375d` | `f90aa935338455bedf09b5c34523be84695ee6286338362da49a92e19baafe23` | `worktree` |

## Repository facts

- `nixosConfigurations.fabro-vm` (`flake.nix`) composes
  `configurations/fabro-vm/` with the `fabro`, `unstable-packages`,
  `custom-packages`, and nix-snapshotter overlays (R9).
- `overlays/default.nix` applies `overlays/agentmemory.nix` as
  `pkgs.iii-engine` 0.11.5 (Darwin only) and has no `iii` or `iii-workers`
  attribute (R9).
- `pkgs.iii-engine` consumers are `home-manager/common/agentmemory.nix:20` and
  the Darwin-only `agentmemory-opencode-matrix` check's `nativeBuildInputs`
  (`flake.nix:1854`); both read the attribute lazily (R9).
- `configurations/fabro-vm/tailscale.nix` runs one `tailscale-serve` oneshot
  with three `serve --service=... --https=443 http://127.0.0.1:<port>` entries
  and `requires` `tailscaled-autoconnect.service` (R9).
- `configurations/fabro-vm/default.nix` installs `fabro` and `litellm` through
  `environment.systemPackages`; the guest's other services use `DynamicUser`,
  `StateDirectory`, `ProtectSystem=strict`, and `RestrictAddressFamilies`
  `AF_UNIX/AF_INET/AF_INET6` (R9).
- `fabro-vm-guest-eval` is a pure-evaluation check over
  `nixosConfigurations.fabro-vm.config` with `lib.assertMsg` messages that name
  the missing element; it currently asserts exactly three Serve entries (R9).

## Architecture pattern evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Reuse/rename AgentMemory `iii-engine` | Point the guest at the existing derivation | No new package | Wrong version/platform set; breaks AgentMemory consumers; requirement 1.8/3 forbids it | Rejected |
| Data-driven catalog + generic derivation | One manifest table, one builder, 73 attributes | Small code surface, auditable pins, easy revalidation | Manifest is long; a bad entry fails at build | Selected |
| 73 bespoke derivations | One hand-written derivation per worker | Per-worker customization | Duplication, drift, review cost | Rejected |
| Compose-managed engine | `worker-compose.yaml` + `iii compose` | Native worker lifecycle | Downloads/creates state imperatively; violates no-workers requirement | Out of scope |

## Design decisions

- **Fresh attributes, not reuse**: `iii` and `iii-workers` are new overlay
  attributes; AgentMemory keeps `iii-engine` 0.11.5 untouched. The pins differ
  in version, purpose, and platform set, so sharing would force unrelated
  consumer edits.
- **Explicit loopback entry**: the config declares `iii-worker-manager` with
  `host: 127.0.0.1`; relying on the default would bind `0.0.0.0:49134`.
- **No stream/sandbox/configuration entries**: the engine injects what it needs;
  `iii-stream` is deprecated and opens a second listener, and no sandbox caller
  exists.
- **Store config + StateDirectory**: `pkgs.formats.yaml` renders the config to
  a read-only store path; `/var/lib/iii` (systemd state) holds runtime state and
  is not on the Lima virtiofs share.
- **Pure-eval checks across systems**: instantiate both target nixpkgs sets and
  assert package metadata/URLs without building them; the guest check never
  reads the rendered config derivation (that would need a build).

## Risks & mitigations

- Registry snapshot drift — the manifest pins exact versions, URLs, and
  SHA-256 values; a change is a deliberate revalidation, not a rebuild surprise.
- Archive layout drift — every derivation installs the single archive-root
  executable and fails its build if the expected binary is absent; `acp`'s
  `iii-acp` name is recorded in the manifest.
- ELF dependency drift — `autoPatchelfHook` fails the Linux build when a worker
  needs a library not in `buildInputs`, instead of shipping a binary that fails
  at runtime.
- iii config-schema drift — the config uses only the documented allowed worker;
  the error table and revalidation triggers cover the `UNSUPPORTED_CONFIG_WORKERS`
  path.
- The server sends telemetry by default — the unit sets
  `III_TELEMETRY_ENABLED=false`; `--no-update-check` stops advisory/update
  traffic.
- Missing `svc:iii` Service — the Serve unit fails and journals the error while
  the engine stays loopback-only; the Service is an operator precondition.
- AgentMemory regression — no task edits its overlay or consumers, and the
  isolation check pins its 0.11.5 metadata and distinct sources.

## References

- [iii 0.26.0 release](https://github.com/iii-hq/iii/releases/tag/iii/v0.26.0) — assets, tag, date.
- [iii engine configuration](https://iii.dev/docs/using-iii/engine) — allowed workers, `--config`, reload.
- [Move workers from config.yaml to Compose](https://iii.dev/docs/upgrading/workers-to-compose) — error codes and engine worker list.
- [iii CLI reference](https://iii.dev/docs/cli-reference/index) — flags and telemetry switch.
- [iii worker registry API](https://api.workers.iii.dev/w?page_size=100) — inventory and per-worker versions.
- [iii-hq/iii at iii/v0.26.0](https://github.com/iii-hq/iii/tree/iii/v0.26.0/engine/src/workers) — default host/port and config validation.
