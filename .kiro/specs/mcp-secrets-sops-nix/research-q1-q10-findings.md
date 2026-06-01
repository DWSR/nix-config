# Research: Q1–Q10 findings (sops-nix on nix-darwin)

Written 2026-05-11. Citations link to upstream sources at `Mic92/sops-nix` master and to gh CLI / gh docs.

## Q1 — sops-nix nix-darwin module: import path & option surface

**Import path.** Both `inputs.sops-nix.darwinModules.default` and `inputs.sops-nix.darwinModules.sops` work — they are aliases for `./modules/nix-darwin`. From `flake.nix:62-65`:

```nix
darwinModules = {
  sops = ./modules/nix-darwin;
  default = self.darwinModules.sops;
};
```

The README documents `sops-nix.darwinModules.default` as the canonical form.

**Option surface (Darwin-specific, from `modules/nix-darwin/default.nix`).** The Darwin module re-declares its own `secretType` (does NOT share NixOS's), with these notable differences:

| Option | Type | Default on Darwin |
|---|---|---|
| `sops.defaultSopsFile` | path | required |
| `sops.defaultSopsFormat` | str | `"yaml"` |
| `sops.age.keyFile` | nullOr pathNotInStore | `null` |
| `sops.age.generateKey` | bool | `false` |
| `sops.age.sshKeyPaths` | list of paths | `["/etc/ssh/ssh_host_ed25519_key"]` (filtered to existing entries from a hardcoded `darwinSSHKeys` list) |
| `sops.age.plugins` | list of pkgs | `[]` |
| `sops.gnupg.home` | nullOr str | `null` |
| `sops.gnupg.sshKeyPaths` | list of paths | `["/etc/ssh/ssh_host_rsa_key"]` |
| `sops.secrets.<name>.key` | str | secret's attr name |
| `sops.secrets.<name>.path` | str | `/run/secrets/<name>` (or `/run/secrets-for-users/<name>` if `neededForUsers`) |
| `sops.secrets.<name>.format` | enum yaml/json/binary/dotenv/ini | `defaultSopsFormat` |
| `sops.secrets.<name>.mode` | str | `"0400"` |
| `sops.secrets.<name>.owner` | nullOr str | `"root"` ← **differs from NixOS (null)** |
| `sops.secrets.<name>.group` | nullOr str | `"staff"` ← **differs from NixOS (derived from owner)** |
| `sops.secrets.<name>.uid` | nullOr int | `0` |
| `sops.secrets.<name>.gid` | nullOr int | `0` |
| `sops.secrets.<name>.sopsFile` | path | `cfg.defaultSopsFile` |
| `sops.secrets.<name>.neededForUsers` | bool | `false` — **explicitly documented as "no effect on macOS, as nix-darwin cannot manage user passwords"** |

**Not present on Darwin:** `restartUnits`, `reloadUnits`, `useTmpfs`, `useSystemdActivation`, `defaultSopsKey` (these are NixOS-only).

**Per-secret `sopsFile`:** Yes, `sops.secrets.<name>.sopsFile = ./other.yaml` works the same way as on NixOS — the option exists in the Darwin secretType. So you can mix per-host yamls cleanly:

```nix
sops.secrets."mcp-github-token" = { sopsFile = ./secrets/mcp.${hostname}.yaml; };
```

## Q2 — Reading HM config from a nix-darwin system module

**Yes, this works.** When `home-manager.darwinModules.home-manager` is imported at the system level (which the existing `configurations/common-darwin/default.nix:?` already does), `config.home-manager.users.<username>.<...>` is fully evaluatable from any system module under the same `darwinSystem` invocation. There is no infinite recursion as long as the system module reads HM's `home.mcp.keychainSecrets` data and does not re-write the same option.

**Caveat:** a system module that *reads* HM config is fine. A system module that *writes* HM config (e.g., `home-manager.users.${username}.home.mcp.keychainSecrets = ...`) while the HM module also defines a default for the same option will fail with a "merging" or recursion error. As long as your sops-bridge system module is read-only against HM data, you're safe. Cite: nix-darwin / home-manager module-system semantics — both use `lib.evalModules` over a single argset, so options are mutually visible.

**Alternative pattern if the coupling becomes painful:** factor `keychainSecrets` into a *shared* file (`modules/mcp/secrets-data.nix`) imported by both the HM module (which exposes it as user-facing options + the `readKeychainSecret` helper) and the system bridge (which iterates the same attrset). This avoids cross-layer reads entirely. Brief recommends keeping it in HM though.

## Q3 — Age key file location convention on macOS

**There is no Darwin-specific default for `sops.age.keyFile`.** From `modules/nix-darwin/default.nix`:

```nix
age.keyFile = lib.mkOption {
  type = lib.types.nullOr pathNotInStore;
  default = null;
  example = "/var/lib/sops-nix/key.txt";
  ...
};
```

Default is `null`, the example is the NixOS-style path. **You must set it explicitly on Darwin.**

**Recommended path convention.** The README documents (in section 2):

> When using `nix-darwin` save the `age` key to `$HOME/Library/Application Support/sops/age/keys.txt` or set a custom configuration directory.

That guidance applies to raw user-facing SOPS CLI invocations, where `sops` itself searches that path on macOS via `os.UserConfigDir()`. Note: `~/.config/sops/age/keys.txt` is the Linux convention; on macOS sops will look at `~/Library/Application Support/sops/age/keys.txt` instead unless `SOPS_AGE_KEY_FILE` is set. This repo routes operator decrypt/edit/updatekeys commands through the devshell `sops-nix-sudo` wrapper, which sets that variable to `/var/lib/sops-nix/key.txt` under sudo.

**For the sops-nix nix-darwin activation script,** the path is whatever you set in `sops.age.keyFile` — sops-nix passes it explicitly via the manifest's `ageKeyFile`, which `sops-install-secrets` then reads and concatenates into a per-activation keyfile (see `pkgs/sops-install-secrets/main.go` — the "Import age keys" section). It does NOT auto-discover.

**Recommendation for K3:** pick a system-readable absolute path (e.g., `/var/lib/sops-nix/key.txt` or `/etc/sops/age/keys.txt`) and set `sops.age.keyFile = "..."` explicitly. Do not rely on `~/Library/Application Support/...` because activation runs as root and HOME may not be set (the NixOS module explicitly sets `environment.HOME = "/var/empty"` to suppress sops's $HOME warnings — see `modules/sops/default.nix:34-46`). If you want the file in the user's home for ergonomics, expand `${homeDir}/Library/...` at eval time.

## Q4 — `/run/secrets` on macOS

**sops-nix mounts an HFS-on-RAM disk** for the secrets store on Darwin. From `pkgs/sops-install-secrets/darwin.go`:

1. `mkdir -p /run/secrets.d` (the `secretsMountPoint`, hardcoded in `manifest-for.nix`).
2. `hdiutil attach -nomount ram://<sectors>` allocates a 64 MB RAM disk.
3. `newfs_hfs -s /dev/diskN` formats it.
4. `mount -t hfs -o nobrowse,nodev,nosuid,-m=0751 /dev/diskN /run/secrets.d` mounts it.
5. Decrypted secrets are written into a generation directory `/run/secrets.d/<N>/` and `/run/secrets` is atomically symlinked to the latest generation (see `installSecrets` in `main.go`).

**`/run` on macOS:** modern macOS has `/run` available (it's a real directory by default on Big Sur+; was historically a synthetic firmlink). sops-nix does `os.MkdirAll(mountpoint, 0o751)` so it creates `/run/secrets.d` if missing. No `/etc/static/run/secrets` workaround is needed.

**Default permissions on Darwin:**
- Secret files: `0400` mode, owner=`root`, group=`staff` (from the Darwin `secretType` defaults).
- The mount itself: 0751, owner root, group is the `keys` group if it exists else `nogroup` (looked up at runtime via `lookupKeysGroup` — note Darwin doesn't have a `keys` group by default, so it'll fall back to `nogroup`/`nobody`).

## Q5 — gh CLI integration mechanism options

**`gh auth login --with-token` semantics** (per `gh auth login` docs):
- Reads a single token from stdin: `gh auth login --with-token < token.txt`.
- After successful login, **stores the token in the system credential store by default** (macOS Keychain on Darwin, service `gh:github.com`). Falls back to plain text in `~/.config/gh/hosts.yml` only if the keyring isn't available, OR if `--insecure-storage` is passed.
- Modifies `~/.config/gh/hosts.yml` to set `user` and `git_protocol` for the host. The token itself goes to Keychain (not hosts.yml) under recent gh versions.
- **Idempotent on re-runs:** re-invoking with a different token replaces the stored one. No duplication.

**`~/.config/gh/hosts.yml` schema** (per `cli/cli` source `internal/config/migration/multi_account.go`):

```yaml
github.com:
  user: <username>
  git_protocol: https        # or ssh
  oauth_token: <token>       # ONLY when --insecure-storage was used or pre-multi-account migration
  users:
    <username>:
      # if oauth_token is at host level, it gets duplicated here
      oauth_token: <token>   # only if insecure storage
```

The minimum required to satisfy `gh auth status` is `user`, `git_protocol`, and either `oauth_token` (insecure) or a token in keyring under service `gh:github.com` and account `<username>`.

**Third option (env var):** Yes — `GH_TOKEN` and `GITHUB_TOKEN` are read by gh as fallback. From the docs:

> Alternatively, gh will use the authentication token found in environment variables. This method is most suitable for "headless" use of gh such as in automation.

If you set `GH_TOKEN` in the user's shell environment (e.g., via a launchd agent envvar or sourced from a shell rc), gh will use it without `~/.config/gh/hosts.yml` needing to exist. **`gh auth status` does report this as "logged in"**, but `gh auth setup-git` won't auto-configure the git credential helper since there's no persisted login.

**Recommendation (subjective):** the cleanest declarative path is `gh auth login --with-token < /run/secrets/gh-token --hostname github.com`, invoked from the activation script (drop privs to user). It writes both Keychain (token) and hosts.yml (user/git_protocol) idempotently. Avoid hand-writing hosts.yml — gh's hosts.yml format has multi-account migrations and is not a stable contract.

## Q6 — `.sops.yaml` recipient rules on Darwin

**No platform-specific semantics.** `.sops.yaml` is interpreted by the `sops` binary itself (Go), identically on macOS and Linux. sops-nix just passes the encrypted yaml to `decrypt.File()` from `getsops/sops/v3`.

**`path_regex` is regex (Go's `regexp.MatchString`),** not glob. The README example uses `secrets/[^/]+\.(yaml|json|env|ini)$`. Per-host example:

```yaml
keys:
  - &user_brandon age1zzz...                        # your user key (decrypts everything)
  - &host_shopify age1aaa...                        # ShopifyLaptop's age key
  - &host_personal age1bbb...                       # Personal Mac's age key
creation_rules:
  - path_regex: secrets/mcp\.shopify\.yaml$
    key_groups:
      - age:
          - *user_brandon
          - *host_shopify
  - path_regex: secrets/mcp\.personal\.yaml$
    key_groups:
      - age:
          - *user_brandon
          - *host_personal
```

`creation_rules` are evaluated top-to-bottom; first match wins (sops docs). The `key_groups` shape (with hyphen on `age:` only at the first key type) is the no-Shamir form — the README explicitly warns to NOT add `-` before subsequent key types in a group.

## Q7 — Activation script ordering on nix-darwin

**nix-darwin's `system.activationScripts` is a flat attrset of named entries**, each with a `text` field. There is NO `deps = [...]` ordering DAG on Darwin (unlike NixOS, which uses `lib.stringAfter [deps] "..."`). Entries run in a fixed order defined by nix-darwin: `preActivation`, `extraActivation`, `postActivation`, `extraUserActivation`, `userActivation`, etc. — see `nix-darwin/modules/system/activation-scripts.nix`.

**sops-nix's hook on Darwin** (from `modules/nix-darwin/default.nix`, end of `config = lib.mkMerge`):

```nix
system.activationScripts = {
  postActivation.text = lib.mkAfter installScript;
};
```

It appends its install script to the END of the existing `postActivation` step using `lib.mkAfter`. So when you write your own `mcpKeychainSync`, you have two options:

1. **Append further into `postActivation`** with a higher-priority `mkAfter`:
   ```nix
   system.activationScripts.postActivation.text = lib.mkOrder 1500 ''
     # runs after sops-nix's mkAfter (priority 1500 > default mkAfter 1500 — needs care)
   '';
   ```
   This is fragile because both you and sops-nix are stacking text into the same script.

2. **Use a separate named entry that runs after `postActivation`**. nix-darwin's order is hardcoded; `postActivation` runs late. You can add `mcpKeychainSync` as a named attribute and document its position. nix-darwin will run named entries in attrset/source order; on recent versions you can also reuse `extraActivation` / add a custom step that the docs note is "user-defined". Safer pattern:
   ```nix
   system.activationScripts.mcpKeychainSync.text = ''
     # after postActivation has run, secrets exist at /run/secrets/<name>
     ${pkgs.bash}/bin/bash ${./scripts/mcp-keychain-sync.sh}
   '';
   ```

   Empirically, in nix-darwin master (nix-darwin/modules/system/activation-scripts.nix) the activation runner enumerates known entries in a fixed list and ignores unknown attrs unless they're explicitly registered. **Verify by inspecting the rendered `darwin-activate` script** (`darwin-rebuild build` then look at `result/activate`) — this is the only authoritative answer because nix-darwin's set of activation hooks evolves.

**Concrete recommendation:** put your sync logic inside `system.activationScripts.postActivation.text = lib.mkAfter ''...''` of YOUR module, and rely on the fact that within a single `postActivation` script all `mkAfter` blocks are concatenated in module-evaluation order. To guarantee ordering after sops-nix, also add an explicit guard at the top of your script: `[ -e /run/secrets/mcp-github-token ] || { echo "sops-nix didn't run yet"; exit 1; }`. This is defensive but cheap.

## Q8 — Sudo + activation context for `security` CLI

**Activation context.** `darwin-rebuild switch` runs the activation script as root (it `sudo`s itself if invoked as a non-root user). Inside activation, `$USER` is `root`, `$HOME` is `/var/root` (unless overridden).

**Targeting the user's login keychain from root:**

The `security` CLI accepts an absolute keychain path: `security add-generic-password ... /Users/<USERNAME>/Library/Keychains/login.keychain-db`. Root can read/write that file directly (Unix file perms permit it), but **the keychain may be locked**, in which case `security` will either prompt for a password (interactive — fatal in activation) or fail silently with `errSecAuthFailed`.

**Two viable patterns:**

1. **Drop privs to the user via `sudo -u`:**
   ```bash
   sudo -u "$USERNAME" -H security add-generic-password \
     -U -s "mcp-github-token" -a "mcp-hub" -w "$VALUE" \
     "/Users/$USERNAME/Library/Keychains/login.keychain-db"
   ```
   `-H` resets `HOME` so `security` finds the user's keychain search list. This is the recommended Apple pattern for "run as user from root context".

2. **Specify the absolute keychain path AND ensure it's unlocked:** `security unlock-keychain -p "$PASSWORD" /Users/.../login.keychain-db` first. This requires the user's login password — generally NOT available in activation, so this approach is only viable if the user is already logged into their GUI session (the keychain is unlocked at login time).

**Known issue with locked keychains:** if the user is NOT logged into their GUI session (e.g., remote SSH activation, headless reboot), the login keychain is locked and `security add-generic-password` will fail or hang. Apple deliberately locks the login keychain when no GUI session is active. There is no workaround other than:
- requiring the user be logged in for activation, OR
- using a different keychain (e.g., a dedicated `mcp.keychain-db` that's auto-unlocked), OR
- skipping the keychain write when locked (and detecting by querying first).

For this spec's use case (developer workstation, user is always logged in when running `darwin-rebuild switch`), pattern 1 with `sudo -u` is correct. Document the GUI-session prerequisite in `secrets/README.md`.

## Q9 — Disabling the SSH-key-derivation path

**The relationship between `sops.age.keyFile` and `sops.age.sshKeyPaths`** (from `modules/nix-darwin/default.nix` assertion):

```nix
{
  assertion = cfg.gnupg.home != null
           || cfg.gnupg.sshKeyPaths != []
           || cfg.age.keyFile != null
           || cfg.age.sshKeyPaths != [];
  message = "No key source configured for sops...";
}
```

So **at least one** key source must be set. They CAN coexist — `sops-install-secrets` will concatenate the SSH-derived age keys AND the contents of `sops.age.keyFile` into a single per-activation age key file, and `sops` tries each key in turn during decryption (see `main.go` "Import age keys" block).

**To disable SSH-key derivation entirely** (when the host has no `/etc/ssh/ssh_host_ed25519_key`, like ShopifyLaptop):

```nix
sops.age.sshKeyPaths = [];
sops.age.keyFile = "/var/lib/sops-nix/key.txt";  # or wherever the 1P-sourced key lives
```

Setting `sshKeyPaths = []` overrides the default which tries `/etc/ssh/ssh_host_ed25519_key`. If you leave the default and the file doesn't exist, `sops-install-secrets` will print `Cannot read ssh key '/etc/ssh/ssh_host_ed25519_key': ... no such file or directory` and continue (warning, not error) — the decrypt will then succeed via `keyFile` if that key is a valid recipient.

**Recommendation for K3:** explicitly set `sops.age.sshKeyPaths = []` to make the intent clear and avoid the warning. Keep `sops.age.keyFile = "/var/lib/sops-nix/key.txt"` (or chosen path).

## Q10 — Verification gate mechanism

**Recommended one-shot verification script** (sketch):

```bash
#!/usr/bin/env bash
set -euo pipefail
SOPS_FILE="$1"            # secrets/mcp.shopify.yaml (or .personal.yaml)
KEY_FILE="$2"             # /var/lib/sops-nix/key.txt
shopt -s nullglob
fail=0
# Iterate every top-level key in the encrypted yaml
while IFS=$'\t' read -r service expected; do
  actual="$(security find-generic-password -s "$service" -a mcp-hub -w 2>/dev/null || echo MISSING)"
  if [[ "$actual" != "$expected" ]]; then
    printf 'MISMATCH service=%s\n' "$service" >&2
    fail=1
  fi
done < <(SOPS_AGE_KEY_FILE="$KEY_FILE" sops -d --output-type json "$SOPS_FILE" \
           | jq -r 'to_entries[] | select(.key != "sops") | "mcp-\(.key)\t\(.value)"')
exit $fail
```

Logic: decrypt the entire yaml to JSON in memory, walk each `(key, value)` pair, prefix the service name with `mcp-`, query the Keychain, compare. Exit non-zero on any mismatch.

**Single-key sops decryption (no disk write):**

`sops` supports extracting a specific key via `--extract`:

```bash
sops --decrypt --extract '["mcp-github-token"]' secrets/mcp.shopify.yaml
```

This writes the decrypted value to stdout — pipe into `diff <(security find-generic-password -s 'mcp-github-token' -a mcp-hub -w) -`. (Citation: `sops --help` documents `--extract` as "extract a specific key or branch from the input document".)

For bulk verification, prefer `sops -d --output-type json | jq` (single decrypt + parse) over per-key `--extract` (one decrypt per key, slow + repeatedly logs to sops audit).

**Suggested R8.1 gate:** wire this script as `nix run .#mcp-verify-secrets <hostname>` (a flake app under `apps.${system}`), document its exit code semantics in `secrets/README.md`, and require it to exit 0 on both hosts before the second commit removes `mcpSyncSecretsScript`.

---

## Cross-cutting notes

- **`sops-nix` Darwin module also installs a launchd daemon** (`launchd.daemons.sops-install-secrets`) that runs the same install script with `RunAtLoad=true`, `KeepAlive=false`. This means secrets are re-decrypted on boot (the RAM-disk mount doesn't survive reboot), in addition to on every `darwin-rebuild switch`. Source: `modules/nix-darwin/default.nix` end of config.
- **The HM module on macOS has known launchd-agent issues** (sops-nix#801, observed exit code 78 EX_CONFIG, secrets not mounted on boot, only after manual `home-manager switch`). Confirms viability finding to use the system module path.
- **Pre-commit `no-builtins-fetch` and `no-tmp-paths` checks** apply to any new Nix code — `sopsFile = ./secrets/mcp.shopify.yaml` is fine (path literal, not `builtins.fetch*` and not `/tmp/...`).
