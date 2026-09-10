{
  pkgs,
  self,
}:
let
  hostName = "Brandons-MacBook-Pro";
  missingCiphertextHost = self.darwinConfigurations.${hostName}.extendModules {
    modules = [
      {
        sops.defaultSopsFile = pkgs.lib.mkForce ./fixtures/missing-agentmemory-bearer.yaml;
        sops.validateSopsFiles = pkgs.lib.mkForce false;
      }
    ];
  };
  summarize =
    system:
    let
      secret = system.config.sops.secrets."agentmemory-bearer";
      home = system.config.home-manager.users.brandonmcnama;
    in
    {
      activationUsesSecretBridge = pkgs.lib.hasInfix "/bin/mcp-secrets-activate" system.config.system.activationScripts.postActivation.text;
      bearerReference = home.programs.agentmemory.bearerReference;
      keychainReference = home.home.mcp.keychainSecrets."agentmemory-bearer";
      secretPath = toString secret.path;
      sopsFile = toString secret.sopsFile;
      validateSopsFiles = system.config.sops.validateSopsFiles;
    };
in
pkgs.writeText "agentmemory-personal-secret-validation.json" (
  builtins.toJSON {
    normal = summarize self.darwinConfigurations.${hostName};
    withoutCiphertext = summarize missingCiphertextHost;
  }
)
