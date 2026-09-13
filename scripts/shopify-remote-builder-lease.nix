{
  lib,
  writeShellApplication,
  coreutils,
  jq,
  stateDirectory ? "/var/db/shopify-remote-builder/requests",
  ownerUid ? 502,
  rootAdderExecutable ? "/run/current-system/sw/bin/nix-store",
  maxRequestBytes ? 1024 * 1024,
  maxPaths ? 10000,
}:

assert lib.isString stateDirectory;
assert stateDirectory != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" stateDirectory != null;
assert lib.isInt ownerUid;
assert ownerUid >= 0;
assert lib.isString rootAdderExecutable;
assert rootAdderExecutable != "";
assert builtins.match "/[A-Za-z0-9._/+-]+" rootAdderExecutable != null;
assert lib.isInt maxRequestBytes;
assert maxRequestBytes > 0;
assert lib.isInt maxPaths;
assert maxPaths > 0;
let
  coreutilsBin = "${coreutils}/bin";
  jqExecutable = "${jq}/bin/jq";
in
writeShellApplication {
  name = "shopify-remote-builder-lease";
  runtimeInputs = [
    coreutils
    jq
  ];
  excludeShellChecks = [
    "SC2016"
    "SC2329"
  ];
  text = ''
    export LC_ALL=C
    umask 077
    set -o pipefail

    chmod_command=${lib.escapeShellArg "${coreutilsBin}/chmod"}
    cut=${lib.escapeShellArg "${coreutilsBin}/cut"}
    head=${lib.escapeShellArg "${coreutilsBin}/head"}
    id_command=${lib.escapeShellArg "${coreutilsBin}/id"}
    jq=${lib.escapeShellArg jqExecutable}
    mkdir=${lib.escapeShellArg "${coreutilsBin}/mkdir"}
    mktemp=${lib.escapeShellArg "${coreutilsBin}/mktemp"}
    mv=${lib.escapeShellArg "${coreutilsBin}/mv"}
    readlink=${lib.escapeShellArg "${coreutilsBin}/readlink"}
    realpath=${lib.escapeShellArg "${coreutilsBin}/realpath"}
    rm=${lib.escapeShellArg "${coreutilsBin}/rm"}
    sha256sum=${lib.escapeShellArg "${coreutilsBin}/sha256sum"}
    stat=${lib.escapeShellArg "${coreutilsBin}/stat"}
    wc=${lib.escapeShellArg "${coreutilsBin}/wc"}

    owner_uid=${toString ownerUid}
    root_adder=${lib.escapeShellArg rootAdderExecutable}
    state_directory=${lib.escapeShellArg stateDirectory}
    max_request_bytes=${toString maxRequestBytes}
    max_paths=${toString maxPaths}

    temporary_root=""
    request_file=""
    normalized_request_file=""
    rooted_paths_file=""
    request_root=""
    created_request_root=false
    keep_request_root=false

    emit_failure() {
      local decision="$1"
      local reason="$2"
      local detail="$3"
      "$jq" -n -cS \
        --arg decision "$decision" \
        --arg reason "$reason" \
        --arg detail "$detail" \
        '{
          schemaVersion: 1,
          operation: "create",
          decision: $decision,
          reason: $reason,
          nonce: null,
          leaseToken: null,
          detail: $detail
        }'
    }

    emit_success() {
      "$jq" -n -cS --slurpfile request "$normalized_request_file" \
        '($request[0]) as $value
         | {
             schemaVersion: 1,
             operation: "create",
             decision: "created",
             nonce: $value.nonce,
             leaseToken: $value.token,
             graphDigest: $value.graphDigest,
             rootedPaths: $value.rootedPaths,
             selectedInputOutputs: $value.selectedInputOutputs,
             expectedOutputs: $value.expectedOutputs,
             publicCacheCuts: ($value.publicCacheCuts
               | map({ rootPath: .rootPath, closureDigest: .closureDigest })
               | sort_by(.rootPath)),
             detail: null
           }'
    }

    cleanup() {
      local status="$?"
      if [[ "$keep_request_root" != true && "$created_request_root" == true ]]; then
        "$rm" -rf -- "$request_root" 2>/dev/null || true
      fi
      if [[ -n "$temporary_root" ]]; then
        "$rm" -rf -- "$temporary_root" 2>/dev/null || true
      fi
      return "$status"
    }
    trap cleanup EXIT

    if (( $# != 1 )) || [[ "$1" != create ]]; then
      emit_failure ineligible "unsupported operation" "lease operation is not available"
      exit 0
    fi

    current_uid="$($id_command -u 2>/dev/null)" || {
      emit_failure error "authorization failure" "lease ownership could not be verified"
      exit 1
    }
    if [[ "$current_uid" != "$owner_uid" ]]; then
      emit_failure ineligible "authorization failure" "lease ownership was not authorized"
      exit 0
    fi

    canonical_parent="$($realpath "$state_directory" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state parent could not be canonicalized"
      exit 1
    }
    if [[ ! -d "$canonical_parent" || -L "$canonical_parent" ]]; then
      emit_failure error "internal lease failure" "lease state parent is not a directory"
      exit 1
    fi
    parent_mode="$($stat -c '%a' -- "$canonical_parent" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state parent ownership could not be checked"
      exit 1
    }
    parent_owner="$($stat -c '%u' -- "$canonical_parent" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease state parent ownership could not be checked"
      exit 1
    }
    if [[ "$parent_mode" != 700 || "$parent_owner" != "$owner_uid" ]]; then
      emit_failure ineligible "authorization failure" "lease state parent ownership was not authorized"
      exit 0
    fi

    temporary_root="$($mktemp -d "''${TMPDIR:-/tmp}/shopify-remote-builder-lease.XXXXXX" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease request state could not be created"
      exit 1
    }
    request_file="$temporary_root/request.json"
    normalized_request_file="$temporary_root/normalized-request.json"
    rooted_paths_file="$temporary_root/rooted-paths"

    request_read_limit=$((max_request_bytes + 1))
    "$head" -c "$request_read_limit" >"$request_file" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease request could not be read"
      exit 1
    }
    request_bytes="$($wc -c <"$request_file" 2>/dev/null)" || {
      emit_failure error "internal lease failure" "lease request size could not be checked"
      exit 1
    }
    request_bytes="''${request_bytes//[[:space:]]/}"
    if [[ ! "$request_bytes" =~ ^[0-9]+$ ]] || (( request_bytes > max_request_bytes )); then
      emit_failure ineligible "resource limit" "lease request exceeded a validation limit"
      exit 0
    fi

    if ! "$jq" -cS -e -s \
      --arg expectedParent "$canonical_parent" \
      --argjson ownerUid "$owner_uid" \
      --argjson maxPaths "$max_paths" \
      '
        def exact_object($required; $allowed):
          . as $object
          | ($object | type == "object")
          and ((($object | keys) - $allowed) | length) == 0
          and all($required[]; . as $key | ($object | has($key)));
        def valid_digest:
          type == "string" and test("^sha256:[0-9a-f]{64}$");
        def valid_nonce:
          type == "string"
          and utf8bytelength > 0
          and utf8bytelength <= 128
          and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$");
        def valid_token($nonce):
          type == "string"
          and utf8bytelength > 0
          and utf8bytelength <= 256
          and test("^srb1-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[0-9a-f]{64}$")
          and startswith("srb1-" + $nonce + "-");
        def valid_store_path:
          type == "string"
          and utf8bytelength <= 266
          and test("^/nix/store/[a-z0-9]{32}-[A-Za-z0-9._+-]+$");
        def sorted_unique:
          . == (sort | unique);
        def valid_path_array:
          type == "array"
          and sorted_unique
          and all(.[]; valid_store_path);
        def valid_uid:
          type == "number" and isfinite and floor == . and . >= 0;
        if length != 1 then
          error("one request object required")
        else
          .[0] as $request
          | ($request.graph // {}) as $graph
          | ($request.nonce // "") as $nonce
          | ($expectedParent + "/" + $nonce) as $expectedRoot
          | if ($request | exact_object(
              [
                "schemaVersion",
                "operation",
                "nonce",
                "token",
                "requestParent",
                "ownership",
                "authorization",
                "graphDigest",
                "graph",
                "rootedPaths",
                "rootDestinations",
                "selectedInputOutputs",
                "expectedOutputs",
                "publicCacheCuts"
              ];
              [
                "schemaVersion",
                "operation",
                "nonce",
                "token",
                "requestParent",
                "ownership",
                "authorization",
                "graphDigest",
                "graph",
                "rootedPaths",
                "rootDestinations",
                "selectedInputOutputs",
                "expectedOutputs",
                "publicCacheCuts"
              ]
            ) | not)
            or $request.schemaVersion != 1
            or $request.operation != "create"
            or ($nonce | valid_nonce | not)
            or ($request.token | valid_token($nonce) | not)
            or $request.requestParent != $expectedParent
            or ($request.ownership
              | exact_object(["uid"]; ["uid"]) | not)
            or ($request.ownership.uid | valid_uid | not)
            or $request.ownership.uid != $ownerUid
            or ($request.authorization
              | exact_object(["uid", "operation", "channel"]; ["uid", "operation", "channel"]) | not)
            or ($request.authorization.uid | valid_uid | not)
            or $request.authorization.uid != $ownerUid
            or $request.authorization.operation != "create"
            or $request.authorization.channel != "local-pipe"
            or ($request.graphDigest | valid_digest | not)
            or ($graph
              | exact_object(
                ["digest", "paths", "outputPaths", "referenceClosures", "topOutput"];
                ["digest", "paths", "outputPaths", "referenceClosures", "topOutput"]
              ) | not)
            or ($graph.digest | valid_digest | not)
            or $graph.digest != $request.graphDigest
            or ($graph.paths | valid_path_array | not)
            or ($graph.paths | length == 0 or length > $maxPaths)
            or ($graph.outputPaths | valid_path_array | not)
            or ($graph.outputPaths | length == 0)
            or ($graph.topOutput | valid_store_path | not)
            or (($graph.paths | index($graph.topOutput)) == null)
            or (($graph.outputPaths | index($graph.topOutput)) == null)
            or ($graph.outputPaths | any(.[]; . as $path | ($graph.paths | index($path)) == null))
            or ($graph.referenceClosures | type != "object")
            or (($graph.referenceClosures | keys) | any(.[]; valid_store_path | not))
            or ($graph.referenceClosures | to_entries | any(.[];
              . as $entry
              | ($entry.value | valid_path_array | not)
                or (($entry.value | index($entry.key)) == null)
                or ($entry.value | any(.[]; . as $path | ($graph.paths | index($path)) == null))
            ))
            or ($request.rootedPaths | valid_path_array | not)
            or ($request.rootedPaths | length == 0 or length > $maxPaths)
            or ($request.rootedPaths | any(.[]; . as $path | ($graph.paths | index($path)) == null))
            or ($request.selectedInputOutputs | valid_path_array | not)
            or ($request.selectedInputOutputs | length == 0 or length > $maxPaths)
            or ($request.selectedInputOutputs | any(.[];
              . as $path
              | ($graph.outputPaths | index($path)) == null or $path == $graph.topOutput))
            or ($request.expectedOutputs | valid_path_array | not)
            or ($request.expectedOutputs | length == 0 or length > $maxPaths)
            or ($request.expectedOutputs | any(.[]; . as $path | ($graph.outputPaths | index($path)) == null))
            or (($request.expectedOutputs | index($graph.topOutput)) == null)
             or ($request.selectedInputOutputs | any(.[];
               . as $path
               | ($request.rootedPaths | index($path)) == null
             ))
             or ($request.expectedOutputs | any(.[];
               . as $path
               | ($request.rootedPaths | index($path)) == null
             ))
            or ($request.rootDestinations | type != "array")
            or ($request.rootDestinations | length != ($request.rootedPaths | length))
            or ($request.rootDestinations | map(.storePath) != (map(.storePath) | sort | unique))
            or ($request.rootDestinations | any(.[];
              . as $root
              | ($root | exact_object(["storePath", "destination"]; ["storePath", "destination"]) | not)
              or ($root.storePath | valid_store_path | not)
              or (($request.rootedPaths | index($root.storePath)) == null)
              or ($root.destination != ($expectedRoot + "/roots/" + ($root.storePath | split("/") | .[-1])))
            ))
            or ($request.publicCacheCuts | type != "array")
            or ($request.publicCacheCuts | length > $maxPaths)
            or ($request.publicCacheCuts | map(.rootPath) != (map(.rootPath) | sort | unique))
            or ($request.publicCacheCuts | any(.[];
              . as $cut
              | ($cut | exact_object(["rootPath", "closure", "closureDigest"];
                ["rootPath", "closure", "closureDigest"]) | not)
              or ($cut.rootPath | valid_store_path | not)
              or $cut.rootPath == $graph.topOutput
              or (($graph.paths | index($cut.rootPath)) == null)
              or ($cut.closure | valid_path_array | not)
              or ($cut.closureDigest | valid_digest | not)
              or (($graph.referenceClosures[$cut.rootPath] // null) != $cut.closure)
            or ($cut.closure | any(.[]; . as $path | ($request.rootedPaths | index($path)) == null))
            ))
            then
              error("lease request schema rejected")
            else
              $request
            end
        end
      ' "$request_file" >"$normalized_request_file" 2>/dev/null; then
      emit_failure ineligible "schema drift" "lease request rejected"
      exit 0
    fi

    nonce="$($jq -r '.nonce' "$normalized_request_file")"
    request_root="$canonical_parent/$nonce"
    if [[ -e "$request_root" || -L "$request_root" ]]; then
      emit_failure ineligible "lease state exists" "lease request state already exists"
      exit 0
    fi

    if ! "$jq" -r '.rootedPaths[]' "$normalized_request_file" >"$rooted_paths_file" 2>/dev/null; then
      emit_failure error "internal lease failure" "lease paths could not be materialized"
      exit 1
    fi

    cut_validation_failed=false
    while IFS= read -r cut_record; do
      closure_json="$($jq -cS '.closure' <<<"$cut_record" 2>/dev/null)" || {
        cut_validation_failed=true
        break
      }
      closure_hash="$(printf '%s' "$closure_json" | "$sha256sum" 2>/dev/null | "$cut" -d ' ' -f 1)" || {
        cut_validation_failed=true
        break
      }
      expected_closure_digest="sha256:$closure_hash"
      actual_closure_digest="$($jq -r '.closureDigest' <<<"$cut_record" 2>/dev/null)" || {
        cut_validation_failed=true
        break
      }
      if [[ "$actual_closure_digest" != "$expected_closure_digest" ]]; then
        cut_validation_failed=true
        break
      fi
    done < <("$jq" -c '.publicCacheCuts[]' "$normalized_request_file" 2>/dev/null)
    if [[ "$cut_validation_failed" == true ]]; then
      emit_failure ineligible "cache cut mismatch" "lease request rejected"
      exit 0
    fi

    if ! "$mkdir" -- "$request_root" 2>/dev/null; then
      emit_failure ineligible "lease state exists" "lease request state already exists"
      exit 0
    fi
    created_request_root=true
    "$chmod_command" 700 -- "$request_root" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease request state could not be secured"
      exit 1
    }
    roots_directory="$request_root/roots"
    "$mkdir" -- "$roots_directory" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease root directory could not be created"
      exit 1
    }
    "$chmod_command" 700 -- "$roots_directory" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease root directory could not be secured"
      exit 1
    }

    root_operation_failed=false
    while IFS= read -r store_path; do
      root_marker="$roots_directory/''${store_path##*/}"
      if [[ -L "$roots_directory" || "$root_marker" != "$roots_directory/"* ]]; then
        root_operation_failed=true
        break
      fi
      if ! "$root_adder" --add-root "$root_marker" --indirect "$store_path" \
        >/dev/null 2>/dev/null; then
        root_operation_failed=true
        break
      fi
      link_target="$($readlink "$root_marker" 2>/dev/null)" || {
        root_operation_failed=true
        break
      }
      if [[ "$link_target" != "$store_path" ]]; then
        root_operation_failed=true
        break
      fi
    done <"$rooted_paths_file"
    if [[ "$root_operation_failed" == true ]]; then
      emit_failure error "root operation failed" "lease roots could not be created"
      exit 1
    fi

    manifest_tmp="$request_root/manifest.json.tmp"
    if ! "$jq" -cS '.' "$normalized_request_file" >"$manifest_tmp" 2>/dev/null; then
      emit_failure error "internal lease failure" "lease manifest could not be written"
      exit 1
    fi
    "$chmod_command" 600 -- "$manifest_tmp" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease manifest could not be secured"
      exit 1
    }
    "$mv" -- "$manifest_tmp" "$request_root/manifest.json" 2>/dev/null || {
      emit_failure error "internal lease failure" "lease manifest could not be committed"
      exit 1
    }

    keep_request_root=true
    emit_success
    exit 0
  '';
}
