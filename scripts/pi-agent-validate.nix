{
  credentialRuntimeModule,
  extensionPackage,
  piPackage,
  pkgs,
  statusPackage,
  profileCatalog ? import ../home-manager/common/pi-agent/profiles.nix {
    inherit (pkgs) lib;
    inherit pkgs;
  },
}:
let
  expectedPiVersion = "0.83.0";
  expectedNonoVersion = "0.69.0";
  expectedExtensionOrder = [
    "cavemem"
    "mcp"
    "subagents"
    "plan"
    "timestamps"
    "bashTimeout"
    "questions"
    "codeIntelligence"
    "backgroundTasks"
  ];
  requiredPatchNames = [
    "pi-cavemem-environment-bootstrap.patch"
    "pi-context-recovery.patch"
    "pi-launch-redaction-bootstrap.patch"
    "pi-undici-8.9.0.patch"
  ];
  selectedPatchNames = map (
    patch:
    let
      name = builtins.baseNameOf (builtins.unsafeDiscardStringContext (toString patch));
    in
    if builtins.match "[0-9a-z]{32}-pi-cavemem-environment-bootstrap\\.patch" name != null then
      "pi-cavemem-environment-bootstrap.patch"
    else
      name
  ) (piPackage.patches or [ ]);
  hasRequiredPatches = builtins.all (
    name: builtins.length (builtins.filter (candidate: candidate == name) selectedPatchNames) == 1
  ) requiredPatchNames;
  checkedPiPackage =
    if
      (piPackage.pname or null) == "pi-coding-agent"
      && (piPackage.version or null) == expectedPiVersion
      && hasRequiredPatches
    then
      piPackage
    else
      throw "pi-agent validator requires the reviewed pi-coding-agent 0.83.0 patch set";
  contextRecoveryEvidence =
    if (checkedPiPackage.passthru.tests.context-recovery or null) != null then
      checkedPiPackage.passthru.tests.context-recovery
    else
      throw "pi-agent validator requires context-recovery test evidence";
  extensionManifestPath =
    if (extensionPackage.manifest or null) != null then
      extensionPackage.manifest
    else
      throw "pi-agent validator requires the reviewed extension manifest";
  extensionManifest = builtins.fromJSON (builtins.readFile extensionManifestPath);
  extensionNames = builtins.attrNames extensionManifest.extensions;
  expectedExtensionNames = builtins.sort builtins.lessThan expectedExtensionOrder;
  checkedExtensionManifest =
    if
      extensionManifest.schemaVersion == 1
      && extensionManifest.piVersion == expectedPiVersion
      && extensionManifest.extensionOrder == expectedExtensionOrder
      && extensionNames == expectedExtensionNames
    then
      extensionManifest
    else
      throw "pi-agent validator requires the reviewed extension inventory for Pi 0.83.0";
  profileNames = builtins.attrNames profileCatalog.profiles;
  checkedProfileCatalog =
    if
      profileCatalog.nonoVersion == expectedNonoVersion
      &&
        profileNames == [
          "pi-audit"
          "pi-managed"
          "pi-review"
        ]
    then
      profileCatalog
    else
      throw "pi-agent validator requires the reviewed nono profile catalog";
  packageContract = {
    schemaVersion = 1;
    piVersion = expectedPiVersion;
    undiciVersion = "8.9.0";
    gondolinUndiciVersion = "6.28.0";
    requiredPatches = requiredPatchNames;
    contextRecovery = {
      schemaVersion = 1;
      upstreamCommit = "32850ef7c5edff7a6eee0214516fbb7382bf292d";
      upstreamParent = "e56893f4cd6545ab1498b72ae4e1e2241a0926f4";
      upstreamTests = [
        "packages/ai/test/openai-responses-terminal-event.test.ts"
        "packages/ai/test/overflow.test.ts"
        "packages/coding-agent/test/assistant-message.test.ts"
        "packages/coding-agent/test/suite/agent-session-compaction.test.ts"
      ];
      terminalBaselineTests = [
        "packages/coding-agent/test/suite/agent-session-retry-events.test.ts"
      ];
    };
  };
  profileContract = {
    schemaVersion = 1;
    inherit profileNames;
    inherit (checkedProfileCatalog) catalog nonoVersion profiles;
  };
  extensionContract = {
    manifest = checkedExtensionManifest;
    inherit (checkedExtensionManifest) extensionOrder;
    extensionNames = expectedExtensionNames;
    versions = builtins.mapAttrs (
      _name: extension: extension.version
    ) checkedExtensionManifest.extensions;
    nodePtyVersion = "1.2.0-beta.14";
  };
  probeWorkingDirectory = pkgs.runCommand "pi-agent-validator-probe-cwd" { } ''
    mkdir -p "$out"
  '';
  source =
    builtins.replaceStrings
      [
        "__PI_AGENT_VALIDATOR_STATUS_EXECUTABLE__"
        "__PI_AGENT_VALIDATOR_MANAGED_CONFIG__"
        "__PI_AGENT_VALIDATOR_CREDENTIAL_POLICY__"
        "__PI_AGENT_VALIDATOR_PI_PACKAGE_ROOT__"
        "__PI_AGENT_VALIDATOR_CONTEXT_RECOVERY_MANIFEST__"
        "__PI_AGENT_VALIDATOR_EXTENSION_PACKAGE_ROOT__"
        "__PI_AGENT_VALIDATOR_PROFILE_PACKAGE_ROOT__"
        "__PI_AGENT_VALIDATOR_PROBE_CWD__"
        "PI_AGENT_VALIDATOR_PACKAGE_CONTRACT_PLACEHOLDER"
        "PI_AGENT_VALIDATOR_PROFILE_CONTRACT_PLACEHOLDER"
        "PI_AGENT_VALIDATOR_EXTENSION_CONTRACT_PLACEHOLDER"
      ]
      [
        "${statusPackage}/bin/pi-agent-status"
        "${statusPackage}/share/pi-agent/managed-config.json"
        "${credentialRuntimeModule}/lib/pi-agent/credential-policy.mjs"
        (toString checkedPiPackage)
        "${contextRecoveryEvidence}/manifest.json"
        (toString extensionPackage)
        (toString checkedProfileCatalog.package)
        (toString probeWorkingDirectory)
        (builtins.toJSON packageContract)
        (builtins.toJSON profileContract)
        (builtins.toJSON extensionContract)
      ]
      (builtins.readFile ./pi-agent-validate.mjs);
  sourceFile = pkgs.writeText "pi-agent-validate.mjs" source;
in
pkgs.runCommand "pi-agent-runtime-validator"
  {
    nativeBuildInputs = [ pkgs.coreutils ];
  }
  ''
    mkdir -p "$out/bin" "$out/lib/pi-agent"
    install -m444 ${sourceFile} "$out/lib/pi-agent/validate.mjs"
    cat > "$out/bin/pi-agent-validate.mjs" <<EOF
    #!${pkgs.nodejs}/bin/node
    try {
      const { runRuntimeCompatibilityValidatorCli } = await import("../lib/pi-agent/validate.mjs");
      process.exitCode = await runRuntimeCompatibilityValidatorCli();
    } catch {
      process.exitCode = 2;
    }
    EOF
    chmod 0555 "$out/bin/pi-agent-validate.mjs"
    ln -s pi-agent-validate.mjs "$out/bin/pi-agent-validate"
  ''
