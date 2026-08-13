{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;
  resolverPackage =
    defaultState:
    import (repoRoot + "/scripts/pi-agent-sandbox-resolver.nix") {
      inherit defaultState pkgs;
    };
  trappedExecutables = pkgs.runCommand "pi-agent-sandbox-resolver-trapped-executables" { } ''
    mkdir -p "$out/bin"
    cat > "$out/bin/nono" <<'SCRIPT'
    #!${pkgs.runtimeShell}
    printf 'nono\n' >> "''${PI_AGENT_TASK54_EXEC_TRACE:?}"
    exit 97
    SCRIPT
    cat > "$out/bin/pi" <<'SCRIPT'
    #!${pkgs.runtimeShell}
    printf 'pi\n' >> "''${PI_AGENT_TASK54_EXEC_TRACE:?}"
    exit 98
    SCRIPT
    chmod +x "$out/bin/nono" "$out/bin/pi"
  '';
  withTraps =
    defaultState:
    pkgs.symlinkJoin {
      name = "pi-agent-sandbox-resolver-${defaultState}-fixture";
      paths = [
        (resolverPackage defaultState)
        trappedExecutables
      ];
    };
  auditPackage = withTraps "audit";
  tamperedPackage =
    name: artifact: from: to:
    pkgs.runCommand "pi-agent-sandbox-resolver-${name}-fixture" { } ''
      mkdir -p "$out"
      cp -R -L ${auditPackage}/. "$out/"
      chmod -R u+w "$out"
      substituteInPlace "$out/${artifact}" \
        --replace-fail ${lib.escapeShellArg from} ${lib.escapeShellArg to}
    '';
  fixtures = {
    packages = pkgs.linkFarm "pi-agent-sandbox-resolver-fixtures" [
      {
        name = "disabled";
        path = withTraps "disabled";
      }
      {
        name = "audit";
        path = auditPackage;
      }
      {
        name = "enforced";
        path = withTraps "enforced";
      }
      {
        name = "tampered-catalog";
        path =
          tamperedPackage "tampered-catalog" "share/pi-agent/nono/catalog.json" "pi-review"
            "pi-reviev";
      }
      {
        name = "tampered-default";
        path =
          tamperedPackage "tampered-default" "share/pi-agent/sandbox/default.json" ''"defaultState":"audit"''
            ''"defaultState":"enforced"'';
      }
    ];
  };
in
fixtures.${fixture} or (throw "unknown Pi sandbox-resolver fixture: ${fixture}")
