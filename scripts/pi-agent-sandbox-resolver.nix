{
  defaultState,
  pkgs,
}:
let
  acceptedStates = [
    "disabled"
    "audit"
    "enforced"
  ];
  checkedDefaultState =
    if builtins.elem defaultState acceptedStates then
      defaultState
    else
      throw "pi-agent sandbox resolver: default state must be disabled, audit, or enforced";
  profileCatalog = import ../home-manager/common/pi-agent/profiles.nix {
    inherit (pkgs) lib;
    inherit pkgs;
  };
  catalogJson = builtins.toJSON profileCatalog.catalog;
  defaultArtifactJson = builtins.toJSON {
    defaultState = checkedDefaultState;
    schemaVersion = 1;
  };
  source = builtins.readFile ./pi-agent-sandbox-resolver.mjs;
  resolverModule = pkgs.writeTextFile {
    name = "pi-agent-sandbox-resolver-module-${checkedDefaultState}";
    destination = "/lib/pi-agent/sandbox-resolver.mjs";
    text =
      builtins.replaceStrings
        [
          "__PI_AGENT_SANDBOX_CATALOG_DIGEST__"
          "__PI_AGENT_SANDBOX_DEFAULT_DIGEST__"
        ]
        [
          (builtins.hashString "sha256" catalogJson)
          (builtins.hashString "sha256" defaultArtifactJson)
        ]
        source;
  };
  defaultArtifact = pkgs.writeTextFile {
    name = "pi-agent-sandbox-default-${checkedDefaultState}";
    destination = "/share/pi-agent/sandbox/default.json";
    text = defaultArtifactJson;
  };
in
pkgs.runCommand "pi-agent-sandbox-resolver-${checkedDefaultState}" { } ''
  mkdir -p "$out"
  cp -R -L ${profileCatalog.package}/. "$out/"
  chmod -R u+w "$out"
  cp -R -L ${resolverModule}/. "$out/"
  chmod -R u+w "$out"
  cp -R -L ${defaultArtifact}/. "$out/"
''
