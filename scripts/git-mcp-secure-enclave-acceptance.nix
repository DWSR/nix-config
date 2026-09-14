{
  adminPackage ? null,
  coreutils,
  curl,
  git,
  gnugrep,
  jq,
  lib,
  mcpproxy-go,
  writeShellApplication,
  ...
}:

let
  runtimeInputs = [
    coreutils
    curl
    git
    gnugrep
    jq
    mcpproxy-go
  ]
  ++ lib.optional (adminPackage != null) adminPackage;
in
writeShellApplication {
  name = "git-mcp-secure-enclave-acceptance";
  inherit runtimeInputs;
  text = ''
    usage() {
      cat >&2 <<'USAGE'
    Usage:
      git-mcp-secure-enclave-acceptance init --repo PATH
      git-mcp-secure-enclave-acceptance probe --repo PATH --state STATE [options]
      git-mcp-secure-enclave-acceptance show [--evidence PATH]
      git-mcp-secure-enclave-acceptance record [--repo PATH] [--evidence PATH] --github-verified

    States:
      unlocked, locked, sleep, reboot, github

    Probe options:
      --message MESSAGE       Commit message (defaults to an acceptance message)
      --health-url URL        mcpproxy health endpoint
      --evidence PATH         Public probe evidence file
      --dry-run               Print the git-mcp request without committing

    The probe command calls mcpproxy's git-mcp:git_commit tool directly. It does
    not start OpenCode and never creates a local commit as a fallback.
    USAGE
    }

    die() {
      printf '[git-mcp-secure-enclave-acceptance] %s\n' "$*" >&2
      exit 1
    }

    command_name="''${1:-}"
    if [[ -z "$command_name" ]]; then
      usage
      exit 64
    fi
    shift

    repo=""
    state=""
    message=""
    health_url="''${GIT_MCP_ACCEPTANCE_HEALTH_URL:-}"
    health_url_overridden=0
    if [[ -n "$health_url" ]]; then
      health_url_overridden=1
    fi
    evidence=""
    dry_run=0
    github_verified=0

    while (( $# > 0 )); do
      case "$1" in
        --repo)
          [[ $# -ge 2 ]] || die '--repo requires a path'
          repo="$2"
          shift 2
          ;;
        --state)
          [[ $# -ge 2 ]] || die '--state requires a value'
          state="$2"
          shift 2
          ;;
        --message)
          [[ $# -ge 2 ]] || die '--message requires a value'
          message="$2"
          shift 2
          ;;
        --health-url)
          [[ $# -ge 2 ]] || die '--health-url requires a URL'
          health_url="$2"
          shift 2
          ;;
        --evidence)
          [[ $# -ge 2 ]] || die '--evidence requires a path'
          evidence="$2"
          shift 2
          ;;
        --github-verified)
          github_verified=1
          shift
          ;;
        --dry-run)
          dry_run=1
          shift
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        *)
          die "unknown argument: $1"
          ;;
      esac
    done

    case "$command_name" in
      init|probe|show|record)
        ;;
      *)
        usage
        exit 64
        ;;
    esac

    if [[ "$command_name" == "init" ]]; then
      [[ -n "$repo" ]] || die 'init requires --repo'
      mkdir -p -- "$repo" || die "cannot create repository directory $repo"
      git init --initial-branch=main "$repo" >/dev/null \
        || die "cannot initialize repository $repo"
      repo="$(cd "$repo" && pwd -P)"
      printf 'initialized acceptance repository: %s\n' "$repo"
      printf '%s\n' 'No commit was created; probe commits are sent through git-mcp.'
      exit 0
    fi

    active_marker="''${XDG_CONFIG_HOME:-$HOME/.config}/git-mcp-secure-enclave-signing/active.json"
    [[ -r "$active_marker" ]] \
      || die "active enrollment marker is missing: $active_marker"

    if ! jq -e '
      (.stateDir | type == "string")
      and (.identityLabel | type == "string")
      and (.ctkPublicKeyHash | type == "string")
      and (.sshPublicKey | type == "string")
      and (.sshFingerprint | type == "string")
      and (.githubSigningKeyRegistered == true)
    ' "$active_marker" >/dev/null; then
      die "active enrollment marker is incomplete or not registered: $active_marker"
    fi

    enrollment_hash="$(jq -er '.ctkPublicKeyHash' "$active_marker")"
    enrollment_label="$(jq -er '.identityLabel' "$active_marker")"
    enrollment_public_key="$(jq -er '.sshPublicKey' "$active_marker")"
    enrollment_fingerprint="$(jq -er '.sshFingerprint' "$active_marker")"
    state_dir="$(jq -er '.stateDir' "$active_marker")"

    if [[ -z "$evidence" ]]; then
      evidence="''${XDG_STATE_HOME:-$HOME/.local/state}/git-mcp-secure-enclave-signing/acceptance-probes/$enrollment_hash.json"
    fi

    if [[ "$command_name" == "show" ]]; then
      [[ -r "$evidence" ]] || die "probe evidence is missing: $evidence"
      jq . "$evidence"
      exit 0
    fi

    if [[ "$command_name" == "record" ]]; then
      [[ "$github_verified" == 1 ]] \
        || die 'record requires explicit --github-verified confirmation'
      [[ -r "$evidence" ]] || die "probe evidence is missing: $evidence"
      [[ -n "$repo" ]] || repo="$(jq -er '.repo' "$evidence")"
      [[ -d "$repo" ]] || die "acceptance repository is missing: $repo"
      repo="$(cd "$repo" && pwd -P)"

      if ! probe_values="$(jq -er --arg hash "$enrollment_hash" '
        if .ctkPublicKeyHash != $hash then
          error("probe evidence belongs to another enrollment")
        elif ([.probes.unlocked.commit, .probes.locked.commit, .probes.sleep.commit,
          .probes.reboot.commit, .probes.github.commit] | all(type == "string"))
          and ([.probes.unlocked.result, .probes.locked.result, .probes.sleep.result,
            .probes.reboot.result, .probes.github.result] | all(. == "verified"))
        then
          [.probes.unlocked.commit, .probes.locked.commit, .probes.sleep.commit,
            .probes.reboot.commit, .probes.github.commit] | @tsv
        else
          error("all five verified probe commits are required")
        end
      ' "$evidence")"; then
        die 'evidence must contain five verified, distinct probe commits'
      fi
      IFS=$'\t' read -r unlocked_commit locked_commit sleep_commit reboot_commit github_commit <<< "$probe_values"
      if ! jq -e --argjson commits "$(printf '%s\n' "$unlocked_commit" "$locked_commit" "$sleep_commit" "$reboot_commit" "$github_commit" | jq -Rsc 'split("\n")[:-1]')" \
        '$commits | unique | length == 5' >/dev/null; then
        die 'probe commits must be distinct'
      fi
      command -v git-mcp-secure-enclave-admin >/dev/null \
        || die 'git-mcp-secure-enclave-admin is not installed'
      record_timeout="''${GIT_MCP_ACCEPTANCE_RECORD_TIMEOUT:-120s}"
      if ! (
        cd "$repo"
        timeout --foreground --signal=TERM --kill-after=5s "$record_timeout" \
          git-mcp-secure-enclave-admin record-acceptance \
            --hash "$enrollment_hash" \
            --unlocked-commit "$unlocked_commit" \
            --locked-commit "$locked_commit" \
            --sleep-commit "$sleep_commit" \
            --reboot-commit "$reboot_commit" \
            --github-commit "$github_commit" \
            --github-verified < /dev/null
      ); then
        die "record-acceptance failed or timed out after $record_timeout; no evidence was installed"
      fi
      exit 0
    fi

    [[ "$command_name" == "probe" ]] || die "unsupported command: $command_name"
    [[ -n "$repo" ]] || die 'probe requires --repo'
    [[ -n "$state" ]] || die 'probe requires --state'
    case "$state" in
      unlocked|locked|sleep|reboot|github)
        ;;
      *)
        die "invalid probe state: $state"
        ;;
    esac
    [[ -d "$repo" ]] || die "acceptance repository is missing: $repo"
    repo="$(cd "$repo" && pwd -P)"
    repo_root="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" \
      || die "$repo is not a Git repository"
    repo="$(cd "$repo_root" && pwd -P)"

    [[ -f "$state_dir/identities/$enrollment_hash/id_ecdsa_sk_rk" ]] \
      || die "resident stub is missing for enrollment $enrollment_hash"
    [[ -f "$state_dir/identities/$enrollment_hash/id_ecdsa_sk_rk.pub" ]] \
      || die "resident public key is missing for enrollment $enrollment_hash"

    if [[ -e "$evidence" ]] && ! jq -e --arg hash "$enrollment_hash" \
      '.ctkPublicKeyHash == $hash' "$evidence" >/dev/null; then
      die "probe evidence belongs to another enrollment: $evidence"
    fi
    if [[ -e "$evidence" ]] && jq -e --arg state "$state" \
      '.probes[$state] != null' "$evidence" >/dev/null; then
      die "probe state has already been recorded: $state"
    fi

    author_name="$(git -C "$repo" config --get user.name 2>/dev/null)" \
      || die 'Git author name is not configured for the acceptance repository'
    author_email="$(git -C "$repo" config --get user.email 2>/dev/null)" \
      || die 'Git author email is not configured for the acceptance repository'
    [[ -n "$author_name" && -n "$author_email" ]] \
      || die 'Git author name and email must both be configured'

    if ! git -C "$repo" diff --cached --quiet; then
      staged_files="$(git -C "$repo" diff --cached --name-only)"
      die "repository has pre-staged files; refusing to let git-mcp commit them: $staged_files"
    fi

    runtime_config="''${GIT_MCP_ACCEPTANCE_MCP_CONFIG:-$HOME/.mcpproxy/runtime-config/mcp_config.json}"
    [[ -r "$runtime_config" ]] \
      || die "mcpproxy runtime configuration is missing: $runtime_config"
    stub_path="$state_dir/identities/$enrollment_hash/id_ecdsa_sk_rk"
    if ! jq -e \
      --arg hash "$enrollment_hash" \
      --arg public_key "$enrollment_public_key" \
      --arg fingerprint "$enrollment_fingerprint" \
      --arg stub "$stub_path" '
      any(.mcpServers[]?;
        .name == "git-mcp"
        and .env.GIT_SIGN_COMMITS == "true"
        and .env.GIT_CONFIG_COUNT == "4"
        and .env.GIT_CONFIG_KEY_0 == "commit.gpgSign"
        and .env.GIT_CONFIG_VALUE_0 == "true"
        and .env.GIT_CONFIG_KEY_1 == "gpg.format"
        and .env.GIT_CONFIG_VALUE_1 == "ssh"
        and .env.GIT_CONFIG_KEY_2 == "gpg.ssh.program"
        and (.env.GIT_CONFIG_VALUE_2 | type == "string")
        and ((.env.GIT_CONFIG_VALUE_2 // "") | endswith("/bin/git-mcp-secure-enclave-signer"))
        and .env.GIT_CONFIG_KEY_3 == "user.signingKey"
        and .env.GIT_CONFIG_VALUE_3 == $stub
        and .env.SSH_SK_PROVIDER == "/usr/lib/ssh-keychain.dylib"
        and .env.KEYCHAIN_CERTIFICATES == $hash
        and .env.GIT_MCP_SIGNING_CTK_HASH == $hash
        and .env.GIT_MCP_SIGNING_PUBLIC_KEY == $public_key
        and .env.GIT_MCP_SIGNING_FINGERPRINT == $fingerprint
        and .env.GIT_MCP_SIGNING_STUB == $stub
        and .env.MCP_SESSION_MODE == "stateless"
        and .env.STORAGE_PROVIDER_TYPE == "in-memory"
        and ((.env | has("SSH_AUTH_SOCK")) | not)
      )
    ' "$runtime_config" >/dev/null; then
      die "mcpproxy runtime configuration does not contain the active git-mcp signing environment"
    fi
    if [[ "$health_url_overridden" == 0 ]]; then
      listen_address="$(jq -er '.listen' "$runtime_config")" \
        || die "mcpproxy runtime configuration has no listen address: $runtime_config"
      health_url="http://$listen_address/healthz"
    fi
    health_response="$(curl --fail --silent --show-error --max-time 5 "$health_url" 2>&1)" \
      || die "mcpproxy health check failed at $health_url: $health_response"

    probe_file_committed=0
    proxy_data_dir=""
    cleanup_probe() {
      if [[ "$probe_file_committed" == 0 && -n "''${probe_file:-}" && -e "$probe_file" ]]; then
        observed_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
        if [[ -n "$observed_head" ]] \
          && git -C "$repo" diff-tree --root --no-commit-id --name-only -r "$observed_head" \
            | grep -Fx -- "$relative_file" >/dev/null; then
          probe_file_committed=1
        fi
      fi
      if [[ "$probe_file_committed" == 0 && -n "''${probe_file:-}" ]]; then
        git -C "$repo" reset --quiet -- "$relative_file" 2>/dev/null \
          || git -C "$repo" restore --staged -- "$relative_file" 2>/dev/null \
          || true
        if [[ -e "$probe_file" ]]; then
          rm -f -- "$probe_file"
          rmdir --ignore-fail-on-non-empty "$probe_dir" 2>/dev/null || true
        fi
      fi
      if [[ -n "''${proxy_data_dir:-}" && -d "$proxy_data_dir" ]]; then
        rm -rf -- "$proxy_data_dir"
      fi
    }
    trap cleanup_probe EXIT

    probe_dir="$repo/.git-mcp-secure-enclave-acceptance"
    relative_file=".git-mcp-secure-enclave-acceptance/$state.txt"
    probe_file="$repo/$relative_file"
    [[ ! -e "$probe_file" ]] \
      || die "probe content already exists; preserve one distinct content change per state: $probe_file"
    mkdir -p -- "$probe_dir"
    printf '%s\n' \
      'git-mcp Secure Enclave acceptance probe' \
      "state=$state" \
      "identity=$enrollment_hash" \
      "fingerprint=$enrollment_fingerprint" \
      > "$probe_file"

    if [[ -z "$message" ]]; then
      message="test(git-mcp): secure enclave acceptance $state"
    fi

    json_args="$(jq -cn \
      --arg path "$repo" \
      --arg message "$message" \
      --arg file "$relative_file" \
      '{path: $path, message: $message, filesToStage: [$file]}')"

    if [[ "$dry_run" == 1 ]]; then
      jq -n \
        --arg tool 'git-mcp:git_commit' \
        --argjson args "$json_args" \
        '{tool: $tool, args: $args, repo: $args.path, state: $args.filesToStage[0]}'
      rm -f -- "$probe_file"
      rmdir --ignore-fail-on-non-empty "$probe_dir" 2>/dev/null || true
      exit 0
    fi

    before_head="$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)"
    proxy_data_dir="$(mktemp -d "''${TMPDIR:-/tmp}/git-mcp-acceptance-proxy.XXXXXX")" \
      || die 'cannot create standalone mcpproxy data directory'
    if ! mcp_response="$(mcpproxy \
      --data-dir "$proxy_data_dir" \
      call tool-write \
      --config "$runtime_config" \
      --tool-name=git-mcp:git_commit \
      --json_args="$json_args" \
      --output=json \
      --reason='Run a standalone git-mcp Secure Enclave acceptance commit.' \
      --sensitivity=internal \
      --timeout=75s 2>&1)"; then
      printf '%s\n' "$mcp_response" >&2
      die 'git-mcp commit failed; no local Git fallback was attempted'
    fi
    commit="$(git -C "$repo" rev-parse HEAD 2>/dev/null)" \
      || die 'git-mcp returned success but HEAD cannot be read'
    [[ "$commit" != "$before_head" ]] \
      || die 'git-mcp returned success without creating a new commit'
    probe_file_committed=1

    if ! committed_files="$(git -C "$repo" diff-tree --root --no-commit-id --name-only -r "$commit")" \
      || [[ "$committed_files" != "$relative_file" ]]; then
      die "git-mcp commit $commit contained unexpected files: $committed_files"
    fi

    allowed_signers="$(mktemp "''${TMPDIR:-/tmp}/git-mcp-acceptance-signers.XXXXXX")" \
      || die 'cannot create temporary allowed-signers file'
    cleanup() {
      cleanup_probe
      if [[ -n "''${allowed_signers:-}" ]]; then
        rm -f -- "$allowed_signers"
      fi
    }
    trap cleanup EXIT
    printf '%s namespaces="git" %s\n' "$enrollment_label" "$enrollment_public_key" > "$allowed_signers"

    verify_output=""
    if ! verify_output="$(git -C "$repo" \
      -c gpg.format=ssh \
      -c gpg.ssh.program=/usr/bin/ssh-keygen \
      -c gpg.ssh.allowedSignersFile="$allowed_signers" \
      verify-commit --raw "$commit" 2>&1)"; then
      printf '%s\n' "$verify_output" >&2
      die "commit $commit is not a valid SSH signature from the enrolled identity"
    fi

    actual_author="$(git -C "$repo" show -s --format='%an <%ae>' "$commit")"
    expected_author="$author_name <$author_email>"
    [[ "$actual_author" == "$expected_author" ]] \
      || die "commit author mismatch: expected $expected_author, observed $actual_author"

    curl --fail --silent --show-error --max-time 5 "$health_url" >/dev/null \
      || die "mcpproxy health check failed after commit $commit"

    evidence_dir="''${evidence%/*}"
    if [[ "$evidence_dir" == "$evidence" ]]; then
      evidence_dir="."
    fi
    mkdir -p -- "$evidence_dir"
    chmod 700 -- "$evidence_dir"
    existing='{}'
    if [[ -e "$evidence" ]]; then
      existing="$(jq -ce . "$evidence")" \
        || die "probe evidence is not valid JSON: $evidence"
    fi
    host_name="$(/usr/sbin/scutil --get ComputerName 2>/dev/null || hostname)"
    macos_version="$(/usr/bin/sw_vers -productVersion 2>/dev/null || printf '%s' unknown)"
    recorded_at="$(git -C "$repo" show -s --format=%cI "$commit")"
    updated="$(jq -cn \
      --argjson existing "$existing" \
      --arg host "$host_name" \
      --arg macos_version "$macos_version" \
      --arg repo "$repo" \
      --arg hash "$enrollment_hash" \
      --arg label "$enrollment_label" \
      --arg public_key "$enrollment_public_key" \
      --arg fingerprint "$enrollment_fingerprint" \
      --arg author_name "$author_name" \
      --arg author_email "$author_email" \
      --arg state "$state" \
      --arg commit "$commit" \
      --arg recorded_at "$recorded_at" \
      '$existing
       | if (.ctkPublicKeyHash // $hash) != $hash then
           error("probe evidence belongs to another enrollment")
         else . end
       | .schemaVersion = 1
       | .host = $host
       | .macOSVersion = $macos_version
       | .repo = $repo
       | .ctkPublicKeyHash = $hash
       | .identityLabel = $label
       | .sshPublicKey = $public_key
       | .sshFingerprint = $fingerprint
       | .author = {name: $author_name, email: $author_email}
       | .probes = ((.probes // {}) + {($state): {commit: $commit, result: "verified", recordedAt: $recorded_at}})')" \
      || die 'cannot construct probe evidence'
    evidence_tmp="$(mktemp "$evidence_dir/.acceptance-probe.XXXXXX")" \
      || die "cannot create temporary evidence file in $evidence_dir"
    printf '%s\n' "$updated" > "$evidence_tmp"
    chmod 600 -- "$evidence_tmp"
    mv -f -- "$evidence_tmp" "$evidence"

    printf 'probe: state=%s commit=%s fingerprint=%s\n' \
      "$state" "$commit" "$enrollment_fingerprint"
    printf 'evidence: %s\n' "$evidence"
    printf '%s\n' 'The commit was created by git-mcp through mcpproxy; no local commit fallback was used.'
  '';
}
