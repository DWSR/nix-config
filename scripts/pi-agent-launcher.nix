{
  cavememPackage,
  credentialResolverPackage,
  credentialRuntimeModule,
  managedConfig,
  piPackage,
  pkgs,
  projectionFactory,
  providerHandoff ? null,
  reconcilerPackage,
  sandboxExecutorPackage,
  sandboxResolverPackage,
  statusPackage,
  validatorPackage,
  keychainExecutable ? "/usr/bin/security",
}:
let
  managedConfigBytes = builtins.readFile managedConfig;
  managedConfigValue = builtins.fromJSON (builtins.unsafeDiscardStringContext managedConfigBytes);
  providerMode = managedConfigValue.providerSelection.mode or null;
  checkedProviderHandoff =
    if providerMode == "shopify-gateway" && providerHandoff != null then
      "${providerHandoff}/lib/pi-agent/shopify-provider-handoff.mjs"
    else if providerMode == "personal" && providerHandoff == null then
      ""
    else
      throw "pi-agent launcher requires exactly the package-owned handoff for Shopify mode";
  probeWorkingDirectory = pkgs.runCommand "pi-agent-launcher-probe-cwd" { } ''
    mkdir -p "$out"
  '';
  source =
    builtins.replaceStrings
      [
        "__PI_AGENT_LAUNCHER_CREDENTIAL_RESOLVER__"
        "__PI_AGENT_LAUNCHER_CREDENTIAL_POLICY__"
        "__PI_AGENT_LAUNCHER_RECONCILER__"
        "__PI_AGENT_LAUNCHER_PROVIDER_HANDOFF__"
        "__PI_AGENT_LAUNCHER_PROJECTION_FACTORY__"
        "__PI_AGENT_LAUNCHER_SANDBOX_RESOLVER__"
        "__PI_AGENT_LAUNCHER_MANAGED_CONFIG__"
        "__PI_AGENT_LAUNCHER_MANAGED_CONFIG_DIGEST__"
        "__PI_AGENT_LAUNCHER_STATUS_CONFIG__"
        "__PI_AGENT_LAUNCHER_STATUS__"
        "__PI_AGENT_LAUNCHER_MCP_PROBE__"
        "__PI_AGENT_LAUNCHER_VALIDATOR__"
        "__PI_AGENT_LAUNCHER_CAVEMEM__"
        "__PI_AGENT_LAUNCHER_SANDBOX_VALIDATOR__"
        "__PI_AGENT_LAUNCHER_KEYCHAIN__"
        "__PI_AGENT_LAUNCHER_NODE__"
        "__PI_AGENT_LAUNCHER_PI_PACKAGE__"
        "__PI_AGENT_LAUNCHER_SANDBOX_EXECUTOR__"
        "__PI_AGENT_LAUNCHER_PROBE_CWD__"
        "__PI_AGENT_LAUNCHER_PROVIDER_MODE__"
      ]
      [
        "${credentialResolverPackage}/lib/pi-agent/credential-resolver.mjs"
        "${credentialRuntimeModule}/lib/pi-agent/credential-policy.mjs"
        "${reconcilerPackage}/lib/pi-agent/reconcile.mjs"
        checkedProviderHandoff
        "${projectionFactory}/bin/pi-agent-provider-projection"
        "${sandboxResolverPackage}/lib/pi-agent/sandbox-resolver.mjs"
        (toString managedConfig)
        (builtins.hashString "sha256" (builtins.unsafeDiscardStringContext managedConfigBytes))
        "${statusPackage}/share/pi-agent/managed-config.json"
        "${statusPackage}/bin/pi-agent-status"
        "${statusPackage}/lib/pi-agent/mcp-status-probe.mjs"
        "${validatorPackage}/bin/pi-agent-validate"
        "${cavememPackage}/bin/cavemem"
        "${sandboxResolverPackage}/lib/pi-agent/sandbox-validator.mjs"
        keychainExecutable
        "${pkgs.nodejs}/bin/node"
        (toString piPackage)
        "${sandboxExecutorPackage}/lib/pi-agent/sandbox-executor.mjs"
        (toString probeWorkingDirectory)
        providerMode
      ]
      (builtins.readFile ./pi-agent-launcher.mjs);
in
pkgs.writeTextFile {
  name = "pi-agent-launcher-${providerMode}";
  destination = "/lib/pi-agent/launcher.mjs";
  text = source;
}
