{
  activator,
  pkgs,
}:
pkgs.runCommand "agentmemory-missing-secret-activation" { } ''
    manifest="$TMPDIR/manifest.json"
    printf '%s\n' '{"ghAuthToken":false,"keychainSecrets":["agentmemory-bearer"],"nixAccessTokenSecret":null}' > "$manifest"

    # The live host may already have the bearer. Override only its existence
    # probe so the unchanged activation executable takes the missing-secret path.
    fault_profile="$TMPDIR/missing-secret.bash"
    cat > "$fault_profile" <<'EOF'
  function [ {
    if builtin test "$1" = "!" \
      && builtin test "$2" = "-e" \
      && builtin test "$3" = "/run/secrets/agentmemory-bearer"; then
      return 0
    fi
    builtin [ "$@"
  }
  EOF

    status=0
    BASH_ENV="$fault_profile" ${activator}/bin/mcp-secrets-activate brandonmcnama "$manifest" > "$TMPDIR/stdout" 2> "$TMPDIR/stderr" || status=$?
    test "$status" -eq 1
    grep -qF '/run/secrets/agentmemory-bearer does not exist' "$TMPDIR/stderr"
    ! grep -Eq 'add-generic-password|gh auth login' "$TMPDIR/stderr"

    {
      printf 'activation_status=%s\n' "$status"
      cat "$TMPDIR/stderr"
    } > "$out"
''
