{
  pkgs,
  lib,
  config,
  ...
}:
let
  githubToken =
    if config.home.mcp.githubToken == null then
      builtins.throw "home.mcp.githubToken must be set"
    else
      config.home.mcp.githubToken;

  cfg = config.home.mcp;
  signingCfg = cfg.gitMcpSigning;

  nonEmptySingleLineString = lib.types.addCheck lib.types.str (
    value: value != "" && !lib.hasInfix "\n" value && !lib.hasInfix "\r" value
  );
  absolutePath = lib.types.addCheck lib.types.str (
    value: lib.hasPrefix "/" value && !lib.hasInfix "\n" value && !lib.hasInfix "\r" value
  );
  ctkPublicKeyHash = lib.types.addCheck lib.types.str (
    value: builtins.match "[0-9a-f]{40}" value != null
  );
  maxSshPublicKeyLineLength = 64 * 1024;
  isCanonicalBase64 =
    value:
    builtins.match "([A-Za-z0-9+/]{4})*" value != null
    || builtins.match "([A-Za-z0-9+/]{4})*[A-Za-z0-9+/][AQgw]==" value != null
    || builtins.match "([A-Za-z0-9+/]{4})*[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=" value != null;

  reverse = values: builtins.foldl' (reversed: value: [ value ] ++ reversed) [ ] values;

  base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  base64Values = builtins.listToAttrs (
    builtins.genList (index: {
      name = builtins.substring index 1 base64Alphabet;
      value = index;
    }) (builtins.stringLength base64Alphabet)
  );
  base64Value = character: builtins.getAttr character base64Values;
  base64DecodedLength =
    value:
    let
      paddingLength =
        if lib.hasSuffix "==" value then
          2
        else if lib.hasSuffix "=" value then
          1
        else
          0;
    in
    (builtins.div (builtins.stringLength value) 4) * 3 - paddingLength;
  base64ByteAt =
    value: offset:
    let
      quantumOffset = (builtins.div offset 3) * 4;
      byteOffset = offset - (builtins.div offset 3) * 3;
      a = base64Value (builtins.substring quantumOffset 1 value);
      b = base64Value (builtins.substring (quantumOffset + 1) 1 value);
      c = base64Value (builtins.substring (quantumOffset + 2) 1 value);
      d = base64Value (builtins.substring (quantumOffset + 3) 1 value);
    in
    if byteOffset == 0 then
      a * 4 + builtins.div b 16
    else if byteOffset == 1 then
      (b - builtins.div b 16 * 16) * 16 + builtins.div c 4
    else
      (c - builtins.div c 4 * 4) * 64 + d;
  readUint32At =
    value: offset:
    base64ByteAt value offset * 16777216
    + base64ByteAt value (offset + 1) * 65536
    + base64ByteAt value (offset + 2) * 256
    + base64ByteAt value (offset + 3);
  parseSshStringAt =
    value: offset:
    let
      decodedLength = base64DecodedLength value;
      valueOffset = offset + 4;
    in
    if valueOffset > decodedLength then
      null
    else
      let
        valueLength = readUint32At value offset;
        nextOffset = valueOffset + valueLength;
      in
      if valueLength > decodedLength - valueOffset then
        null
      else
        {
          offset = valueOffset;
          length = valueLength;
          inherit nextOffset;
        };
  bytesAt =
    value: offset: count:
    builtins.genList (index: base64ByteAt value (offset + index)) count;
  matchesBytesAt =
    value: offset: expected:
    builtins.foldl' (
      matches: index: matches && (base64ByteAt value (offset + index) == builtins.elemAt expected index)
    ) true (builtins.genList (index: index) (builtins.length expected));
  hasNul =
    value: parsedString:
    builtins.foldl' (
      found: index: found || base64ByteAt value (parsedString.offset + index) == 0
    ) false (builtins.genList (index: index) parsedString.length);

  sshSkAlgorithmBytes = [
    115
    107
    45
    101
    99
    100
    115
    97
    45
    115
    104
    97
    50
    45
    110
    105
    115
    116
    112
    50
    53
    54
    64
    111
    112
    101
    110
    115
    115
    104
    46
    99
    111
    109
  ];
  nistP256Bytes = [
    110
    105
    115
    116
    112
    50
    53
    54
  ];

  wordBase = 65536;
  p256Prime = [
    65535
    65535
    65535
    65535
    65535
    65535
    0
    0
    0
    0
    0
    0
    1
    0
    65535
    65535
  ];
  p256PrimeExtended = p256Prime ++ [ 0 ];
  p256B = [
    24651
    10194
    15422
    15310
    45302
    52307
    1712
    25885
    34492
    30360
    48469
    46059
    37863
    43578
    13784
    23238
  ];
  zeroP256 = builtins.genList (_: 0) 16;
  compareP256 =
    left: right:
    let
      compare =
        leftRemaining: rightRemaining:
        if leftRemaining == [ ] then
          0
        else if builtins.head leftRemaining > builtins.head rightRemaining then
          1
        else if builtins.head leftRemaining < builtins.head rightRemaining then
          -1
        else
          compare (builtins.tail leftRemaining) (builtins.tail rightRemaining);
    in
    compare (reverse left) (reverse right);
  addP256Words =
    left: right:
    let
      add =
        leftRemaining: rightRemaining: carry:
        if leftRemaining == [ ] then
          {
            words = [ ];
            inherit carry;
          }
        else
          let
            sum = builtins.head leftRemaining + builtins.head rightRemaining + carry;
            next = add (builtins.tail leftRemaining) (builtins.tail rightRemaining) (builtins.div sum wordBase);
          in
          {
            words = [ (sum - builtins.div sum wordBase * wordBase) ] ++ next.words;
            inherit (next) carry;
          };
    in
    add left right 0;
  subtractP256Words =
    left: right:
    let
      subtract =
        leftRemaining: rightRemaining: borrow:
        if leftRemaining == [ ] then
          {
            words = [ ];
            inherit borrow;
          }
        else
          let
            difference = builtins.head leftRemaining - builtins.head rightRemaining - borrow;
            next = subtract (builtins.tail leftRemaining) (builtins.tail rightRemaining) (
              if difference < 0 then 1 else 0
            );
          in
          {
            words = [ (if difference < 0 then difference + wordBase else difference) ] ++ next.words;
            inherit (next) borrow;
          };
    in
    subtract left right 0;
  addP256 =
    left: right:
    let
      sum = addP256Words left right;
      extended = sum.words ++ [ sum.carry ];
      reduced =
        if compareP256 extended p256PrimeExtended >= 0 then
          (subtractP256Words extended p256PrimeExtended).words
        else
          extended;
    in
    builtins.genList (index: builtins.elemAt reduced index) 16;
  subtractP256 =
    left: right:
    if compareP256 left right >= 0 then
      (subtractP256Words left right).words
    else
      (subtractP256Words p256Prime (subtractP256Words right left).words).words;
  multiplyP256 =
    left: right:
    let
      multiplyWord =
        bitCount: word: accumulator: addend:
        if bitCount == 0 then
          {
            inherit accumulator addend;
          }
        else
          let
            bit = word - builtins.div word 2 * 2;
            nextAccumulator = if bit == 0 then accumulator else addP256 accumulator addend;
            nextAddend = addP256 addend addend;
          in
          multiplyWord (bitCount - 1) (builtins.div word 2) nextAccumulator nextAddend;
      multiplyWords =
        words: accumulator: addend:
        if words == [ ] then
          accumulator
        else
          let
            next = multiplyWord 16 (builtins.head words) accumulator addend;
          in
          multiplyWords (builtins.tail words) next.accumulator next.addend;
    in
    multiplyWords right zeroP256 left;
  bytesToP256 =
    bytes:
    reverse (
      builtins.genList (
        index: builtins.elemAt bytes (index * 2) * 256 + builtins.elemAt bytes (index * 2 + 1)
      ) (builtins.div (builtins.length bytes) 2)
    );
  isP256UncompressedPoint =
    point:
    if builtins.length point != 65 || builtins.head point != 4 then
      false
    else
      let
        x = bytesToP256 (builtins.genList (index: builtins.elemAt point (index + 1)) 32);
        y = bytesToP256 (builtins.genList (index: builtins.elemAt point (index + 33)) 32);
        xSquared = multiplyP256 x x;
        xCubed = multiplyP256 xSquared x;
      in
      compareP256 x p256Prime < 0
      && compareP256 y p256Prime < 0
      && multiplyP256 y y == subtractP256 (addP256 xCubed p256B) (addP256 x (addP256 x x));

  sshSkPublicKeyParts =
    value:
    builtins.match "sk-ecdsa-sha2-nistp256@openssh\\.com[[:blank:]]+([A-Za-z0-9+/=]+)([[:blank:]]+([^[:blank:]].*[^[:blank:]]|[^[:blank:]]))?" value;
  isSshSkEcdsaP256PublicKeyBlob =
    keyData:
    let
      algorithm = parseSshStringAt keyData 0;
    in
    if
      algorithm == null
      || algorithm.length != builtins.length sshSkAlgorithmBytes
      || !(matchesBytesAt keyData algorithm.offset sshSkAlgorithmBytes)
    then
      false
    else
      let
        curve = parseSshStringAt keyData algorithm.nextOffset;
      in
      if
        curve == null
        || curve.length != builtins.length nistP256Bytes
        || !(matchesBytesAt keyData curve.offset nistP256Bytes)
      then
        false
      else
        let
          point = parseSshStringAt keyData curve.nextOffset;
        in
        if point == null || point.length != 65 then
          false
        else
          let
            pointBytes = bytesAt keyData point.offset 65;
          in
          if !(isP256UncompressedPoint pointBytes) then
            false
          else
            let
              application = parseSshStringAt keyData point.nextOffset;
            in
            application != null
            && application.nextOffset == base64DecodedLength keyData
            && !(hasNul keyData application);
  sshPublicKey = lib.types.addCheck lib.types.str (
    value:
    builtins.stringLength value <= maxSshPublicKeyLineLength
    && !lib.hasInfix "\n" value
    && !lib.hasInfix "\r" value
    && (
      let
        parts = sshSkPublicKeyParts value;
        keyData = if parts == null then "" else builtins.head parts;
      in
      parts != null && isCanonicalBase64 keyData && isSshSkEcdsaP256PublicKeyBlob keyData
    )
  );
  sshFingerprint = lib.types.addCheck lib.types.str (
    value: builtins.match "SHA256:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]" value != null
  );

  signerPackage = pkgs.callPackage ../../scripts/git-mcp-secure-enclave-signer.nix { };
  adminPackage = pkgs.callPackage ../../scripts/git-mcp-secure-enclave-admin.nix { };

  hasCompleteSigningDeclaration =
    signingCfg.enable
    && signingCfg.identityLabel != null
    && signingCfg.ctkPublicKeyHash != null
    && signingCfg.sshPublicKey != null
    && signingCfg.sshFingerprint != null
    && signingCfg.githubSigningKeyRegistered;

  gitMcpSigningEnvironment = lib.optionalAttrs hasCompleteSigningDeclaration {
    GIT_SIGN_COMMITS = "true";
    GIT_CONFIG_COUNT = "4";
    GIT_CONFIG_KEY_0 = "commit.gpgSign";
    GIT_CONFIG_VALUE_0 = "true";
    GIT_CONFIG_KEY_1 = "gpg.format";
    GIT_CONFIG_VALUE_1 = "ssh";
    GIT_CONFIG_KEY_2 = "gpg.ssh.program";
    GIT_CONFIG_VALUE_2 = lib.getExe signingCfg.signerPackage;
    GIT_CONFIG_KEY_3 = "user.signingKey";
    GIT_CONFIG_VALUE_3 = signingCfg.stubPath;
    SSH_SK_PROVIDER = signingCfg.signerPackage.providerPath;
    KEYCHAIN_CERTIFICATES = signingCfg.ctkPublicKeyHash;
    GIT_MCP_SIGNING_CTK_HASH = signingCfg.ctkPublicKeyHash;
    GIT_MCP_SIGNING_PUBLIC_KEY = signingCfg.sshPublicKey;
    GIT_MCP_SIGNING_FINGERPRINT = signingCfg.sshFingerprint;
    GIT_MCP_SIGNING_STUB = signingCfg.stubPath;
  };

  # Convert a SOPS-bridged keychain secret name (e.g. `mcp-github-token`)
  # to the env-var name the launchd wrapper exports for it
  # (e.g. `MCP_GITHUB_TOKEN`). Uppercase + hyphen→underscore.
  toEnvVarName = name: lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] name);

  # Emit an mcpproxy `${env:<NAME_UPPERCASE>}` placeholder. The placeholder
  # is NOT resolved at Nix evaluation time and NOT at home-manager
  # activation time. The launchd wrapper (`mcpproxyWrapper` below) reads
  # each declared secret from the macOS Keychain at daemon startup and
  # exports it as an env var; mcpproxy then substitutes the placeholder
  # by reading its own process env at spawn time.
  #
  # mcpproxy v0.33.1 does not run the top-level `api_key` field through
  # the same secret-resolution path as per-server values, and its macOS
  # Keychain backend refuses to write under Nix packaging (the "refusing
  # to write to avoid OS modal prompts" safety check). Funneling every
  # secret through `${env:...}` + a launchd wrapper script eliminates both
  # problems: the wrapper reads the keychain via the Apple-signed
  # `/usr/bin/security` binary, which has reliable Keychain access
  # regardless of how mcpproxy is packaged.
  #
  # See `mcpproxyWrapper` below, `home.mcp.fileSourcedEnv`, and the
  # SOPS bridge in `configurations/common-darwin/mcp-sops-bridge.nix` +
  # `scripts/mcp-secrets-activate.nix` for the secret-flow contract.
  readKeychainSecret = name: "\${env:" + toEnvVarName name + "}";

  # Map a source extraServers attrset entry (or one of the base
  # upstreams below, built in the same attrset shape) to the array
  # entry mcpproxy expects. The attribute name becomes the `name`
  # field. The source `type` attribute (absent | "stdio" | "http" |
  # "streamable-http") becomes the explicit `protocol`. HTTP entries may
  # also carry `headers` and `oauth`. `enabled` and `quarantined` are always
  # set explicitly so the rendered config cannot be misread; mcpproxy's
  # per-server defaults are bypassed.
  protocolOf = serverCfg: serverCfg.type or "stdio";

  renderServer =
    name: serverCfg:
    let
      protocol = protocolOf serverCfg;
      isStdio = protocol == "stdio";
      isHttp = protocol == "http" || protocol == "streamable-http";
      stdioFields =
        if isStdio then
          {
            inherit (serverCfg) command;
            args = serverCfg.args or [ ];
          }
          // lib.optionalAttrs (serverCfg ? env) { inherit (serverCfg) env; }
        else
          { };
      httpFields =
        if isHttp then
          {
            inherit (serverCfg) url;
          }
          // lib.optionalAttrs (serverCfg ? headers) { inherit (serverCfg) headers; }
          // lib.optionalAttrs (serverCfg ? oauth) { inherit (serverCfg) oauth; }
        else
          { };
      # Per-server tool-discovery override. Only emitted when the source
      # entry sets `tool_discovery_interval`, so servers without one inherit
      # the global default ("0s", disabled). Lets a dynamic upstream re-index
      # on a cadence while the rest of the fleet stays quiet.
      intervalFields = lib.optionalAttrs (serverCfg ? tool_discovery_interval) {
        inherit (serverCfg) tool_discovery_interval;
      };
    in
    {
      inherit name protocol;
      enabled = true;
      quarantined = false;
    }
    // stdioFields
    // httpFields
    // intervalFields;

  # The base upstream MCP servers always present on every host (obsidian,
  # github, mcp-nixos, time, instances-mcp). They flow through the same
  # `renderServer` translator as `home.mcp.extraServers` entries so the
  # array-emission logic stays uniform. The `nixos` server in the legacy
  # mcphub config is renamed to `mcp-nixos` here (R2.1).
  baseServers = {
    obsidian = {
      command = "${pkgs.mcp-obsidian}/bin/mcp-obsidian";
      args = [ cfg.obsidianVaultPath ];
    };

    github = {
      command = "${pkgs.github-mcp-server}/bin/github-mcp-server";
      args = [
        "stdio"
        "--toolsets=all"
      ];
      env.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
    };

    # mcp-nixos = {
    #   command = "${pkgs.mcp-nixos}/bin/mcp-nixos";
    #   args = [ "--" ];
    # };

    # Local time + IANA timezone conversion (get_current_time, convert_time).
    # Promoted to a base server so every host's agents read time through MCP
    # instead of shelling out to `date` (denied on the opencode-nono audit +
    # enforced profiles). tzlocal autodetects the zone; no args needed.
    time = {
      command = "${pkgs.mcp-server-time}/bin/mcp-server-time";
    };

    instances-mcp = {
      type = "streamable-http";
      url = "https://instances-mcp.vantage.sh/mcp";
    };

    # git-mcp-server (cyanheads/git-mcp-server, security-reviewed — see
    # memories/2026-06-02-git-mcp-server-security-review.md). Promoted to a
    # base server so every host's agents perform git operations through MCP
    # instead of shelling out to `git` (the opencode-nono sandbox denies the
    # `git_config` group and ~/.config/git). The package wrapper
    # (overlays/mcp-servers.nix) pins MCP_TRANSPORT_TYPE=stdio so the server
    # never opens an HTTP listener. Here we pin the remaining posture:
    #   - MCP_SESSION_MODE=stateless: no per-session state retained.
    #   - STORAGE_PROVIDER_TYPE=in-memory: never write a `.storage` dir into
    #     the working tree (the upstream default is the filesystem provider).
    git-mcp = {
      command = "${pkgs.git-mcp-server}/bin/git-mcp-server";
      env = {
        MCP_SESSION_MODE = "stateless";
        STORAGE_PROVIDER_TYPE = "in-memory";
      }
      // gitMcpSigningEnvironment;
    };
  };

  mergedServers = baseServers // cfg.extraServers;

  renderedConfig = {
    listen = "127.0.0.1:${toString cfg.listenPort}";
    data_dir = "${config.home.homeDirectory}/.mcpproxy";
    routing_mode = "retrieve_tools";
    quarantine_enabled = false;
    # Disable the periodic tools/list re-index sweep globally ("0s" =
    # disabled). Tool changes are still picked up reactively via
    # notifications/tools/list_changed and on (re)connect; the sweep is
    # only a fallback for servers that don't advertise listChanged.
    # Hosts that need the sweep for a specific upstream set a per-server
    # override, which flows through renderServer's tool_discovery_interval
    # passthrough (mcpproxy resolution order: per-server → global →
    # built-in default).
    tool_discovery_interval = "0s";
    api_key = readKeychainSecret "mcpproxy-api-key";
    require_mcp_auth = false;
    mcpServers = lib.mapAttrsToList renderServer mergedServers;
  };

  renderedConfigText = builtins.toJSON renderedConfig;

  sourceConfigPath = "${config.xdg.configHome}/mcpproxy/mcp_config.json";
  runtimeConfigDir = "${config.home.homeDirectory}/.mcpproxy/runtime-config";
  runtimeConfigPath = "${runtimeConfigDir}/mcp_config.json";

  # Every operator-declared MCP secret that the mcpproxy daemon
  # actually consumes (top-level api_key + per-server env/header
  # placeholders), plus the bridge-owned `mcpproxy-api-key`. The
  # launchd wrapper iterates this list and exports each value from
  # the macOS Keychain as an env var.
  #
  # The `sqlite-backup-*` filter matches the routing in
  # `scripts/mcp-secrets-activate.nix`'s `route_service` helper: those
  # secrets are written under `-s nix-config-secrets` (for the
  # sqlite-backup CLI / verify pipeline), not under `-s mcpproxy`, so
  # the wrapper must not try to read them under the mcpproxy service.
  # The mcpproxy daemon does not reference sqlite-backup secrets in
  # any rendered `mcp_config.json` placeholder anyway. Keep this
  # predicate in sync with the activation script.
  daemonSecretNames = [
    "mcpproxy-api-key"
  ]
  ++ builtins.filter (name: !(lib.hasPrefix "sqlite-backup-" name)) (
    builtins.attrNames cfg.keychainSecrets
  );

  keychainEnvVarNames = map toEnvVarName daemonSecretNames;
  fileSourcedEnvNames = builtins.attrNames cfg.fileSourcedEnv;
  fileSourcedEnvNameCollisions = lib.intersectLists keychainEnvVarNames fileSourcedEnvNames;

  fileSourcedEnvWatchPaths = lib.mapAttrsToList (_name: entry: entry.path) (
    lib.filterAttrs (_name: entry: entry.triggersRestart) cfg.fileSourcedEnv
  );

  renderFileSourcedEnvExport =
    envName: entry:
    let
      sourcePath = lib.escapeShellArg entry.path;
      failureDisposition = if entry.required then "aborting" else "continuing";
      failureAction = if entry.required then "exit 1" else ":";
    in
    ''
      unset ${envName} || true
      if [ -r ${sourcePath} ]; then
        if file_sourced_value="$({ ${entry.transform}; } < ${sourcePath})" && [ -n "$file_sourced_value" ]; then
          export ${envName}="$file_sourced_value"
        else
          echo "mcpproxy-launchd-wrapper: file-sourced env ${envName} source ${sourcePath} is empty or malformed; ${failureDisposition}" >&2
          ${failureAction}
        fi
        unset file_sourced_value || true
      else
        echo "mcpproxy-launchd-wrapper: file-sourced env ${envName} source ${sourcePath} is missing or unreadable; ${failureDisposition}" >&2
        ${failureAction}
      fi
    '';

  fileSourcedEnvExports = lib.concatStringsSep "\n" (
    lib.mapAttrsToList renderFileSourcedEnvExport cfg.fileSourcedEnv
  );

  # Launchd wrapper around `mcpproxy serve`. Reads every declared
  # MCP secret from the macOS Keychain via Apple's `/usr/bin/security`
  # binary plus any `home.mcp.fileSourcedEnv` runtime files, exports
  # each as the env var the rendered `mcp_config.json` references via
  # `${env:NAME}` placeholders, copies the Home Manager-rendered
  # config to a private runtime path, validates that runtime copy as
  # JSON, then exec's mcpproxy.
  #
  # This is a workaround for two mcpproxy v0.33.1 limitations:
  #
  #   1. The top-level `api_key` field is read from the config file
  #      before mcpproxy's native secret-resolution pipeline runs, so
  #      native keyring placeholders are not suitable for the managed
  #      daemon's bearer token.
  #   2. mcpproxy's macOS Keychain backend (via go-keyring) refuses to
  #      write under Nix-packaged binaries that aren't codesigned with
  #      a developer identity; it can read, but reads are also flaky
  #      under launchd's user-agent context when the keychain isn't
  #      yet unlocked (race vs login-completion).
  #
  # Funnelling secret resolution through this wrapper (which uses the
  # Apple-signed `security` binary) makes both problems disappear: the
  # daemon never has to talk to the macOS Keychain directly. Failure of
  # any keychain read aborts the wrapper before mcpproxy starts, so the
  # daemon never launches with literal placeholder strings.
  mcpproxyWrapper = pkgs.writeShellApplication {
    name = "mcpproxy-launchd-wrapper";
    runtimeInputs = [ pkgs.jq ];
    text = ''
      set -eu

      source_config=${lib.escapeShellArg sourceConfigPath}
      runtime_config_dir=${lib.escapeShellArg runtimeConfigDir}
      runtime_config=${lib.escapeShellArg runtimeConfigPath}

      ${lib.concatMapStringsSep "\n" (
        name:
        let
          envName = toEnvVarName name;
        in
        ''
          if ! ${envName}="$(/usr/bin/security find-generic-password -s mcpproxy -a "${name}" -w 2>/dev/null)"; then
            echo "mcpproxy-launchd-wrapper: failed to read '${name}' from macOS Keychain (-s mcpproxy -a ${name})" >&2
            echo "  ensure the SOPS bridge has populated this entry; re-run \`darwin-rebuild switch\` and check" >&2
            echo "  /var/log/install.log for mcp-secrets-activate errors." >&2
            exit 1
          fi
          export ${envName}
        ''
      ) daemonSecretNames}

      ${fileSourcedEnvExports}

      if [ ! -f "$source_config" ]; then
        echo "mcpproxy-launchd-wrapper: source config $source_config is missing" >&2
        exit 1
      fi

      if ! mkdir -p "$runtime_config_dir"; then
        echo "mcpproxy-launchd-wrapper: failed to create runtime config directory $runtime_config_dir" >&2
        exit 1
      fi

      if ! chmod 700 "$runtime_config_dir"; then
        echo "mcpproxy-launchd-wrapper: failed to set private permissions on $runtime_config_dir" >&2
        exit 1
      fi

      if ! rm -f "$runtime_config" "$runtime_config.bak"; then
        echo "mcpproxy-launchd-wrapper: failed to remove stale runtime config or backup under $runtime_config_dir" >&2
        exit 1
      fi

      if ! cp "$source_config" "$runtime_config"; then
        echo "mcpproxy-launchd-wrapper: failed to copy source config $source_config to $runtime_config" >&2
        exit 1
      fi

      if ! chmod 600 "$runtime_config"; then
        echo "mcpproxy-launchd-wrapper: failed to set private permissions on runtime config $runtime_config" >&2
        exit 1
      fi

      if ! jq -e . "$runtime_config" >/dev/null; then
        echo "mcpproxy-launchd-wrapper: runtime config $runtime_config is not parseable JSON" >&2
        exit 1
      fi

      exec ${lib.getExe pkgs.mcpproxy-go} "$@"
    '';
  };
in
{
  options.home.mcp = {
    githubToken = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "GitHub personal access token for MCP server";
    };

    ghAuthToken = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        1Password URI for the gh CLI auth token (e.g.,
        `op://Employee/...` on Shopify hosts, `op://Private/...` on
        personal hosts). Sourced via the same per-host SOPS+1Password
        pipeline as `home.mcp.keychainSecrets`; the bridge module reads
        this URI to materialize the gh token at activation time.
      '';
    };

    nixAccessTokenSecret = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "mcp-github-token";
      description = ''
        Name of a `home.mcp.keychainSecrets` entry whose value is a
        GitHub personal access token to expose to Nix as
        `access-tokens = github.com=<token>`. When set, the
        `mcp-sops-bridge` darwin module renders
        `/etc/nix/nix.conf.d/github-access-token.conf` from the
        decrypted secret at `darwin-rebuild switch` time and adds an
        `!include` of that file to `nix.extraOptions`, so `nix` and
        `darwin-rebuild` can authenticate `github:` flake-input and
        tarball fetches. The named secret MUST already be declared in
        `keychainSecrets` (so sops decrypts it to `/run/secrets/<name>`);
        the bridge fails the build otherwise. `null` disables Nix token
        wiring on the host. Reusing the MCP GitHub PAT
        (`"mcp-github-token"`) avoids minting a second token; point this
        at a distinct secret if Nix needs different scopes.
      '';
    };

    obsidianVaultPath = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to the Obsidian vault for agent memory and conversation logs";
    };

    gitMcpSigning = {
      enable = lib.mkEnableOption "git-mcp Secure Enclave signing";

      stateDir = lib.mkOption {
        type = absolutePath;
        default = "${config.xdg.stateHome}/git-mcp-secure-enclave-signing";
        description = "Absolute XDG state directory for non-secret git-mcp signing artifacts.";
      };

      identityLabel = lib.mkOption {
        type = lib.types.nullOr nonEmptySingleLineString;
        default = null;
        description = "Non-empty CTK identity label for the active git-mcp signing enrollment.";
      };

      ctkPublicKeyHash = lib.mkOption {
        type = lib.types.nullOr ctkPublicKeyHash;
        default = null;
        description = "Lowercase 40-character CTK public-key hash for the active signing enrollment.";
      };

      sshPublicKey = lib.mkOption {
        type = lib.types.nullOr sshPublicKey;
        default = null;
        description = "OpenSSH sk-ecdsa-sha2-nistp256 public key for the active signing enrollment.";
      };

      sshFingerprint = lib.mkOption {
        type = lib.types.nullOr sshFingerprint;
        default = null;
        description = "SHA256 OpenSSH fingerprint for the active signing enrollment.";
      };

      githubSigningKeyRegistered = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether this exact public key has been registered through GitHub's signing-key surface.";
      };

      signerPackage = lib.mkOption {
        type = lib.types.package;
        default = signerPackage;
        description = "Signer package for git-mcp Secure Enclave signing.";
      };

      adminPackage = lib.mkOption {
        type = lib.types.package;
        default = adminPackage;
        description = "Lifecycle administration package for git-mcp Secure Enclave signing.";
      };

      stubPath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default =
          if signingCfg.ctkPublicKeyHash == null then
            null
          else
            "${signingCfg.stateDir}/identities/${signingCfg.ctkPublicKeyHash}/id_ecdsa_sk_rk";
        readOnly = true;
        description = "Derived resident-key stub path for the configured CTK public-key hash.";
      };
    };

    extraServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      default = { };
      description = ''
        Additional MCP servers to add to the mcpproxy configuration.
        Entries keep an attrset shape (the attribute name becomes the
        server `name` in the rendered array). Stdio servers use
        `command`, `args`, and optional `env`; HTTP and
        streamable-HTTP servers set `type = "http"` or
        `type = "streamable-http"`, `url`, and optional `headers` or
        `oauth` configuration.
        An optional `tool_discovery_interval` (duration string such as
        `"1h"`, or `"0s"` to disable) overrides the global sweep cadence
        for that server. The renderer translates this attrset into
        mcpproxy's `mcpServers` array shape and appends `enabled = true`
        and `quarantined = false` to every entry.
      '';
      example = {
        custom-server = {
          command = "\${pkgs.custom-mcp}/bin/custom-mcp";
          args = [ "arg1" ];
          env.CUSTOM_VAR = "value";
        };
      };
    };

    keychainSecrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Map of keychain service names to 1Password URIs. Secrets are read from op during activation and stored in the macOS Keychain for runtime access.";
      example = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
      };
    };

    fileSourcedEnv = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            path = lib.mkOption {
              type = lib.types.str;
              description = ''
                Absolute path to the source file. The launchd wrapper reads
                this file at daemon startup, so the path is not required to
                exist during Nix evaluation or Home Manager activation.
              '';
              example = "/Users/me/.cache/tool-gateway-token";
            };

            transform = lib.mkOption {
              type = lib.types.str;
              default = "/bin/cat";
              description = ''
                Shell pipeline that receives the file content on stdin and
                writes the environment variable value on stdout. The pipeline
                runs inside the launchd wrapper once per daemon start.
              '';
              example = "/usr/bin/cut -d= -f2-";
            };

            required = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Abort the wrapper when the file is missing, unreadable, or
                transforms to an empty value. When false, the wrapper logs a
                warning and starts mcpproxy without exporting the env var.
              '';
            };

            triggersRestart = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Add the source file to the launchd agent's WatchPaths so
                mcpproxy restarts and re-reads the value after external
                tooling rewrites the file.
              '';
            };
          };
        }
      );
      default = { };
      description = ''
        Environment variables sourced from runtime files outside the
        SOPS+Keychain pipeline. Attribute names are env var names referenced
        from mcpproxy config as `${"\${env:NAME}"}` placeholders.
      '';
      example = {
        TOOL_GATEWAY_TOKEN = {
          path = "/Users/me/.cache/tool-gateway-token";
          transform = "/usr/bin/cut -d= -f2-";
          triggersRestart = true;
        };
      };
    };

    listenPort = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = ''
        TCP port on which the mcpproxy daemon listens on 127.0.0.1.
        Consumers (opencode wrapper, memory-sync CLI, cavemem wrapper)
        derive their probe URLs from this value via the rendered
        mcp_config.json.
      '';
    };

    enable = lib.mkEnableOption "MCP hub configuration" // {
      default = true;
    };
  };

  options.home.mcp.readKeychainSecret = lib.mkOption {
    type = lib.types.raw;
    default = readKeychainSecret;
    readOnly = true;
    description = ''
      Function that returns an `${"\${env:NAME}"}` placeholder for use
      in rendered MCP server `env` and `headers` values, where `NAME`
      is the secret name uppercased and with `-` replaced by `_`
      (e.g. `mcp-github-token` → `${"\${env:MCP_GITHUB_TOKEN}"}`).
      mcpproxy resolves the placeholder at server-spawn time by
      reading the matching env var from its own process environment;
      the launchd wrapper (see `mcpproxyWrapper` in this module)
      sources every required env var from the macOS Keychain at
      daemon startup. The placeholder is never expanded at Nix
      evaluation or home-manager activation time, so no secret
      material appears in `mcp_config.json` or the Nix store.
    '';
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = !signingCfg.enable || signingCfg.identityLabel != null;
          message = "home.mcp.gitMcpSigning.enable requires identityLabel to be set.";
        }
        {
          assertion = !signingCfg.enable || signingCfg.ctkPublicKeyHash != null;
          message = "home.mcp.gitMcpSigning.enable requires ctkPublicKeyHash to be set.";
        }
        {
          assertion = !signingCfg.enable || signingCfg.sshPublicKey != null;
          message = "home.mcp.gitMcpSigning.enable requires sshPublicKey to be set.";
        }
        {
          assertion = !signingCfg.enable || signingCfg.sshFingerprint != null;
          message = "home.mcp.gitMcpSigning.enable requires sshFingerprint to be set.";
        }
        {
          assertion = !signingCfg.enable || signingCfg.githubSigningKeyRegistered;
          message = "home.mcp.gitMcpSigning.enable requires githubSigningKeyRegistered = true.";
        }
        {
          assertion =
            !signingCfg.enable
            || builtins.seq signingCfg.stateDir (
              builtins.seq signingCfg.signerPackage (builtins.seq signingCfg.adminPackage true)
            );
          message = "home.mcp.gitMcpSigning.enable requires valid stateDir, signerPackage, and adminPackage values.";
        }
      ];
    }
    (lib.mkIf config.home.mcp.enable {
      assertions = [
        {
          assertion = lib.all (
            name: builtins.match "[A-Za-z_][A-Za-z0-9_]*" name != null
          ) fileSourcedEnvNames;
          message = "home.mcp.fileSourcedEnv attribute names must be valid shell environment variable names.";
        }
        {
          assertion = fileSourcedEnvNameCollisions == [ ];
          message = "home.mcp.fileSourcedEnv names conflict with Keychain-sourced env vars: ${lib.concatStringsSep ", " fileSourcedEnvNameCollisions}";
        }
        {
          assertion = renderedConfig.api_key == readKeychainSecret "mcpproxy-api-key";
          message = ''
            home.mcp rendered source config must reference mcpproxy-api-key
            through the launchd-wrapper ${"\${env:MCPPROXY_API_KEY}"} flow.
          '';
        }
        {
          assertion = lib.hasPrefix "\${env:" githubToken && lib.hasSuffix "}" githubToken;
          message = ''
            home.mcp.githubToken must be supplied as a launchd-wrapper
            ${"\${env:...}"} placeholder, not as a literal token.
          '';
        }
        {
          assertion = !(renderedConfig ? tools_limit);
          message = "home.mcp rendered source config must not set tools_limit; retrieve_tools mode relies on mcpproxy defaults.";
        }
        {
          assertion = builtins.match ".*\\$\\{keyring.*" renderedConfigText == null;
          message = "home.mcp rendered source config must use launchd-wrapper env placeholders, not mcpproxy keyring placeholders.";
        }
        {
          assertion = builtins.match ".*op://.*" renderedConfigText == null;
          message = "home.mcp rendered source config must not contain literal 1Password secret source references.";
        }
      ];

      home.packages = [
        pkgs.mcpproxy-go
        pkgs.github-mcp-server
        # pkgs.mcp-nixos
        pkgs.mcp-obsidian
        pkgs.mcp-server-time
        pkgs.git-mcp-server
        signingCfg.signerPackage
        signingCfg.adminPackage
        (pkgs.writeScriptBin "restart-mcpproxy" ''
          #!/bin/sh
          exec launchctl kickstart -k "gui/$(id -u)/com.smart-mcp-proxy.mcpproxy"
        '')
      ];

      xdg.configFile."mcpproxy/mcp_config.json" = {
        enable = true;
        text = renderedConfigText;
      };

      xdg.configFile."git-mcp-secure-enclave-signing/active.json" =
        lib.mkIf hasCompleteSigningDeclaration
          {
            text = builtins.toJSON {
              inherit (signingCfg)
                stateDir
                identityLabel
                ctkPublicKeyHash
                sshPublicKey
                sshFingerprint
                githubSigningKeyRegistered
                ;
            };
          };

      # launchd refuses to auto-create StandardOutPath / StandardErrorPath
      # parent directories; ensure ~/Library/Logs/mcpproxy exists before
      # the agent starts.
      home.activation.mcpproxyLogDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p "${config.home.homeDirectory}/Library/Logs/mcpproxy"
      '';

      launchd.agents.mcpproxy = {
        enable = true;
        config = {
          Label = "com.smart-mcp-proxy.mcpproxy";
          ProgramArguments = [
            # The wrapper reads every MCP secret from the macOS Keychain
            # (via Apple's signed `/usr/bin/security`) and exports each as
            # an env var BEFORE exec'ing mcpproxy. This bypasses two
            # mcpproxy v0.33.1 quirks: the top-level `api_key` field is
            # not run through the native secret-resolution pipeline, and
            # the daemon's own macOS Keychain backend is unreliable under
            # Nix packaging.
            # See the `mcpproxyWrapper` definition in this file for the
            # full rationale.
            (lib.getExe mcpproxyWrapper)
            "serve"
            "--config=${runtimeConfigPath}"
            "--log-to-file=false"
            # Prevent runtime mutation of mcp_config.json. mcpproxy
            # v0.33.1's DELETE /api/v1/servers/{id} and POST
            # /api/v1/servers paths persist their changes back to the
            # config file, detaching home-manager's symlink and turning
            # the file into a regular operator-writable copy. Disabling
            # the add/remove paths leaves the runtime API read-only for
            # server inventory while keeping OAuth login, quarantine
            # approval, and per-server enable/disable available.
            "--allow-server-add=false"
            "--allow-server-remove=false"
          ];
          RunAtLoad = true;
          KeepAlive = true;
          EnvironmentVariables.PATH =
            lib.makeBinPath [
              pkgs.unstable.google-cloud-sdk
              pkgs.git-lfs
            ]
            + ":/usr/bin:/bin";
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/mcpproxy/launchd.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/mcpproxy/launchd.error.log";
        }
        // lib.optionalAttrs (fileSourcedEnvWatchPaths != [ ]) {
          WatchPaths = fileSourcedEnvWatchPaths;
        };
      };
    })
  ];
}
