{
  fixture,
  flake,
  repoSource,
}:
let
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  renderer = import (repoSource + "/home-manager/common/pi-agent/profiles.nix") {
    inherit (pkgs) lib;
    inherit pkgs;
  };
  inherit (renderer) profiles;
  validate = value: builtins.deepSeq (renderer.validateProfiles value) true;
in
if fixture == "catalog" then
  {
    inherit (renderer)
      catalog
      contracts
      nonoVersion
      profiles
      source
      ;
    nono = "${pkgs.nono}/bin/nono";
    package = renderer.package.outPath;
    packageHasOutputContext = builtins.getContext renderer.package.outPath != { };
    packageIsDerivation = pkgs.lib.isDerivation renderer.package;
    packageOutputName = renderer.package.outputName;
  }
else if fixture == "package" then
  renderer.package
else if fixture == "missing-environment" then
  validate (profiles // { pi-managed = builtins.removeAttrs profiles.pi-managed [ "environment" ]; })
else if fixture == "missing-mcp-port" then
  validate (
    profiles
    // {
      pi-managed = profiles.pi-managed // {
        network = builtins.removeAttrs profiles.pi-managed.network [ "open_port" ];
      };
    }
  )
else if fixture == "missing-signal-policy" then
  validate (
    profiles
    // {
      pi-audit = profiles.pi-audit // {
        security = builtins.removeAttrs profiles.pi-audit.security [ "signal_mode" ];
      };
    }
  )
else if fixture == "review-writable" then
  validate (
    profiles
    // {
      pi-review = profiles.pi-review // {
        workdir.access = "readwrite";
      };
    }
  )
else if fixture == "missing-pi-state" then
  validate (
    profiles
    // {
      pi-managed = profiles.pi-managed // {
        filesystem = profiles.pi-managed.filesystem // {
          allow = builtins.filter (path: path != "$HOME/.pi/agent") profiles.pi-managed.filesystem.allow;
        };
      };
    }
  )
else if fixture == "missing-private-temp" then
  validate (
    profiles
    // {
      pi-managed = profiles.pi-managed // {
        filesystem = profiles.pi-managed.filesystem // {
          allow = builtins.filter (path: path != "$TMPDIR/pi-agent") profiles.pi-managed.filesystem.allow;
        };
      };
    }
  )
else
  throw "unknown Pi profile catalog fixture: ${fixture}"
