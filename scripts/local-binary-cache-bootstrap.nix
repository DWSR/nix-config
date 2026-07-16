{
  lib,
  writeShellApplication,
  coreutils,
  diffutils,
  openssl,
  atticAdminExecutable,
  atticClientExecutable,
  caCertificate,
  cacheName,
  cachePublicKeyOutput,
  configuredCachePublicKey ? "",
  configuredCachePublicKeyFile ? "",
  curlExecutable,
  endpoint,
  jqExecutable,
  tlsCertificate,
  tlsKeyFile,
  jwtPublicKey,
  jwtPrivateKey,
  loginUser,
  personalTokenOutput,
  shopifyTokenOutput,
  cmpExecutable ? lib.getExe' diffutils "cmp",
  opensslExecutable ? lib.getExe openssl,
  statExecutable ? lib.getExe' coreutils "stat",
}:

writeShellApplication {
  name = "local-binary-cache-bootstrap";
  runtimeInputs = [ coreutils ];
  text = ''
        export LC_ALL=C

        fail() {
          printf 'local-binary-cache-bootstrap: %s\n' "$1" >&2
          exit 1
        }

        read_metadata() {
          local label="$1"
          local file="$2"
          local metadata

          if [[ ! -f "$file" ]]; then
            fail "required $label is missing or unavailable: $file"
          fi
          if ! metadata="$("$stat" --dereference '--format=%U:%a' -- "$file" 2>/dev/null)"; then
            fail "failed to read ownership and permissions for $label: $file"
          fi
          if [[ ! "$metadata" =~ ^([^:[:space:]]+):([0-7]{3,4})$ ]]; then
            fail "invalid ownership or permissions metadata for $label: $file"
          fi

          metadata_owner="''${BASH_REMATCH[1]}"
          metadata_mode="''${BASH_REMATCH[2]}"
          if (( ''${#metadata_mode} == 3 )); then
            metadata_mode="0$metadata_mode"
          fi
        }

        require_public_readable() {
          local label="$1"
          local file="$2"
          local mode_digits="''${3#0}"

          if (( (8#$mode_digits & 0444) == 0 )); then
            fail "$label must be readable: $file"
          fi
        }

        require_private_metadata() {
          local label="$1"
          local file="$2"
          local actual_owner="$3"
          local actual_mode="$4"
          local expected_owner="$5"

          if [[ "$actual_owner" != "$expected_owner" ]]; then
            fail "$label must be owned by $expected_owner, found $actual_owner: $file"
          fi
          if [[ "$actual_mode" != 0400 ]]; then
            fail "$label must have mode 0400, found $actual_mode: $file"
          fi
        }

        require_executable() {
          local executable="$1"

          if [[ "$executable" != /* || ! -x "$executable" ]]; then
            fail "required executable is unavailable: $executable"
          fi
        }

        require_output_path() {
          local label="$1"
          local file="$2"
          local parent

          if [[ "$file" != /* ]]; then
            fail "$label output path must be absolute: $file"
          fi
          if [[ -e "$file" || -L "$file" ]]; then
            fail "$label output already exists; refusing to overwrite: $file"
          fi
          parent="$(dirname -- "$file")"
          if [[ ! -d "$parent" || ! -w "$parent" ]]; then
            fail "$label output directory is missing or unwritable: $parent"
          fi
        }

        validate_cache_public_key() {
          local label="$1"
          local key="$2"

          if [[ ! "$key" =~ ^darwin:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$ ]]; then
            fail "$label is not a canonical darwin Nix signing public key"
          fi
        }

        write_admin_config() {
          {
            printf 'listen = "127.0.0.1:0"\n'
            printf '[database]\nurl = "sqlite::memory:"\n'
            printf '[storage]\ntype = "local"\npath = "%s"\n' "$work_directory/storage"
            printf '[chunking]\n'
            printf 'nar-size-threshold = 65536\nmin-size = 16384\navg-size = 65536\nmax-size = 262144\n'
            printf '[compression]\ntype = "none"\n'
            printf '[jwt.signing]\ntoken-rs256-secret-base64 = "'
          } > "$admin_config"
          if ! "$openssl" base64 -A -in "$jwt_private_key" >> "$admin_config" 2>/dev/null; then
            fail "failed to encode RS256 private key for runtime token issuance: $jwt_private_key"
          fi
          printf '"\n' >> "$admin_config"
          chmod 0600 "$admin_config"
        }

        generate_token() {
          local subject="$1"
          local validity="$2"
          local permission="$3"
          local output="$4"

          if ! "$attic_admin" -f "$admin_config" make-token \
            --sub "$subject" --validity "$validity" "$permission" "$cache_name" > "$output"; then
            fail "failed to issue token for subject $subject"
          fi
          if [[ ! -s "$output" ]]; then
            fail "token issuer returned an empty token for subject $subject"
          fi
          chmod 0400 "$output"
        }

        query_cache() {
          if ! cache_http_status="$(
            "$curl" --silent --show-error --output "$cache_state" \
              --write-out '%{http_code}' -- "$cache_query_url"
          )"; then
            fail "anonymous cache query failed: $cache_query_url"
          fi
          if [[ ! "$cache_http_status" =~ ^[0-9]{3}$ ]]; then
            fail "anonymous cache query returned an invalid HTTP status: $cache_query_url"
          fi
        }

        verify_cache_state() {
          if ! "$jq" -e '
            .is_public == true
            and .priority == 30
            and (
              .upstream_cache_key_names
              | type == "array"
                and length == 2
                and sort == ["cache.nixos.org-1", "nix-community.cachix.org-1"]
            )
            and (.public_key | type == "string" and length > 0)
          ' "$cache_state" >/dev/null; then
            fail "anonymous observed cache state does not match the darwin public cache contract"
          fi
          if ! live_cache_public_key="$("$jq" -er '.public_key' "$cache_state")"; then
            fail "failed to read live cache signing public key from anonymous cache state"
          fi
          validate_cache_public_key "live cache signing public key" "$live_cache_public_key"
          if [[ -n "$configured_cache_public_key" && "$live_cache_public_key" != "$configured_cache_public_key" ]]; then
            fail "configured cache signing public key differs from live darwin cache identity"
          fi
        }

        write_new_output() {
          local label="$1"
          local source="$2"
          local destination="$3"
          local mode="$4"

          if ! (
            umask 077
            set -o noclobber
            cat -- "$source" > "$destination"
          ); then
            fail "$label output appeared during bootstrap; refusing to overwrite: $destination"
          fi
          if ! chmod "$mode" "$destination"; then
            rm -f -- "$destination"
            fail "failed to set mode $mode on $label output: $destination"
          fi
        }

        openssl=${lib.escapeShellArg opensslExecutable}
        stat=${lib.escapeShellArg statExecutable}
        cmp=${lib.escapeShellArg cmpExecutable}
        attic_admin=${lib.escapeShellArg atticAdminExecutable}
        attic_client=${lib.escapeShellArg atticClientExecutable}
        curl=${lib.escapeShellArg curlExecutable}
        jq=${lib.escapeShellArg jqExecutable}
        ca_certificate=${lib.escapeShellArg caCertificate}
        tls_certificate=${lib.escapeShellArg tlsCertificate}
        tls_key=${lib.escapeShellArg tlsKeyFile}
        jwt_public_key=${lib.escapeShellArg jwtPublicKey}
        jwt_private_key=${lib.escapeShellArg jwtPrivateKey}
        login_user=${lib.escapeShellArg loginUser}
        endpoint=${lib.escapeShellArg endpoint}
        cache_name=${lib.escapeShellArg cacheName}
        cache_public_key_output=${lib.escapeShellArg cachePublicKeyOutput}
        personal_token_output=${lib.escapeShellArg personalTokenOutput}
        shopify_token_output=${lib.escapeShellArg shopifyTokenOutput}
        configured_cache_public_key=${lib.escapeShellArg configuredCachePublicKey}
        configured_cache_public_key_file=${lib.escapeShellArg configuredCachePublicKeyFile}

        for executable in "$openssl" "$stat"; do
          require_executable "$executable"
        done
        for artifact in "$ca_certificate" "$tls_certificate" "$tls_key" "$jwt_public_key" "$jwt_private_key"; do
          if [[ "$artifact" != /* ]]; then
            fail "identity artifact path must be absolute: $artifact"
          fi
        done
        if [[ -z "$login_user" || "$login_user" == *:* || "$login_user" == *[[:space:]]* ]]; then
          fail "invalid login user: $login_user"
        fi

        read_metadata "CA certificate" "$ca_certificate"
        ca_owner="$metadata_owner"
        ca_mode="$metadata_mode"
        require_public_readable "CA certificate" "$ca_certificate" "$ca_mode"

        read_metadata "TLS certificate" "$tls_certificate"
        tls_certificate_owner="$metadata_owner"
        tls_certificate_mode="$metadata_mode"
        require_public_readable "TLS certificate" "$tls_certificate" "$tls_certificate_mode"

        read_metadata "TLS private key" "$tls_key"
        tls_key_owner="$metadata_owner"
        tls_key_mode="$metadata_mode"
        require_private_metadata "TLS private key" "$tls_key" "$tls_key_owner" "$tls_key_mode" "$login_user"

        read_metadata "RS256 public key" "$jwt_public_key"
        jwt_public_owner="$metadata_owner"
        jwt_public_mode="$metadata_mode"
        require_public_readable "RS256 public key" "$jwt_public_key" "$jwt_public_mode"

        read_metadata "RS256 private key" "$jwt_private_key"
        jwt_private_owner="$metadata_owner"
        jwt_private_mode="$metadata_mode"
        require_private_metadata "RS256 private key" "$jwt_private_key" "$jwt_private_owner" "$jwt_private_mode" root

        if ! "$openssl" x509 -in "$ca_certificate" -noout >/dev/null 2>&1; then
          fail "invalid CA certificate: $ca_certificate"
        fi
        if ! "$openssl" x509 -in "$tls_certificate" -noout >/dev/null 2>&1; then
          fail "invalid TLS certificate: $tls_certificate"
        fi

        if ! san_output="$("$openssl" x509 -in "$tls_certificate" -noout -ext subjectAltName 2>/dev/null)"; then
          fail "TLS certificate lacks required DNS:Brandons-MacBook-Pro.local SAN: $tls_certificate"
        fi
        san_found=0
        while IFS= read -r san_line; do
          IFS=, read -r -a san_entries <<< "$san_line"
          for san_entry in "''${san_entries[@]}"; do
            san_entry="''${san_entry//[[:space:]]/}"
            if [[ "$san_entry" == DNS:Brandons-MacBook-Pro.local ]]; then
              san_found=1
            fi
          done
        done <<< "$san_output"
        if (( san_found == 0 )); then
          fail "TLS certificate lacks required DNS:Brandons-MacBook-Pro.local SAN: $tls_certificate"
        fi

        if ! usage_output="$("$openssl" x509 -in "$tls_certificate" -noout -ext extendedKeyUsage 2>/dev/null)"; then
          fail "TLS certificate lacks required serverAuth usage: $tls_certificate"
        fi
        usage_found=0
        while IFS= read -r usage_line; do
          IFS=, read -r -a usage_entries <<< "$usage_line"
          for usage_entry in "''${usage_entries[@]}"; do
            usage_entry="''${usage_entry//[[:space:]]/}"
            if [[ "$usage_entry" == TLSWebServerAuthentication || "$usage_entry" == 1.3.6.1.5.5.7.3.1 ]]; then
              usage_found=1
            fi
          done
        done <<< "$usage_output"
        if (( usage_found == 0 )); then
          fail "TLS certificate lacks required serverAuth usage: $tls_certificate"
        fi

        if ! "$openssl" verify -CAfile "$ca_certificate" -purpose sslserver "$tls_certificate" >/dev/null 2>&1; then
          fail "TLS certificate failed CA verification against $ca_certificate: $tls_certificate"
        fi

        if ! tls_certificate_public="$("$openssl" x509 -in "$tls_certificate" -pubkey -noout 2>/dev/null)"; then
          fail "failed to read TLS certificate public key: $tls_certificate"
        fi
        if ! "$openssl" pkey -in "$tls_key" -check -noout >/dev/null 2>&1; then
          fail "TLS private key failed internal consistency check: $tls_key"
        fi
        if ! tls_key_public="$("$openssl" pkey -in "$tls_key" -pubout 2>/dev/null)"; then
          fail "invalid TLS private key: $tls_key"
        fi
        if [[ "$tls_certificate_public" != "$tls_key_public" ]]; then
          fail "TLS certificate and private key do not match: $tls_certificate $tls_key"
        fi

        if ! "$openssl" rsa -pubin -in "$jwt_public_key" -noout >/dev/null 2>&1; then
          fail "invalid RS256 public key: $jwt_public_key"
        fi
        if ! "$openssl" rsa -in "$jwt_private_key" -check -noout >/dev/null 2>&1; then
          fail "invalid RS256 private key: $jwt_private_key"
        fi
        if ! jwt_public="$("$openssl" pkey -pubin -in "$jwt_public_key" -pubout 2>/dev/null)"; then
          fail "failed to normalize RS256 public key: $jwt_public_key"
        fi
        if ! jwt_private_public="$("$openssl" pkey -in "$jwt_private_key" -pubout 2>/dev/null)"; then
          fail "failed to derive RS256 public key from private key: $jwt_private_key"
        fi
        if [[ "$jwt_public" != "$jwt_private_public" ]]; then
          fail "RS256 public and private keys do not match: $jwt_public_key $jwt_private_key"
        fi

        signature_file=""
        cleanup_signature() {
          if [[ -n "$signature_file" ]]; then
            rm -f -- "$signature_file"
          fi
        }
        trap cleanup_signature EXIT
        if ! signature_file="$(mktemp "''${TMPDIR:-/tmp}/local-binary-cache-rs256.XXXXXX")"; then
          fail "failed to create temporary RS256 verification state"
        fi
        if ! printf '%s' local-binary-cache-rs256-preflight \
          | "$openssl" dgst -sha256 -sign "$jwt_private_key" \
            -sigopt rsa_padding_mode:pkcs1 -out "$signature_file" >/dev/null 2>&1; then
          fail "RS256 keypair cannot sign SHA-256 with PKCS#1 v1.5: $jwt_public_key $jwt_private_key"
        fi
        if ! printf '%s' local-binary-cache-rs256-preflight \
          | "$openssl" dgst -sha256 -verify "$jwt_public_key" \
            -sigopt rsa_padding_mode:pkcs1 -signature "$signature_file" >/dev/null 2>&1; then
          fail "RS256 keypair cannot verify SHA-256 with PKCS#1 v1.5: $jwt_public_key $jwt_private_key"
        fi
        rm -f -- "$signature_file"
        signature_file=""
        trap - EXIT

        printf 'ca-certificate path=%s owner=%s mode=%s\n' "$ca_certificate" "$ca_owner" "$ca_mode"
        printf 'tls-certificate path=%s owner=%s mode=%s\n' \
          "$tls_certificate" "$tls_certificate_owner" "$tls_certificate_mode"
        printf 'tls-private-key path=%s owner=%s mode=%s\n' "$tls_key" "$tls_key_owner" "$tls_key_mode"
        printf 'jwt-public-key path=%s owner=%s mode=%s\n' "$jwt_public_key" "$jwt_public_owner" "$jwt_public_mode"
        printf 'jwt-private-key path=%s owner=%s mode=%s\n' \
          "$jwt_private_key" "$jwt_private_owner" "$jwt_private_mode"

        operation="''${1:-preflight}"
        if (( $# > 1 )); then
          fail "usage: local-binary-cache-bootstrap [preflight|bootstrap|ready]"
        fi
        case "$operation" in
          preflight)
            ;;
          bootstrap|ready)
            for executable in "$attic_admin" "$attic_client" "$cmp" "$curl" "$jq"; do
              require_executable "$executable"
            done
            if [[ "$cache_name" != darwin ]]; then
              fail "cache name must be exactly darwin, found: $cache_name"
            fi
            if [[ ! "$endpoint" =~ ^https://[^/[:space:]?#]+(:[0-9]+)?$ ]]; then
              fail "cache endpoint must be an HTTPS origin without a path: $endpoint"
            fi
            for value in "$endpoint" "$cache_public_key_output" "$personal_token_output" "$shopify_token_output"; do
              if [[ "$value" =~ [\"\\\\] || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
                fail "cache operation input contains unsupported TOML characters"
              fi
            done
            if [[ -n "$configured_cache_public_key" && -n "$configured_cache_public_key_file" ]]; then
              fail "configure the cache public key by value or file, not both"
            fi
            if [[ -n "$configured_cache_public_key_file" ]]; then
              if [[ "$configured_cache_public_key_file" != /* || ! -r "$configured_cache_public_key_file" ]]; then
                fail "configured cache public key file is missing or unreadable: $configured_cache_public_key_file"
              fi
              configured_cache_public_key="$(< "$configured_cache_public_key_file")"
            fi
            if [[ -n "$configured_cache_public_key" ]]; then
              validate_cache_public_key "configured cache signing public key" "$configured_cache_public_key"
            fi
            if [[ "$operation" == ready && -z "$configured_cache_public_key" ]]; then
              fail "ready mode requires a configured cache signing public key"
            fi

            umask 077
            if [[ "$operation" == bootstrap ]]; then
              require_output_path "cache public key" "$cache_public_key_output"
              require_output_path "Brandons-MacBook-Pro token" "$personal_token_output"
              require_output_path "ShopifyLaptop token" "$shopify_token_output"
              if [[ "$cache_public_key_output" == "$personal_token_output"
                || "$cache_public_key_output" == "$shopify_token_output"
                || "$personal_token_output" == "$shopify_token_output" ]]; then
                fail "cache public key and host token outputs must use distinct paths"
              fi
            fi

            work_directory=""
            outputs_committed=0
            cache_key_output_created=0
            personal_token_output_created=0
            shopify_token_output_created=0
            cleanup_operations() {
              if (( outputs_committed == 0 )); then
                (( cache_key_output_created == 1 )) && rm -f -- "$cache_public_key_output"
                (( personal_token_output_created == 1 )) && rm -f -- "$personal_token_output"
                (( shopify_token_output_created == 1 )) && rm -f -- "$shopify_token_output"
              fi
              if [[ -n "$work_directory" ]]; then
                rm -rf -- "$work_directory"
              fi
            }
            trap cleanup_operations EXIT
            if ! work_directory="$(mktemp -d "''${TMPDIR:-/tmp}/local-binary-cache-bootstrap.XXXXXX")"; then
              fail "failed to create private bootstrap workspace"
            fi
            chmod 0700 "$work_directory"
            cache_state="$work_directory/cache-state.json"
            admin_config="$work_directory/atticadm.toml"
            cache_query_url="$endpoint/_api/v1/cache-config/$cache_name"

            query_cache
            case "$cache_http_status" in
              200)
                verify_cache_state
                ;;
              404)
                if [[ "$operation" == ready ]]; then
                  fail "darwin cache is missing; ready mode never creates cache identity"
                fi
                if [[ -n "$configured_cache_public_key" ]]; then
                  fail "darwin cache is missing while a signing identity is configured; refusing replacement"
                fi

                write_admin_config
                operator_token="$work_directory/bootstrap-operator-token"
                generate_token local-binary-cache-bootstrap 5m --create-cache "$operator_token"
                client_config_home="$work_directory/client-config"
                mkdir -p "$client_config_home/attic"
                chmod 0700 "$client_config_home" "$client_config_home/attic"
                cat > "$client_config_home/attic/config.toml" <<EOF
    default-server = "local"

    [servers.local]
    endpoint = "$endpoint"
    token-file = "$operator_token"
    EOF
                chmod 0600 "$client_config_home/attic/config.toml"
                if ! XDG_CONFIG_HOME="$client_config_home" "$attic_client" cache create \
                  --public --priority 30 \
                  --upstream-cache-key-name cache.nixos.org-1 \
                  --upstream-cache-key-name nix-community.cachix.org-1 \
                  "local:$cache_name"; then
                  fail "failed to create public darwin cache"
                fi
                query_cache
                if [[ "$cache_http_status" != 200 ]]; then
                  fail "darwin cache was not anonymously visible after creation (HTTP $cache_http_status)"
                fi
                verify_cache_state
                ;;
              *)
                fail "anonymous darwin cache query returned HTTP $cache_http_status; refusing mutation"
                ;;
            esac

            if [[ "$operation" == ready ]]; then
              printf 'cache-ready name=%s public=true priority=30 configured-key-match=true\n' "$cache_name"
              outputs_committed=1
              exit 0
            fi

            if [[ ! -f "$admin_config" ]]; then
              write_admin_config
            fi
            personal_token="$work_directory/Brandons-MacBook-Pro.token"
            shopify_token="$work_directory/ShopifyLaptop.token"
            generate_token Brandons-MacBook-Pro 1y --push "$personal_token"
            generate_token ShopifyLaptop 1y --push "$shopify_token"
            if "$cmp" -s -- "$personal_token" "$shopify_token"; then
              fail "token issuer returned identical credentials for distinct host subjects"
            fi

            cache_key="$work_directory/cache-public-key.txt"
            printf '%s\n' "$live_cache_public_key" > "$cache_key"
            chmod 0644 "$cache_key"
            write_new_output "cache public key" "$cache_key" "$cache_public_key_output" 0644
            cache_key_output_created=1
            write_new_output "Brandons-MacBook-Pro token" "$personal_token" "$personal_token_output" 0400
            personal_token_output_created=1
            write_new_output "ShopifyLaptop token" "$shopify_token" "$shopify_token_output" 0400
            shopify_token_output_created=1
            outputs_committed=1

            printf 'cache-public-key path=%s\n' "$cache_public_key_output"
            printf 'host-token subject=Brandons-MacBook-Pro path=%s mode=0400\n' "$personal_token_output"
            printf 'host-token subject=ShopifyLaptop path=%s mode=0400\n' "$shopify_token_output"
            ;;
          *)
            fail "usage: local-binary-cache-bootstrap [preflight|bootstrap|ready]"
            ;;
        esac
  '';
}
