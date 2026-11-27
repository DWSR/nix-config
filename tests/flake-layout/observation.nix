# Live flake-layout observation consumed by the `flake-layout-baseline` check
# and by `baseline.py capture`. It records selector names (never derivation
# values), the personal host's registry/search-path aliases, and representative
# host package/SOPS wiring. Name discovery stays lazy so the observation does
# not force unrelated derivations.
{ self }:
let
  inherit (builtins) baseNameOf;
  names = attrs: builtins.attrNames attrs;
  systems = names self.checks;
  darwinHosts = names self.darwinConfigurations;
  nixosHosts = names self.nixosConfigurations;
  # Name the production subject explicitly. Selecting the first non-builder
  # host could silently switch the baseline when another Darwin host is added.
  personalHost = "Brandons-MacBook-Pro";
  personal = self.darwinConfigurations.${personalHost}.config;
  personalUser = builtins.head (names personal.home-manager.users);
  homeManager = personal.home-manager.users.${personalUser};
  personalSecrets = builtins.mapAttrs (_: secret: {
    inherit (secret) path owner mode;
  }) personal.sops.secrets;
  fabro = self.nixosConfigurations.fabro-vm.config;
  fabroSecrets = builtins.mapAttrs (_: secret: {
    inherit (secret) path owner mode;
  }) fabro.sops.secrets;
  pathTargets = map (key: "/etc/${key}") (
    builtins.filter (key: builtins.match "nix/path/.*" key != null) (names personal.environment.etc)
  );
in
{
  selectors = {
    inherit systems;
    checks = builtins.mapAttrs (_: names) self.checks;
    apps = builtins.mapAttrs (_: names) self.apps;
    devShells = builtins.mapAttrs (_: names) self.devShells;
    packages = builtins.mapAttrs (_: names) self.packages;
    formatter = names self.formatter;
    overlays = names self.overlays;
    lib = names self.lib;
    darwinConfigurations = darwinHosts;
    nixosConfigurations = nixosHosts;
  };
  registry = {
    registry_names = names personal.nix.registry;
    nix_path = personal.nix.nixPath;
    search_path_targets = pathTargets;
  };
  host_wiring = {
    personal_host = personalHost;
    darwin_hosts = darwinHosts;
    nixos_hosts = nixosHosts;
    personal_opencode_base_package = homeManager.home.opencode.basePackage.name;
    personal_opencode_package = homeManager.home.opencode.package.name;
    personal_sops_age_key = personal.sops.age.keyFile;
    personal_sops_default_store = baseNameOf personal.sops.defaultSopsFile;
    personal_sops_secrets = personalSecrets;
    fabro_sops_age_key = fabro.sops.age.keyFile;
    fabro_sops_default_store = baseNameOf fabro.sops.defaultSopsFile;
    fabro_sops_secrets = fabroSecrets;
  };
}
