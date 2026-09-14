{
  lib,
  writeShellApplication,
  coreutils,
  validatorExecutable ? "/run/current-system/sw/bin/shopify-remote-builder-validator",
  leaseManagerExecutable ? "/run/current-system/sw/bin/shopify-remote-builder-lease",
  nixDaemonExecutable ? "/run/current-system/sw/bin/nix-daemon",
  allowedSourceCidrs ? [
    "10.0.0.0/8"
    "172.16.0.0/12"
    "192.168.0.0/16"
  ],
  expectedSourceAddress ? null,
  expectedSshKey ? null,
  sourceAddressEnvironmentVariable ? "SSH_CONNECTION",
  sshKeyEnvironmentVariable ? "SSH_USER_AUTH",
  originalCommandEnvironmentVariable ? "SSH_ORIGINAL_COMMAND",
}:
let
  boundedDecimal =
    upper: value:
    let
      parsed = builtins.tryEval (builtins.fromJSON value);
    in
    parsed.success && lib.isInt parsed.value && parsed.value >= 0 && parsed.value <= upper;
  executablePath =
    value:
    lib.isString value
    && builtins.match "/[A-Za-z0-9._+,:=@%~-]+(/[A-Za-z0-9._+,:=@%~-]+)*" value != null;
  environmentVariable =
    value: lib.isString value && builtins.match "[A-Za-z_][A-Za-z0-9_]*" value != null;
  ipv4Address =
    value:
    if !lib.isString value then
      false
    else
      let
        octets = lib.splitString "." value;
      in
      builtins.length octets == 4 && lib.all (octet: boundedDecimal 255 octet) octets;
  ipv4Cidr =
    value:
    if !lib.isString value then
      false
    else
      let
        parts = lib.splitString "/" value;
      in
      builtins.length parts == 2
      && ipv4Address (builtins.head parts)
      && boundedDecimal 32 (builtins.elemAt parts 1);
  coreutilsBin = "${coreutils}/bin";
  allowedSourceCidrsShell = lib.concatMapStringsSep "\n" (
    cidr: "    allowed_source_cidrs+=( ${lib.escapeShellArg cidr} );"
  ) allowedSourceCidrs;
in
assert executablePath validatorExecutable;
assert executablePath leaseManagerExecutable;
assert executablePath nixDaemonExecutable;
assert lib.isList allowedSourceCidrs && allowedSourceCidrs != [ ];
assert lib.all ipv4Cidr allowedSourceCidrs;
assert expectedSourceAddress == null || ipv4Address expectedSourceAddress;
assert expectedSshKey == null || lib.isString expectedSshKey;
assert environmentVariable sourceAddressEnvironmentVariable;
assert environmentVariable sshKeyEnvironmentVariable;
assert environmentVariable originalCommandEnvironmentVariable;
writeShellApplication {
  name = "shopify-remote-builder-dispatch";
  runtimeInputs = [ coreutils ];
  text = ''
        export LC_ALL=C
        umask 077
        set -o pipefail

        env_command=${lib.escapeShellArg "${coreutilsBin}/env"}
        validator=${lib.escapeShellArg validatorExecutable}
        lease_manager=${lib.escapeShellArg leaseManagerExecutable}
        nix_daemon=${lib.escapeShellArg nixDaemonExecutable}
        safe_path=${lib.escapeShellArg coreutilsBin}
        expected_source_address=${
          lib.escapeShellArg (if expectedSourceAddress == null then "" else expectedSourceAddress)
        }
        expected_ssh_key=${lib.escapeShellArg (if expectedSshKey == null then "" else expectedSshKey)}
        source_address_environment_variable=${lib.escapeShellArg sourceAddressEnvironmentVariable}
        ssh_key_environment_variable=${lib.escapeShellArg sshKeyEnvironmentVariable}
        original_command_environment_variable=${lib.escapeShellArg originalCommandEnvironmentVariable}
        allowed_source_cidrs=()
    ${allowedSourceCidrsShell}

        reject() {
          local reason="$1"
          local detail
          case "$reason" in
            context)
              detail='request context was not accepted'
              ;;
            interactive)
              detail='interactive request was not accepted'
              ;;
            command)
              detail='remote operation was not declared'
              ;;
            token)
              detail='lease token was not accepted'
              ;;
            service)
              detail='remote service was unavailable'
              ;;
            *)
              detail='request was not accepted'
              ;;
          esac
          printf '%s\n' "shopify-remote-builder-dispatch: $detail" >&2
          exit 64
        }

        read_environment_value() {
          local variable_name="$1"
          if [[ -v "$variable_name" ]]; then
            context_value="''${!variable_name}"
          else
            context_value=""
          fi
        }

        ipv4_to_uint() {
          local address="$1"
          local -a octets=()
          local octet
          local number
          local value=0
          IFS='.' read -r -a octets <<<"$address"
          if (( ''${#octets[@]} != 4 )); then
            return 1
          fi
          for octet in "''${octets[@]}"; do
            if [[ ! "$octet" =~ ^[0-9]{1,3}$ ]]; then
              return 1
            fi
            number=$((10#$octet))
            if (( number > 255 )); then
              return 1
            fi
            value=$((value * 256 + number))
          done
          printf '%s\n' "$value"
        }

        valid_port() {
          local port="$1"
          local number
          [[ "$port" =~ ^[0-9]{1,5}$ ]] || return 1
          number=$((10#$port))
          (( number > 0 && number <= 65535 ))
        }

        cidr_contains() {
          local cidr="$1"
          local address="$2"
          local network="''${cidr%/*}"
          local prefix="''${cidr##*/}"
          local network_value
          local address_value
          local prefix_number
          local block_size
          local network_start

          network_value="$(ipv4_to_uint "$network")" || return 1
          address_value="$(ipv4_to_uint "$address")" || return 1
          prefix_number=$((10#$prefix))
          if (( prefix_number == 0 )); then
            block_size=4294967296
            network_start=0
          else
            block_size=$((2 ** (32 - prefix_number)))
            network_start=$((network_value / block_size * block_size))
          fi
          (( address_value >= network_start && address_value < network_start + block_size ))
        }

        validate_environment() {
          local environment_record
          local variable_name
          while IFS= read -r -d $'\0' environment_record; do
            variable_name="''${environment_record%%=*}"
            case "$variable_name" in
              "$source_address_environment_variable" | \
              "$ssh_key_environment_variable" | \
              "$original_command_environment_variable" | \
              SSH_CONNECTION | SSH_CLIENT | HOME | PATH | TMPDIR | LANG | LC_ALL | \
              PWD | OLDPWD | SHLVL | USER | LOGNAME | SHELL | XDG_CACHE_HOME | \
              XDG_CONFIG_HOME | XDG_DATA_HOME | XDG_RUNTIME_DIR | XDG_STATE_HOME | \
              __CF_USER_TEXT_ENCODING | _)
                ;;
              LC_* | SSH_TTY | SSH_AUTH_SOCK | SSH_AGENT_PID | SSH_X11_COOKIE | \
              DISPLAY | XAUTHORITY | TERM | NIX_* | AWS_* | GITHUB_TOKEN | \
              ALL_PROXY | HTTP_PROXY | HTTPS_PROXY | NO_PROXY | all_proxy | \
              http_proxy | https_proxy | no_proxy | POST_BUILD_HOOK | SSH_OPTIONS | \
              BASH_ENV | ENV | CDPATH | IFS)
                reject context
                ;;
              *)
                reject context
                ;;
            esac
          done < <("$env_command" -0)
        }

        validate_source_context() {
          local connection
          local source_address
          local source_port
          local server_address
          local server_port
          local source_value
          local allowed=false
          local client_context
          local client_address
          local client_port
          local client_server_port
          local connection_pattern='^([^[:space:]]+) ([0-9]+) ([^[:space:]]+) ([0-9]+)$'
          local client_pattern='^([^[:space:]]+) ([0-9]+) ([0-9]+)$'

          read_environment_value "$source_address_environment_variable"
          connection="$context_value"
          if [[ ! "$connection" =~ $connection_pattern ]]; then
            reject context
          fi
          source_address="''${BASH_REMATCH[1]}"
          source_port="''${BASH_REMATCH[2]}"
          server_address="''${BASH_REMATCH[3]}"
          server_port="''${BASH_REMATCH[4]}"
          source_value="$(ipv4_to_uint "$source_address")" || reject context
          ipv4_to_uint "$server_address" >/dev/null || reject context
          valid_port "$source_port" || reject context
          valid_port "$server_port" || reject context

          if [[ -n "$expected_source_address" && "$source_address" != "$expected_source_address" ]]; then
            reject context
          fi
          for cidr in "''${allowed_source_cidrs[@]}"; do
            if cidr_contains "$cidr" "$source_address"; then
              allowed=true
              break
            fi
          done
          [[ "$allowed" == true ]] || reject context

          if [[ -v SSH_CLIENT ]]; then
            client_context="$SSH_CLIENT"
            if [[ ! "$client_context" =~ $client_pattern ]]; then
              reject context
            fi
            client_address="''${BASH_REMATCH[1]}"
            client_port="''${BASH_REMATCH[2]}"
            client_server_port="''${BASH_REMATCH[3]}"
            [[ "$client_address" == "$source_address" && "$client_port" == "$source_port" ]] \
              || reject context
            valid_port "$client_server_port" || reject context
          fi

          : "$source_value"
        }

        validate_key_context() {
          local provided_key
          read_environment_value "$ssh_key_environment_variable"
          provided_key="$context_value"
          if [[ ! "$provided_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]{68}(\ [A-Za-z0-9._-]+)?$ ]]; then
            reject context
          fi
          if [[ -z "$expected_ssh_key" || "$provided_key" != "$expected_ssh_key" ]]; then
            reject context
          fi
        }

        run_sanitized() {
          local executable="$1"
          shift
          [[ -x "$executable" ]] || reject service
          local -a child_argv=("$executable" "$@")
          exec "$env_command" -i \
            "HOME=/var/empty" \
            "LANG=C" \
            "LC_ALL=C" \
            "PATH=$safe_path" \
            "''${child_argv[@]}"
        }

        (( $# == 0 )) || reject command
        validate_environment
        validate_source_context
        validate_key_context
        [[ ! -t 0 && ! -t 1 ]] || reject interactive

        read_environment_value "$original_command_environment_variable"
        original_command="$context_value"
        [[ -n "$original_command" ]] || reject command

        case "$original_command" in
          validate)
            run_sanitized "$validator"
            ;;
          "/run/current-system/sw/bin/nix-daemon --stdio --store daemon")
            run_sanitized "$nix_daemon" --stdio --store daemon
            ;;
          *)
            if [[ "$original_command" =~ ^(ready|keepalive|prepare|release)\ ([A-Za-z0-9][A-Za-z0-9._-]{0,197})$ ]]; then
              lease_operation="''${BASH_REMATCH[1]}"
              lease_token="''${BASH_REMATCH[2]}"
              if [[ "''${#lease_token}" -gt 198 ]] || \
                [[ ! "$lease_token" =~ ^srb1-[A-Za-z0-9][A-Za-z0-9._-]{0,127}-[0-9a-f]{64}$ ]]; then
                reject token
              fi
              run_sanitized "$lease_manager" "$lease_operation" "$lease_token"
            fi
            reject command
            ;;
        esac
  '';
}
