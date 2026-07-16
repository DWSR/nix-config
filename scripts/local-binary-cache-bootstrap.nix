{
  lib,
  writeShellApplication,
  coreutils,
  openssl,
  caCertificate,
  tlsCertificate,
  tlsKeyFile,
  jwtPublicKey,
  jwtPrivateKey,
  loginUser,
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

    openssl=${lib.escapeShellArg opensslExecutable}
    stat=${lib.escapeShellArg statExecutable}
    ca_certificate=${lib.escapeShellArg caCertificate}
    tls_certificate=${lib.escapeShellArg tlsCertificate}
    tls_key=${lib.escapeShellArg tlsKeyFile}
    jwt_public_key=${lib.escapeShellArg jwtPublicKey}
    jwt_private_key=${lib.escapeShellArg jwtPrivateKey}
    login_user=${lib.escapeShellArg loginUser}

    for executable in "$openssl" "$stat"; do
      if [[ "$executable" != /* || ! -x "$executable" ]]; then
        fail "required executable is unavailable: $executable"
      fi
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
  '';
}
