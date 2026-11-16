# Research: iii-engine-on-the-fabro-host

External and repository findings behind `design.md`. External sources were read
and artifacts were fetched on 2026-11-16; packaging and runtime behavior was
reproduced in this repository's Nix sandbox on `aarch64-linux`.

## Sources

| Ref | Source | Used for |
|-----|--------|----------|
| R1 | <https://api.github.com/repos/iii-hq/iii/releases/tags/iii%2Fv0.26.0> and the release's `.sha256` assets | Engine tag, asset names, sizes, digests, inner file names |
| R2 | <https://api.workers.iii.dev/w> and `/w/<name>/versions` | Official worker set, per-target tarball URLs and SHA-256 digests |
| R3 | `iii-hq/iii` source at tag `iii/v0.26.0`: `engine/src/main.rs`, `engine/src/workers/{config,config_rewrite,registry}.rs`, `engine/src/workers/{worker,stream,configuration,sandbox,observability}/`, `engine/src/workers/configuration/adapters/fs.rs`, `engine/src/workers/engine_fn/mod.rs`, `engine/src/workers/telemetry/environment.rs`, `crates/iii-compose/src/config.rs` | CLI flags, config schema, mandatory/optional workers, listener defaults, state locations |
| R4 | <https://tailscale.com/docs/reference/tailscale-cli/serve> and <https://tailscale.com/docs/features/tailscale-serve> | Serve flags, `http://127.0.0.1`-only proxy targets, daemon TLS termination, Service behavior |
| R5 | Repository files: `flake.nix`, `overlays/{default,agentmemory}.nix`, `home-manager/common/agentmemory.nix`, `configurations/fabro-vm/{default,tailscale,opencode}.nix`, `tests/agentmemory-opencode/*` | Existing overlay, consumer, unit, and check patterns |
| R6 | Local reproduction in this repository's Nix sandbox (`aarch64-linux`) | Packaging recipe, engine runtime behavior, worker tarball layout |

## Engine release facts (R1, R6)

- Release tag `iii/v0.26.0`, display name `iii 0.26.0`, published 2026-11-09.
- Per-target tarballs, each containing exactly one file named `iii` with mode
  `0755`:

| Target | Asset | Size (bytes) | SHA-256 | Inner file |
|--------|-------|--------------|---------|------------|
| `aarch64-linux` | `iii-aarch64-unknown-linux-gnu.tar.gz` | 12,387,390 | `e2ee44d1eb38f0e337d3e77b3b8601da26ff1bd934cc8a4c849b9bcf414ab40b` | `iii` |
| `aarch64-darwin` | `iii-aarch64-apple-darwin.tar.gz` | 11,945,450 | `2730296a08ae5843757b2e7913ad65b6282901c98b951dbc23018e0eb425e285` | `iii` |

- The release publishes a `.sha256` sidecar per asset; both digests above match
  the sidecars and a fresh download.
- The release also carries `x86_64` Linux (gnu and musl), `x86_64`/`aarch64`
  Darwin, Windows, and `armv7` assets. Only the two targets above are in scope.
- Linux assets are dynamically linked against `libc.so.6`, `libm.so.6`, and
  `libgcc_s.so.1`, with the ELF interpreter `/lib/ld-linux-aarch64.so.1` (R6).
  That path does not exist on NixOS, so the Linux package must patch the
  interpreter.

## Worker registry facts (R2, R6)

- The registry API is `https://api.workers.iii.dev`:
  - `GET /w` lists workers with `pagination.next_cursor` (page size 20).
  - `GET /w/<name>/versions` returns version entries; each entry carries
    `version`, tags, and `binaries.<target>.{url, sha256}`.
  - Artifact URLs live on `https://cdn.iii.cloud/workers/<name>/<version>/<asset>`.
- The `iii-hq/workers` GitHub releases attach no assets (verified: three most
  recent releases have empty asset lists); the registry CDN is the only
  per-target distribution path.
- Snapshot on 2026-11-16: 93 registry workers in total, 89 authored by `iii`.
  Of the 89 official entries: 76 `binary`, 8 `bundle`, 4 `engine`, and 1
  `executable`. The 4 non-official entries are bundles (`audit-log`,
  `hello-node`, `hello-python`, `tabstack`).
- 73 of the 76 official binary workers publish both
  `aarch64-unknown-linux-gnu` and `aarch64-apple-darwin`. The 3 exceptions:
  - `harness-e2e`: `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`
  - `voice`: `x86_64-apple-darwin`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`
  - `ios-simulator`: `x86_64-apple-darwin`, `aarch64-apple-darwin`
- The 8 official bundles are `claude-code`, `cursor`, `onboarding`,
  `opencode`, `opengantry`, `openwiki`, `pi`, and `vscode`.
- The 4 official engine entries are `configuration`, `iii-observability`,
  `iii-sandbox`, and `iii-worker-manager`.
- The only official `executable` entry is `registry-cli`.
- 89 = 73 cataloged + 8 bundles + 3 single-target binaries + 1 executable +
  4 engine entries.
- The registry API exposes no engine-compatibility field on a worker or a
  version; the manifest's `engine` value is the catalog's own declaration of
  the engine release it was recorded against.
- All 146 cataloged artifacts (73 workers x 2 targets) were downloaded and
  verified on 2026-11-16: every digest matched `/w/<name>/versions`, every
  tarball contained exactly one regular file, and the Linux and Darwin inner
  names agreed for every worker. The inner name equals the worker name for 72
  workers; `acp` installs `iii-acp`.

### Catalog snapshot (73 workers)

URLs are `https://cdn.iii.cloud/workers/<worker>/<version>/<asset>`; the
`sha256` columns are the registry digests and were re-verified against the
downloaded bytes.

| Worker | Version | Executable | Linux asset | Linux SHA-256 | Darwin asset | Darwin SHA-256 |
|--------|---------|------------|-------------|---------------|--------------|----------------|
| `a2ui` | 0.2.2 | `a2ui` | `a2ui-aarch64-unknown-linux-gnu.tar.gz` | `56b5f01b39385eaaf8be8aaa8be802b66a45f265835b8efd712080e94b2b37e4` | `a2ui-aarch64-apple-darwin.tar.gz` | `cd1ffd11ffc688352a494f63668ae1c7c0d57628b7f22aaa907694db5bcb0394` |
| `acp` | 0.4.3 | `iii-acp` | `acp-iii-acp-aarch64-unknown-linux-gnu.tar.gz` | `7dd3fab731ca7cfd3221e2a71cb3655f631bcf26ab6b413e0d6c433d7fafe827` | `acp-iii-acp-aarch64-apple-darwin.tar.gz` | `e209a688b001e42d3545af72b0bf5083cc8c9834a9c73b20bce188413fbc37e0` |
| `ade` | 1.10.7 | `ade` | `ade-aarch64-unknown-linux-gnu.tar.gz` | `026a07a847198008bdf3b5d8d5a90b5305a796ce6101ada45aa533fb8a29b368` | `ade-aarch64-apple-darwin.tar.gz` | `3ea064756ad62352b999505a70079b7c0d1cee8a53463bd0063a9f62038982e0` |
| `approval-gate` | 1.1.3 | `approval-gate` | `approval-gate-aarch64-unknown-linux-gnu.tar.gz` | `a2ede5638d3c0dc23409c170bd922627ff099727fb6ebf2c3bcf354243f3383c` | `approval-gate-aarch64-apple-darwin.tar.gz` | `86ee577ea07d7e1a87cd73af0ce0daae330298853f19057e04b364efce5e3a82` |
| `bridge` | 0.2.2 | `bridge` | `bridge-aarch64-unknown-linux-gnu.tar.gz` | `36080687923f9036d07cf3af6654a1d8bb57688367dcd2f6e22a41c8bbe71e11` | `bridge-aarch64-apple-darwin.tar.gz` | `1fe4cbe8da6169f2f633afa45939cc6320b96e34b4cb488f2f20e56219ad0f6a` |
| `browser` | 0.3.4 | `browser` | `browser-aarch64-unknown-linux-gnu.tar.gz` | `959d82509b4754f09f7dd6cf34edf99de5e132dbadba54b6cf87f16a7b4e0daf` | `browser-aarch64-apple-darwin.tar.gz` | `da29e70ac777e5e1a255f8f03ba5204ced5c55a67e6d346a1221c9a8ce1f694f` |
| `canvas` | 0.2.1 | `canvas` | `canvas-aarch64-unknown-linux-gnu.tar.gz` | `db45c37e04291789f38785ad8b93774621d596739c96ecbc45b243c9576a38ab` | `canvas-aarch64-apple-darwin.tar.gz` | `bab388a28d3d7165b0c0208581a8178646fcd8efcf59449c3c07751178cdc21c` |
| `code-runner` | 0.2.2 | `code-runner` | `code-runner-aarch64-unknown-linux-gnu.tar.gz` | `727a3be12c357f433429a4aa033e3305aa580666901a59e76a477fdc81caee8f` | `code-runner-aarch64-apple-darwin.tar.gz` | `aa588fe4ace6ebd0c7bf1afefa233494f6c5d595d8df97ccbb24493f1fdfe946` |
| `codex` | 0.2.1 | `codex` | `codex-aarch64-unknown-linux-gnu.tar.gz` | `defaa9dd436747aab6bfcc6f4aa6c9f420987da7a2f3ad23568e3b102e44d2e7` | `codex-aarch64-apple-darwin.tar.gz` | `09577c10c89ffcee9dba7ac903f48d8121869a42cce2de447d7801259a475da8` |
| `compose-ui` | 0.1.9 | `compose-ui` | `compose-ui-aarch64-unknown-linux-gnu.tar.gz` | `362a7a3689e27edf5e30f06119607c33d0a5da510b5601e18f89af99069f6e32` | `compose-ui-aarch64-apple-darwin.tar.gz` | `54e6c335eb2bdf542ff2538d97965f0acb81347b3948e577fa2cbd2d23d09ec8` |
| `computer` | 0.2.3 | `computer` | `computer-aarch64-unknown-linux-gnu.tar.gz` | `693b5723f01e5bf000e967e40983a969478617fae16e3830ae2758083fcc3266` | `computer-aarch64-apple-darwin.tar.gz` | `71dcbd36c604f22b1754b19ea72fe4c6d1524f44fc28b90a105cf56a9e1bae35` |
| `context-manager` | 1.2.3 | `context-manager` | `context-manager-aarch64-unknown-linux-gnu.tar.gz` | `2761c06d526f6a6c0af32df1dcbdc23feaeb425340913ef13eea684515401fb7` | `context-manager-aarch64-apple-darwin.tar.gz` | `84bc6a2d52804c57080fbbc82be2f7149cb459723e91e9dc071cae1e388926d3` |
| `cron` | 0.22.1 | `cron` | `cron-aarch64-unknown-linux-gnu.tar.gz` | `90b598dce51dc0603739c5e83e9d78fd6529382e2525995715ca3f92d59c0bba` | `cron-aarch64-apple-darwin.tar.gz` | `8c74731376cdbc423bdc31813c52069cd1f8580543de1ad1f43079178f1ea006` |
| `database` | 0.6.3 | `database` | `database-aarch64-unknown-linux-gnu.tar.gz` | `245f4e61f5ef80f4b0c20ee3e15892b5ee5c9265c3dccbba9e9c9a5fdba271a4` | `database-aarch64-apple-darwin.tar.gz` | `9be61b0080ab458a082919c8eb9d966c0abf7390667ea95c0438d19aaf585f25` |
| `document` | 0.2.1 | `document` | `document-aarch64-unknown-linux-gnu.tar.gz` | `dad2a8fae588db49c6d01bbb88dc63ae7d1372f79da9ef22a1f46862ddc0623a` | `document-aarch64-apple-darwin.tar.gz` | `79a6775eb87d7fd056be7f610e83d4966774d72387ce53c3006158ee3bfdc15d` |
| `email` | 0.2.1 | `email` | `email-aarch64-unknown-linux-gnu.tar.gz` | `883cc101c76338ce2996b02fab31526e8f9f48870c722961bcfabb9566460f78` | `email-aarch64-apple-darwin.tar.gz` | `0a04df9b03892890da3166bc358546ee0f30a0f530a5e83046aeab482ac63ece` |
| `eval` | 0.3.4 | `eval` | `eval-aarch64-unknown-linux-gnu.tar.gz` | `889ff0e559d488f59ef5d22fba195d072b7bc1274b719fa347ca2a83c832adb5` | `eval-aarch64-apple-darwin.tar.gz` | `1b2332148e3ffdd794775c8a8d15634747bea216d91286697eb0f735e103af2e` |
| `fp` | 0.3.1 | `fp` | `fp-aarch64-unknown-linux-gnu.tar.gz` | `caf07ec16d69b298b563723be39844f2db370878548daffca5ec1081cbc8777d` | `fp-aarch64-apple-darwin.tar.gz` | `6c5e7ff7ba71297c2bb4dc57578ae14a7b84958e1c29f8899977efc6af736c7a` |
| `github` | 0.5.3 | `github` | `github-aarch64-unknown-linux-gnu.tar.gz` | `e082ff4e31d7613f6fa6917e3c4ac0ea76ee21340a5b12aa05dde17f67fa4b24` | `github-aarch64-apple-darwin.tar.gz` | `ca443caa2049f49e507a540ca65c2df3170e3e91f4eb06879b258357410a4a9c` |
| `harness` | 1.9.9 | `harness` | `harness-aarch64-unknown-linux-gnu.tar.gz` | `78ee21f0e671007ea61bf6379d0a5a0fae82ddbbc4b54303ae4095dbe4a3fa5f` | `harness-aarch64-apple-darwin.tar.gz` | `f7730288864b352c7c42f06698b1c2a59189612a759289fab195c081a66dd5bc` |
| `http` | 0.23.3 | `http` | `http-aarch64-unknown-linux-gnu.tar.gz` | `37b6caa3c750d0bb4469d86f21bb638ab09c18310dc0f6c8824cedbdc6744bb2` | `http-aarch64-apple-darwin.tar.gz` | `474832680acd7e17597defc85cf44ae83e0fcd66efba795708e3b49e4d4d836e` |
| `ide` | 0.13.5 | `ide` | `ide-aarch64-unknown-linux-gnu.tar.gz` | `0f96798030b305cbb36ec8cec2533065ddcf9df6baa741c3aca9d7b5e7eeefdd` | `ide-aarch64-apple-darwin.tar.gz` | `ca62dd468e27ba4733dcc4b69c05ad43c63e42e69dd5fbb407de0fc79728074a` |
| `iii-directory` | 1.3.5 | `iii-directory` | `iii-directory-aarch64-unknown-linux-gnu.tar.gz` | `e05a9835583d912c2996c97fdb6761d8670010ce138ed78defc9ea4b4372d720` | `iii-directory-aarch64-apple-darwin.tar.gz` | `ee815b9451b01789d22009ea44360b1f94d42eecadd37654c61c3dc90f659012` |
| `image-resize` | 0.2.1 | `image-resize` | `image-resize-aarch64-unknown-linux-gnu.tar.gz` | `981a8acfec1fe137d0bf1927c563f155ba9c056cf1230adb767d372c65da1125` | `image-resize-aarch64-apple-darwin.tar.gz` | `799f2bd2db4034e0e0f207371b4b399838642ae5c95ddbe86cba6372955e734c` |
| `judge` | 0.3.3 | `judge` | `judge-aarch64-unknown-linux-gnu.tar.gz` | `ceaf3c074b0dfb1acd5ae4316bbca3b2c1c73d2e50e9fadea5faa05e0476592e` | `judge-aarch64-apple-darwin.tar.gz` | `b80ef1c2be0c703bc093e8ca1af82307493801133c41a6c5191f8ee35b90390c` |
| `judge-clef` | 0.3.2 | `judge-clef` | `judge-clef-aarch64-unknown-linux-gnu.tar.gz` | `898b0b85ef9a63d456cee950770e8006601ac90b7048f8abd1a4409e4a637958` | `judge-clef-aarch64-apple-darwin.tar.gz` | `ba4cc811ca823bdce7375824d70b8b55729dc92697edc452e6d732ca0871aa95` |
| `judge-decider` | 0.3.2 | `judge-decider` | `judge-decider-aarch64-unknown-linux-gnu.tar.gz` | `7fb40358ed648c773ef194640f7f35fb5ce07f677884cadfdc3bb3e89ae7c893` | `judge-decider-aarch64-apple-darwin.tar.gz` | `ef985971e93de6a6b164d4aef19b63f25523738dfc735f0e2ab48f1a1e4c9307` |
| `judge-laya` | 0.3.2 | `judge-laya` | `judge-laya-aarch64-unknown-linux-gnu.tar.gz` | `24e0113a226407caff96da0c218fe28371a9db246ffc09cdbcc8d60d75150377` | `judge-laya-aarch64-apple-darwin.tar.gz` | `9a161f093fffc42f75fe773a2927653bdc6ab9660a5f74e15e08a0bd3be180d1` |
| `judge-openai` | 0.3.2 | `judge-openai` | `judge-openai-aarch64-unknown-linux-gnu.tar.gz` | `bd990b558631259aec0657a306a06f7fd7969c3c57980c10b4aed37bf5549e02` | `judge-openai-aarch64-apple-darwin.tar.gz` | `506e5980e5e1b2c0090e606265b5e76b9522b329c09710afc793c9d8cb12df17` |
| `judge-semif` | 0.3.2 | `judge-semif` | `judge-semif-aarch64-unknown-linux-gnu.tar.gz` | `7cb37ee0e42fc6f54123aaf116d14e35df17abeb5dc2834ab03472608e6074ac` | `judge-semif-aarch64-apple-darwin.tar.gz` | `a7724a8d59d8274d8e81290c156aee9f01f3265d56c7c3ec865e361f3cf77436` |
| `judge-typesafe` | 0.3.2 | `judge-typesafe` | `judge-typesafe-aarch64-unknown-linux-gnu.tar.gz` | `947ec464de3363d574be830ef92597c043635cc0d6ec34d572342225ec3736f0` | `judge-typesafe-aarch64-apple-darwin.tar.gz` | `ebc8d6a4c3965da19017cb732b1c38eec67e59fe271e3f237502e73f796f9c24` |
| `kanban` | 0.2.2 | `kanban` | `kanban-aarch64-unknown-linux-gnu.tar.gz` | `e1ee82817b3b2a24d57234e57fe7ae2e6492bbc8a005f24d5677e67617c40f17` | `kanban-aarch64-apple-darwin.tar.gz` | `ce052c2712b052badd2fa96c759c100444bbbe8fd27778057c4b3ae1e692bf8b` |
| `llm-router` | 1.5.3 | `llm-router` | `llm-router-aarch64-unknown-linux-gnu.tar.gz` | `2742722dad733f9d6ab94218f2aa654a3ba15dbb6e60fb37f0ffa07e91990434` | `llm-router-aarch64-apple-darwin.tar.gz` | `43fb53133a9be4628fd40feb5f3a85b6f52529b51338133726b34ae043bb6670` |
| `lsp` | 0.2.0 | `lsp` | `lsp-aarch64-unknown-linux-gnu.tar.gz` | `af076a6a7186aa19f974eba6d266f23276c6d395b612804d3729eb6b713509fd` | `lsp-aarch64-apple-darwin.tar.gz` | `b515a149921d1de2857f8a5ddc8374f205eafa8dfaf8ea388288b8dce2e115aa` |
| `mcp` | 0.5.9 | `mcp` | `mcp-aarch64-unknown-linux-gnu.tar.gz` | `6e0bbdc0674a8dcbfe3a4a59a26bba7972352d111f0e3cc75716f8e5719c29fa` | `mcp-aarch64-apple-darwin.tar.gz` | `0175db5a8358d1daeb58180c3b6b97788dacd1a24bafe677569f9a40a7942942` |
| `memory` | 0.3.4 | `memory` | `memory-aarch64-unknown-linux-gnu.tar.gz` | `f028b3da861ebd0f7c2cf7185a92b457835309ce58b3fc316720e68bf4371f04` | `memory-aarch64-apple-darwin.tar.gz` | `106b5bb2d5122a8d10d63dcff454554fec5dabd9569e352d41934d8557c78211` |
| `memory-consolidate` | 0.2.3 | `memory-consolidate` | `memory-consolidate-aarch64-unknown-linux-gnu.tar.gz` | `58b8cfc3ca0e105d7fd87bd21e9c8efc5007ed927febabbc13c69c5cae5c29fa` | `memory-consolidate-aarch64-apple-darwin.tar.gz` | `fa3eba354a9c6b7eddd0b41ea3eeb30ea697e2a078eab4e8de190e59e32fd9aa` |
| `mesh` | 0.3.2 | `mesh` | `mesh-aarch64-unknown-linux-gnu.tar.gz` | `384755ce70cfeb9967d3ceec5195b869bfb0d29458cfdd63dfec272588983008` | `mesh-aarch64-apple-darwin.tar.gz` | `f34602a91f7dd36c12b5ebbb1fc489a2e3248f33ab653098ca0423f48aa79431` |
| `pdf` | 0.2.2 | `pdf` | `pdf-aarch64-unknown-linux-gnu.tar.gz` | `386112a1c2e948a4d8b200057dc9b6ae4d844d7997a36772c6570f3d1d9ccd8f` | `pdf-aarch64-apple-darwin.tar.gz` | `cd3616bdf641a0e372c11a4e32affa4410347fee7c21c544c223bfb48406951c` |
| `provider-anthropic` | 1.3.2 | `provider-anthropic` | `provider-anthropic-aarch64-unknown-linux-gnu.tar.gz` | `1b47183d27fca1af6085fb0db13fc509959472e01ede5c929d3639fb649cdb56` | `provider-anthropic-aarch64-apple-darwin.tar.gz` | `e7e2b6a6b1ba9b37ec5cbd96f2a26c2d12c8cc29c09a76eb589b104a9eedf9bd` |
| `provider-claude-code` | 0.2.4 | `provider-claude-code` | `provider-claude-code-aarch64-unknown-linux-gnu.tar.gz` | `222b0149ed78628940561813b1ac206f99eb3b7d20ce6166feb30971d2391222` | `provider-claude-code-aarch64-apple-darwin.tar.gz` | `03e5dea2380a42d201c32a43acdfc90cd74656d0848952b1a34e37732d0bcc8e` |
| `provider-command-code` | 0.2.0 | `provider-command-code` | `provider-command-code-aarch64-unknown-linux-gnu.tar.gz` | `3f79df23af5ebb9ffc02fd524fad32968c526bb15e3282e55f7d6b8131c63e5a` | `provider-command-code-aarch64-apple-darwin.tar.gz` | `dc43dc853709d2c446ce6fc494f2440e63b8f7325379a51697439aa200d2f53d` |
| `provider-deepseek` | 0.2.0 | `provider-deepseek` | `provider-deepseek-aarch64-unknown-linux-gnu.tar.gz` | `bfd5b72f8e01cc7cdc6f4fa1d47519dfbdcae11f8885d87f3642ef958da3d913` | `provider-deepseek-aarch64-apple-darwin.tar.gz` | `9052a750e8293632a8479ca2261d8600e54c26e1371a0094247924c59e7ae956` |
| `provider-elevenlabs` | 0.2.0 | `provider-elevenlabs` | `provider-elevenlabs-aarch64-unknown-linux-gnu.tar.gz` | `09f1bafedc804fe197fa438bc13408efe32d98232541ce3e24420e9e9eadc5ad` | `provider-elevenlabs-aarch64-apple-darwin.tar.gz` | `603ab7797fcab2dc417b083b02f3f010c891f9047e1b3d87eb5dbb12fdc2ad51` |
| `provider-github-copilot` | 0.2.0 | `provider-github-copilot` | `provider-github-copilot-aarch64-unknown-linux-gnu.tar.gz` | `5357beeecc756e37dfb1d0f5c4fc3e3f81762460d7f3165cf477afb96970b36e` | `provider-github-copilot-aarch64-apple-darwin.tar.gz` | `9e8846efe7746fd25b5c4fc6d3ad1156b26134718ab71488809fc8c515fc4afd` |
| `provider-kimi` | 1.2.1 | `provider-kimi` | `provider-kimi-aarch64-unknown-linux-gnu.tar.gz` | `5218487bf9661d02dc2bf0c8e2d4356a2a46d3ad7158d6d90471579970d1d9ba` | `provider-kimi-aarch64-apple-darwin.tar.gz` | `d8180c1e8673b2fa38f164bfbe7d9ae3e88e02aa678aa46d72942cf6c7fa7311` |
| `provider-llamacpp` | 0.4.1 | `provider-llamacpp` | `provider-llamacpp-aarch64-unknown-linux-gnu.tar.gz` | `b6919dee852d250daa00b1e2da5270fb069c81b25c95f3fa80a5306d5bb7e1aa` | `provider-llamacpp-aarch64-apple-darwin.tar.gz` | `992fe88c97ad6298fe7917e1987a8f82de3d3e9afb16779d888dc64eb8117b4e` |
| `provider-openai` | 1.3.1 | `provider-openai` | `provider-openai-aarch64-unknown-linux-gnu.tar.gz` | `2b1c0eadab75f382b11788cfb56261e401e4758af677fd66780840e50a2242ab` | `provider-openai-aarch64-apple-darwin.tar.gz` | `cb79427b4a38c3f6eb07196ae0a4a52ab9074fad664142d3c23a1a932e604aa5` |
| `provider-openai-codex` | 0.5.1 | `provider-openai-codex` | `provider-openai-codex-aarch64-unknown-linux-gnu.tar.gz` | `87df276b23e4d22574eb2bb5d859980cf8d908c774541c2d1328a198f12755a6` | `provider-openai-codex-aarch64-apple-darwin.tar.gz` | `8d51348f9190c0caa17057928d63e5b56062332269600c63ec4370d156718c49` |
| `provider-opencode-go` | 0.1.0 | `provider-opencode-go` | `provider-opencode-go-aarch64-unknown-linux-gnu.tar.gz` | `36e62f232608e3cc546d45952d170da05e7a8bc60aba604031f73b60ee08be4c` | `provider-opencode-go-aarch64-apple-darwin.tar.gz` | `38e1bbc39249dd8a3efad4bcbf7b2082ff3402dd9844015b2e1decf9ca7919db` |
| `provider-openrouter` | 0.2.0 | `provider-openrouter` | `provider-openrouter-aarch64-unknown-linux-gnu.tar.gz` | `8870351c65e4886df9902ac7abcf5b161b6c12c28e237cd2befaf8fb59eb9682` | `provider-openrouter-aarch64-apple-darwin.tar.gz` | `c836ef1a8e044e581f7d85bd0037de723ba6a0b07b2b626cbbe37d3732917339` |
| `provider-sarvam` | 0.2.0 | `provider-sarvam` | `provider-sarvam-aarch64-unknown-linux-gnu.tar.gz` | `f66c82c71d39679d36f61663048e51ce9b2e33847101d7fd1f66215accaa5f80` | `provider-sarvam-aarch64-apple-darwin.tar.gz` | `631c12e6cb82ad1a7f2957dee1f95f155f76c042ee91e0877d42e9233f3c02eb` |
| `provider-xai` | 1.4.2 | `provider-xai` | `provider-xai-aarch64-unknown-linux-gnu.tar.gz` | `2616e58b775b0e395b980cec47e28b84094161396b4c0601bf245813dce4a2be` | `provider-xai-aarch64-apple-darwin.tar.gz` | `2f817ba07a073379fb52b6a52c3d74109f2418f52ac38ceb96169763f3dd52d2` |
| `provider-zai` | 0.6.0 | `provider-zai` | `provider-zai-aarch64-unknown-linux-gnu.tar.gz` | `2c355f529fc19b317fad8362be95c4d59e725cef978b40a40ff58d90b94499d7` | `provider-zai-aarch64-apple-darwin.tar.gz` | `b4ae0e8748a7ec5cdd2257eebc95f8475ff65f95efbd12dfc52c12ae39c2cf0c` |
| `queue` | 0.22.2 | `queue` | `queue-aarch64-unknown-linux-gnu.tar.gz` | `0eb97866b954c3d21aadf6eac7223ba2ba33ce202a45abc21d5713072a63be60` | `queue-aarch64-apple-darwin.tar.gz` | `246eb416a9179ed0762c36fa157a37e013eae98d5f54017af21ea29260ce8263` |
| `quick-tunnel` | 0.2.4 | `quick-tunnel` | `quick-tunnel-aarch64-unknown-linux-gnu.tar.gz` | `32b53b8aea91142be5fcabb0a95f24863d0cfd51169f857853f0f02b6818937a` | `quick-tunnel-aarch64-apple-darwin.tar.gz` | `8e1a7f37e6f12372f2173c78439a4a3520d08c5bd9eafa92015b440decf00ee0` |
| `rbac-proxy` | 1.1.5 | `rbac-proxy` | `rbac-proxy-aarch64-unknown-linux-gnu.tar.gz` | `aa41e67aa814dbfe877661cbce6d851f44d53acc89910084a3c9df3e3efd9a96` | `rbac-proxy-aarch64-apple-darwin.tar.gz` | `07fbd16319848a2365bf20af2cd684b00e52338eac5eb2a233a625187abeb9cd` |
| `sandbox-libkrun` | 0.4.3 | `sandbox-libkrun` | `sandbox-libkrun-aarch64-unknown-linux-gnu.tar.gz` | `4ebadd09193e64b9029c664eeb42acd21ae0bda98a6cc8519cf7e8349a44578d` | `sandbox-libkrun-aarch64-apple-darwin.tar.gz` | `0bdb050a50ac668b026569bddeebdd0c6bb5c03cc1f96d02c15ec675a952a6a0` |
| `secrets` | 0.2.2 | `secrets` | `secrets-aarch64-unknown-linux-gnu.tar.gz` | `c045c3565e78f8f4375c9a0d203c401de948e35807354c6f024cea3831ef16e8` | `secrets-aarch64-apple-darwin.tar.gz` | `5230800be324915605760c5c3d9d6ceac68710f3a5ac93a9e95b3c77fd3683f5` |
| `security-scan` | 0.2.4 | `security-scan` | `security-scan-aarch64-unknown-linux-gnu.tar.gz` | `3600fd05f3ce24960f0454e4f12ade20832af979dfdf03e658b90b40b9cf108b` | `security-scan-aarch64-apple-darwin.tar.gz` | `eaf8edf5a04e842b1bf7a7eedbdd149ce897b6a11b29bfa25fac961099c41b5c` |
| `sentinel` | 0.2.5 | `sentinel` | `sentinel-aarch64-unknown-linux-gnu.tar.gz` | `d94a1d247dd99096f832e12d6e81b48f7bec6dc1f1423f69f09e6278ae274801` | `sentinel-aarch64-apple-darwin.tar.gz` | `2a7556c8a36449d9827d0eb7407561388409e90ac5b35d9baa755c4880ebbe8f` |
| `session-manager` | 1.1.1 | `session-manager` | `session-manager-aarch64-unknown-linux-gnu.tar.gz` | `cbae17e37e8bfea141aa506c3446baa4e76e15bd13c3a8cb691369418310a32c` | `session-manager-aarch64-apple-darwin.tar.gz` | `ea8037761e26c45f8248981f481c9dd0e6430ca75fb3ec9a7f9377dec9a7d506` |
| `slack` | 0.2.1 | `slack` | `slack-aarch64-unknown-linux-gnu.tar.gz` | `6c740d6519f9e5a9a283d9ac5ef8c74b7ae724f60b7bada4cc565361d6de3625` | `slack-aarch64-apple-darwin.tar.gz` | `80755d8f8ba0b737cc5f25db1688c3398dc5d3c7dd4d5d314d8e44caa1d8e8b0` |
| `state` | 0.23.1 | `state` | `state-aarch64-unknown-linux-gnu.tar.gz` | `7c1d648e81b5f41c8d7200c1090db36c040bd0df1f71aa6870225c3a83a52a7e` | `state-aarch64-apple-darwin.tar.gz` | `9420e8186be0335e584d6de23d8d9da2376283371c536447fc9a439d98adfd4e` |
| `storage` | 0.2.3 | `storage` | `storage-aarch64-unknown-linux-gnu.tar.gz` | `7538b238cc763e3cd5633091eceae0240f21a14d94185fb636c82e7d49eb4827` | `storage-aarch64-apple-darwin.tar.gz` | `6d5447ac2a1bbb5a791a4a953f0ae403de9a9fb76a64ac05401254a26fdf8ff9` |
| `stories` | 0.2.1 | `stories` | `stories-aarch64-unknown-linux-gnu.tar.gz` | `afeea71dd49e0dae989730b0db3ff718b9b396aa7f365806c971827c1a3e34fd` | `stories-aarch64-apple-darwin.tar.gz` | `22a1159cf4b9012ac862f900196e1e4442ef0dbdc8543b7c2c6ce4f2e445e971` |
| `tailscale` | 0.2.1 | `tailscale` | `tailscale-aarch64-unknown-linux-gnu.tar.gz` | `b5f1f7ab79ca79464b81cd521bcf73f2a8bee06ea22aa3a9b8617217effda348` | `tailscale-aarch64-apple-darwin.tar.gz` | `8f9c33a52ffcb2813901457e5d688f1158ef8823fbf5b835ffbf4ba832a8df40` |
| `telegram-bot` | 0.4.3 | `telegram-bot` | `telegram-bot-aarch64-unknown-linux-gnu.tar.gz` | `f22599a42b15d944ce20087a3d814c91aff2374a44ff857251b33c9fb36ff139` | `telegram-bot-aarch64-apple-darwin.tar.gz` | `2ba677fe81ac0b75a5d8379a8f183c998b4a642021386b6608eafb510331cc96` |
| `tmux` | 0.2.9 | `tmux` | `tmux-aarch64-unknown-linux-gnu.tar.gz` | `a6f2ab35ac210cd6dbfd2b653e182f1ec977290e51280979a0b506b7fdfbcbfa` | `tmux-aarch64-apple-darwin.tar.gz` | `9b0660095eb644ce6bf20f745f6c44099c3fc89b307c4c67948f4c706883828e` |
| `web` | 1.3.1 | `web` | `web-aarch64-unknown-linux-gnu.tar.gz` | `cd273ac326196602a83b13f110104db270051b541df1b1ad16a4d3abd94d7613` | `web-aarch64-apple-darwin.tar.gz` | `ab8aa526dba47ab9ba8b7b3be81790fa646d30c3e6805abbf70d39680e6ae96d` |
| `whatsapp` | 0.3.2 | `whatsapp` | `whatsapp-aarch64-unknown-linux-gnu.tar.gz` | `9332e1c8beb3d42ae8800a82e08820217120ce03abc05a96fa47fe8a74c4fcf2` | `whatsapp-aarch64-apple-darwin.tar.gz` | `47c43ea9316471a66021ac0fc66d854fff9fa2f9a390a1167186a4fa495d3631` |
| `workflow` | 0.3.0 | `workflow` | `workflow-aarch64-unknown-linux-gnu.tar.gz` | `295ac35210e4e172156a8b1a2be98e9f5364c1c676500886a4a539fe9b117da6` | `workflow-aarch64-apple-darwin.tar.gz` | `437c5dec8e0fa5e497870e12a782d3020f963d62197119200e3f9b51381ed26f` |
| `worktree` | 0.4.3 | `worktree` | `worktree-aarch64-unknown-linux-gnu.tar.gz` | `473a61e6a26ea36b9528c8088636d9b8803300337cbf5c17f8ac914f7aeb375d` | `worktree-aarch64-apple-darwin.tar.gz` | `f90aa935338455bedf09b5c34523be84695ee6286338362da49a92e19baafe23` |

## iii 0.26.0 engine behavior (R3, R6)

- Root CLI (R3 `engine/src/main.rs`): `-c/--config <path>` (default
  `config.yaml`), `-v/--version` (prints the bare `CARGO_PKG_VERSION`),
  `--no-update-check`. With no subcommand the process serves the engine.
- `--version` output is exactly `0.26.0` (verified by running the packaged
  binary under Nix, R6).
- `EngineConfig` (R3 `engine/src/workers/config.rs`) is strict
  (`deny_unknown_fields`) with `workers` and `modules` lists, optional
  `observers`, `sandbox`, and `registration_namespace_grace_ms`.
- Any entry in `workers`/`modules` that is not a configurable engine worker
  aborts startup with
  `[UNSUPPORTED_CONFIG_WORKERS] Workers in config.yaml are no longer supported`
  plus migration guidance (R3).
- `CONFIGURABLE_ENGINE_WORKERS` is `configuration`, `iii-worker-manager`,
  `iii-http-functions`, `iii-stream` (R3 `crates/iii-compose/src/config.rs`).
  Project workers are rejected in `config.yaml` and belong in
  `worker-compose.yaml`.
- Boot injects only workers registered `mandatory`; it does not start every
  `is_default` worker. Six workers are mandatory: `configuration`,
  `iii-engine-functions`, `iii-observability`, `iii-sandbox`, `iii-telemetry`,
  and `iii-worker-manager`. A file config with `workers: []` starts exactly
  those six and no project worker (R6 run confirmed six).
- `iii-stream` is registered `enabled_by_default = true` but is not mandatory,
  so an explicit file config that omits it does not start it. Its default bind
  is `0.0.0.0:3112`, so leaving it out is also what keeps the engine to one
  listener (R3, R6).
- `WorkerManagerConfig` (R3 `engine/src/workers/worker/mod.rs`) accepts
  `host` (default `0.0.0.0`), `port` (default `49134`),
  `middleware_function_id`, `rbac`, and `handshake_timeout_ms`; it binds
  `TcpListener::bind("{host}:{port}")`. The worker manager is mandatory, so
  declaring it in `workers:` only overrides its config; omitting it yields the
  wildcard default.
- `iii-sandbox` is mandatory and stays unbound when `sandbox.adapter` is
  absent; it opens no listener (R3). `iii-observability` uses in-memory
  exporters and registers functions only; it opens no listener (R3).
- With the one-entry loopback config (R6): the process logged
  `Engine listening on address: 127.0.0.1:49134`; `/proc/net/tcp` showed only
  local address `0100007F` (127.0.0.1) on port 49134 and `/proc/net/tcp6` had
  no entry; `iii call engine::workers::list` returned six workers, all with
  `"runtime": "engine"` and `"isolation": "in-process"`.
- The configuration worker's fs adapter defaults to `./config` relative to the
  process working directory (`DEFAULT_DIRECTORY` in
  `engine/src/workers/configuration/adapters/fs.rs`), and the legacy
  `./data/configuration` is migrated once. The run wrote
  `<cwd>/config/iii-observability.yaml`.
- The engine watches the config file's parent directory, non-recursively, and
  reloads only when the configured path itself changes (R3). A store-path
  config therefore adds one inert watch on `/nix/store`.
- A worker that seeds a `config:` block has that block stripped from the file
  by `config_rewrite.rs`; a failed write is logged and swallowed, so a
  read-only store config never fails boot (R3).
- Anonymous telemetry is on by default:
  `Anonymous telemetry enabled. Set III_TELEMETRY_ENABLED=false to disable.`
  Telemetry state lives under `dirs::home_dir()/.iii` (R3, R6).
- `engine::workers::list` returns connected SDK workers plus in-process runtime
  workers; runtime workers carry `"runtime": "engine"` (R3, R6).

## Packaging behavior (R6)

- A `stdenvNoCC.mkDerivation` with `dontUnpack = true`, `tar -xzf` into
  `$out/bin`, `dontStrip = true`, `autoPatchelfHook`, and
  `buildInputs = [ stdenv.cc.cc.lib ]` builds the Linux engine, and the
  resulting `bin/iii --version` prints `0.26.0` under Nix.
- `dontFixup = true` skips the fixup phase, so `autoPatchelfHook` never runs
  and the binary keeps the missing `/lib/ld-linux-aarch64.so.1` interpreter
  (verified failure). Linux needs fixup enabled plus `dontStrip`; Darwin needs
  `dontFixup` (no ELF patching, and stripping release binaries is undesirable).
- The same recipe builds worker tarballs; the generated `bin/state` and
  `bin/iii-acp` binaries execute (`state --help`, `iii-acp --help`).
- The same interpreter and `DT_NEEDED` set (`libc.so.6`, `libm.so.6`,
  `libgcc_s.so.1`) appear in the sampled worker binaries (`database`, `state`,
  `a2ui`, `acp`); they are the same glibc-target Rust build shape.
- `fetchurl` accepts the registry's lowercase hex SHA-256 verbatim in
  `sha256`, so the manifest can store the registry value without a base64
  conversion.

## Tailscale Serve facts (R4)

- `tailscale serve --service=<svc> --https=<port> <target>` advertises the
  handler for an admin-console Service; with a Service it runs in the
  background by default, and the guest re-applies it on every boot.
- Targets may be a port, `localhost:<port>`, or a full URL, and "only
  `http://127.0.0.1` is supported for proxies".
- "By default, the device's Tailscale daemon terminates the HTTPS connection",
  so the loopback upstream stays plaintext.
- The existing guest unit (`configurations/fabro-vm/tailscale.nix`) applies one
  `serve` invocation per Service as a `Type=oneshot` with
  `Restart=on-failure`; later invocations run only after earlier ones succeed.

## Repository facts (R5)

- `overlays/agentmemory.nix` exports `iii-engine` (iii 0.11.5) from GitHub
  release tarballs for `aarch64-darwin` and `x86_64-darwin`, and throws
  `Unsupported iii-engine system: <system>` elsewhere.
- Consumers of that attribute are `home-manager/common/agentmemory.nix:20`
  (`runtimeInputs`) and `flake.nix:1854` (the `agentmemory-opencode-matrix`
  check's `nativeBuildInputs`).
- `tests/agentmemory-opencode/package-contract.test.js` and
  `validation-suite.test.js` assert the overlay's text and the
  `pkgs.iii-engine` attribute; `docs/dead-nix-cleanup-ledger.md` records the
  old export.
- `configurations/fabro-vm/opencode.nix` is the guest's DynamicUser template:
  `StateDirectory`, `WorkingDirectory` under `/var/lib`, `ProtectSystem =
  "strict"`, `Restart = "on-failure"`, `RestartSec = 5`, and no static user.
- `configurations/fabro-vm/tailscale.nix` currently emits exactly three
  `ExecStart` lines, and `flake.nix:2755-2767` asserts a length of three plus
  each exact handler string.
- The guest installs its CLI surface through
  `environment.systemPackages` in `configurations/fabro-vm/default.nix`, and
  `flake.nix`'s `fabro-vm-guest-eval` asserts package membership by `pname`.
