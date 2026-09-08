{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  inherit (pkgs) lib;
  renderer = import (repoRoot + "/home-manager/common/pi-agent/profiles.nix") {
    inherit lib pkgs;
  };
  profileNames = [
    "pi-audit"
    "pi-managed"
    "pi-review"
  ];

  piPackageModuleRoot = "lib/node_modules/@earendil-works/pi-coding-agent";
  piParserRelativePath = "${piPackageModuleRoot}/dist/cli/args.js";
  piManifestRelativePath = "${piPackageModuleRoot}/package.json";
  fakePiSource = pkgs.writeText "pi-agent-task-5-5-fake-pi.mjs" (
    "#!${pkgs.nodejs}/bin/node\n"
    + builtins.readFile (repoRoot + "/tests/pi-agent/fixtures/sandbox-executor/fake-pi.mjs")
  );
  malformedParser = pkgs.writeText "malformed-pi-args-parser.mjs" ''
    export function parseArgs(
  '';
  mkPiPackage =
    {
      name,
      declaredPname ? "pi-coding-agent",
      declaredVersion ? "0.83.0",
      postInstall ? "",
    }:
    pkgs.runCommand "pi-coding-agent-0.83.0-${name}"
      {
        pname = declaredPname;
        version = declaredVersion;
      }
      ''
        mkdir -p "$out/bin" "$out/lib/node_modules/@earendil-works"
        for dependency in ${pkgs.pi-agent}/lib/node_modules/*; do
          dependency_name="$(basename "$dependency")"
          if [ "$dependency_name" != "@earendil-works" ]; then
            ln -s "$dependency" "$out/lib/node_modules/$dependency_name"
          fi
        done
        for dependency in ${pkgs.pi-agent}/lib/node_modules/@earendil-works/*; do
          dependency_name="$(basename "$dependency")"
          if [ "$dependency_name" != "pi-coding-agent" ]; then
            ln -s "$dependency" "$out/lib/node_modules/@earendil-works/$dependency_name"
          fi
        done
        cp -R -L \
          ${pkgs.pi-agent}/lib/node_modules/@earendil-works/pi-coding-agent \
          "$out/lib/node_modules/@earendil-works/pi-coding-agent"
        chmod -R u+w "$out/lib/node_modules/@earendil-works/pi-coding-agent"
        cp ${fakePiSource} "$out/bin/pi"
        substituteInPlace "$out/bin/pi" \
          --replace-fail \
            "__PI_AGENT_PI_PARSER_MODULE__" \
            "$out/${piParserRelativePath}"
        chmod 0555 "$out/bin/pi"
        ${postInstall}
      '';
  probePi = mkPiPackage { name = "probe"; };
  missingPi = mkPiPackage {
    name = "missing-executable";
    postInstall = ''
      chmod 0444 "$out/bin/pi"
    '';
  };
  missingParserPi = mkPiPackage {
    name = "missing-parser";
    postInstall = ''
      rm "$out/${piParserRelativePath}"
    '';
  };
  tamperedParserPi = mkPiPackage {
    name = "tampered-parser";
    postInstall = ''
      substituteInPlace "$out/${piParserRelativePath}" \
        --replace-fail 'arg === "--provider"' 'arg === "--providEr"'
    '';
  };
  malformedParserPi = mkPiPackage {
    name = "malformed-parser";
    postInstall = ''
      cp ${malformedParser} "$out/${piParserRelativePath}"
    '';
  };
  missingManifestPi = mkPiPackage {
    name = "missing-manifest";
    postInstall = ''
      rm "$out/${piManifestRelativePath}"
    '';
  };
  tamperedManifestPi = mkPiPackage {
    name = "tampered-manifest";
    postInstall = ''
      substituteInPlace "$out/${piManifestRelativePath}" \
        --replace-fail '"version": "0.83.0"' '"version": "0.83.1"'
    '';
  };
  wrongVersionPi = mkPiPackage {
    name = "wrong-version";
    declaredVersion = "0.84.0";
  };
  metadataFreePi = pkgs.writeTextFile {
    name = "metadata-free-pi";
    destination = "/bin/pi";
    executable = true;
    text = "#!${pkgs.runtimeShell}\nexit 0\n";
  };

  mkNono =
    mode:
    let
      source =
        builtins.replaceStrings
          [
            "__REAL_NONO__"
            "__MODE__"
          ]
          [
            "${pkgs.nono}/bin/nono"
            mode
          ]
          (builtins.readFile (repoRoot + "/tests/pi-agent/fixtures/sandbox-executor/fake-nono.mjs"));
    in
    pkgs.writeTextFile {
      name = "pi-agent-task-5-5-fake-nono-${mode}";
      destination = "/bin/nono";
      executable = true;
      text = "#!${pkgs.nodejs}/bin/node\n" + source;
    };
  fakeNono = mkNono "normal";
  wrongVersionNono = mkNono "wrong-version";
  runFailureNono = mkNono "run-failure";
  manifestFileOverlapNono = mkNono "manifest-file-overlap";
  unavailableNono = pkgs.runCommand "pi-agent-task-5-5-unavailable-nono" { } ''
    mkdir -p "$out/bin"
    cp ${
      pkgs.writeText "unavailable-nono" (
        builtins.readFile (repoRoot + "/tests/pi-agent/fixtures/sandbox-executor/fake-nono.mjs")
      )
    } "$out/bin/nono"
    chmod 0444 "$out/bin/nono"
  '';

  mkCatalogPackage =
    name: profiles:
    let
      profileFiles = lib.mapAttrs (
        profileName: profile: pkgs.writeText "${profileName}.json" (builtins.toJSON profile)
      ) profiles;
      installProfiles = lib.concatMapStringsSep "\n" (profileName: ''
        cp ${profileFiles.${profileName}} "$out/share/pi-agent/nono/profiles/${profileName}.json"
      '') profileNames;
      resolveProfiles = lib.concatMapStringsSep "\n" (profileName: ''
        ${pkgs.nono}/bin/nono profile validate --strict "$out/share/pi-agent/nono/profiles/${profileName}.json" >/dev/null
        ${pkgs.nono}/bin/nono profile show "$out/share/pi-agent/nono/profiles/${profileName}.json" --json --silent \
          | ${pkgs.jq}/bin/jq -S . > "$out/share/pi-agent/nono/resolved/${profileName}.json"
      '') profileNames;
      catalogFile = pkgs.writeText "pi-agent-task-5-5-catalog.json" (builtins.toJSON renderer.catalog);
    in
    pkgs.runCommand "pi-agent-task-5-5-profile-catalog-${name}" { } ''
      export HOME="$TMPDIR/home"
      export TMPDIR="$TMPDIR/private-tmp"
      export XDG_CACHE_HOME="$HOME/.cache"
      export XDG_CONFIG_HOME="$HOME/.config"
      export XDG_DATA_HOME="$HOME/.local/share"
      export XDG_STATE_HOME="$HOME/.local/state"
      export NONO_NO_UPDATE_CHECK=1
      mkdir -p \
        "$out/share/pi-agent/nono/profiles" \
        "$out/share/pi-agent/nono/resolved" \
        "$XDG_CONFIG_HOME/nono/profiles" \
         "$HOME/.pi/agent" \
        "$TMPDIR/pi-agent"
      ${installProfiles}
      cp ${catalogFile} "$out/share/pi-agent/nono/catalog.json"
      ${resolveProfiles}
    '';
  mkCatalog = name: profiles: {
    inherit (renderer) catalog nonoVersion;
    package = mkCatalogPackage name profiles;
  };
  replaceManaged = profile: renderer.profiles // { pi-managed = profile; };
  replaceReview = profile: renderer.profiles // { pi-review = profile; };
  managed = renderer.profiles.pi-managed;
  review = renderer.profiles.pi-review;
  missingMcpCatalog = mkCatalog "missing-mcp" (
    replaceManaged (
      managed
      // {
        network = managed.network // {
          open_port = [ ];
        };
      }
    )
  );
  missingPackageCatalog = mkCatalog "missing-package" (
    replaceManaged (
      managed
      // {
        groups = managed.groups // {
          include = builtins.filter (group: group != "nix_runtime") managed.groups.include;
        };
        filesystem = managed.filesystem // {
          deny = managed.filesystem.deny ++ [ "/nix/store" ];
        };
      }
    )
  );
  missingAgentCatalog = mkCatalog "missing-agent" (
    replaceManaged (
      managed
      // {
        filesystem = managed.filesystem // {
          allow = builtins.filter (value: value != "$HOME/.pi/agent") managed.filesystem.allow;
          deny = managed.filesystem.deny ++ [ "$HOME/.pi/agent" ];
        };
      }
    )
  );
  missingTempCatalog = mkCatalog "missing-temp" (
    replaceManaged (
      managed
      // {
        filesystem = managed.filesystem // {
          allow = builtins.filter (value: value != "$TMPDIR/pi-agent") managed.filesystem.allow;
          deny = managed.filesystem.deny ++ [ "$TMPDIR/pi-agent" ];
        };
      }
    )
  );
  wrongWorkspaceCatalog = mkCatalog "wrong-workspace" (
    replaceManaged (managed // { workdir.access = "read"; })
  );
  deniedWorkspaceCatalog = mkCatalog "denied-workspace" (
    replaceManaged (
      managed
      // {
        filesystem = managed.filesystem // {
          deny = managed.filesystem.deny ++ [ "$WORKDIR" ];
        };
      }
    )
  );
  missingEnvironmentCatalog = mkCatalog "missing-environment" (
    replaceManaged (
      managed
      // {
        environment = managed.environment // {
          allow_vars = builtins.filter (value: value != "SHOPIFY_PI_TOKEN") managed.environment.allow_vars;
        };
      }
    )
  );
  wrongProcessCatalog = mkCatalog "wrong-process" (
    replaceManaged (
      managed
      // {
        security = managed.security // {
          process_info_mode = "isolated";
          signal_mode = "isolated";
        };
      }
    )
  );
  reviewWriteAncestorCatalog = mkCatalog "review-write-ancestor" (
    replaceReview (
      review
      // {
        filesystem = review.filesystem // {
          allow = review.filesystem.allow ++ [ "$WORKDIR/.." ];
        };
      }
    )
  );
  reviewWriteDescendantCatalog = mkCatalog "review-write-descendant" (
    replaceReview (
      review
      // {
        filesystem = review.filesystem // {
          allow = review.filesystem.allow ++ [ "$WORKDIR/output" ];
        };
      }
    )
  );
  reviewWritePrefixSiblingCatalog = mkCatalog "review-write-prefix-sibling" (
    replaceReview (
      review
      // {
        filesystem = review.filesystem // {
          allow = review.filesystem.allow ++ [ "$WORKDIR-other" ];
        };
      }
    )
  );
  reviewDenyAncestorCatalog = mkCatalog "review-deny-ancestor" (
    replaceReview (
      review
      // {
        filesystem = review.filesystem // {
          deny = review.filesystem.deny ++ [ "$HOME/.pi" ];
        };
      }
    )
  );

  mkExecutor =
    {
      defaultState ? "enforced",
      nonoPackage ? fakeNono,
      piPackage ? probePi,
      profileCatalog ? renderer,
    }:
    import (repoRoot + "/scripts/pi-agent-sandbox-executor.nix") {
      inherit
        defaultState
        nonoPackage
        piPackage
        profileCatalog
        ;
      pkgs = pkgs // {
        pi-agent = piPackage;
      };
    };
  enforced = mkExecutor { };
  production = import (repoRoot + "/scripts/pi-agent-sandbox-executor.nix") {
    inherit pkgs;
    defaultState = "enforced";
    piPackage = pkgs.pi-agent;
    nonoPackage = fakeNono;
    profileCatalog = renderer;
  };
  tamper =
    name: package: command:
    pkgs.runCommand "pi-agent-task-5-5-${name}" { } ''
      mkdir -p "$out"
      cp -R -L ${package}/. "$out/"
      chmod -R u+w "$out"
      ${command}
    '';
  malformedParserHelper = pkgs.writeText "malformed-pi-args-parser-helper.mjs" ''
    process.stdout.write("{not-json\n");
  '';
  packages = pkgs.linkFarm "pi-agent-task-5-5-executor-fixtures" [
    {
      name = "production";
      path = production;
    }
    {
      name = "enforced";
      path = enforced;
    }
    {
      name = "audit";
      path = mkExecutor { defaultState = "audit"; };
    }
    {
      name = "disabled";
      path = mkExecutor {
        defaultState = "disabled";
        nonoPackage = unavailableNono;
      };
    }
    {
      name = "missing-mcp";
      path = mkExecutor { profileCatalog = missingMcpCatalog; };
    }
    {
      name = "missing-package";
      path = mkExecutor { profileCatalog = missingPackageCatalog; };
    }
    {
      name = "missing-agent";
      path = mkExecutor { profileCatalog = missingAgentCatalog; };
    }
    {
      name = "missing-temp";
      path = mkExecutor { profileCatalog = missingTempCatalog; };
    }
    {
      name = "wrong-workspace";
      path = mkExecutor { profileCatalog = wrongWorkspaceCatalog; };
    }
    {
      name = "denied-workspace";
      path = mkExecutor { profileCatalog = deniedWorkspaceCatalog; };
    }
    {
      name = "missing-environment";
      path = mkExecutor { profileCatalog = missingEnvironmentCatalog; };
    }
    {
      name = "wrong-process";
      path = mkExecutor { profileCatalog = wrongProcessCatalog; };
    }
    {
      name = "review-write-ancestor";
      path = mkExecutor { profileCatalog = reviewWriteAncestorCatalog; };
    }
    {
      name = "review-write-descendant";
      path = mkExecutor { profileCatalog = reviewWriteDescendantCatalog; };
    }
    {
      name = "review-write-prefix-sibling";
      path = mkExecutor { profileCatalog = reviewWritePrefixSiblingCatalog; };
    }
    {
      name = "review-deny-ancestor";
      path = mkExecutor { profileCatalog = reviewDenyAncestorCatalog; };
    }
    {
      name = "review-file-overlap";
      path = mkExecutor { nonoPackage = manifestFileOverlapNono; };
    }
    {
      name = "unavailable-nono";
      path = mkExecutor { nonoPackage = unavailableNono; };
    }
    {
      name = "wrong-version-nono";
      path = mkExecutor { nonoPackage = wrongVersionNono; };
    }
    {
      name = "run-failure";
      path = mkExecutor { nonoPackage = runFailureNono; };
    }
    {
      name = "missing-pi";
      path = mkExecutor { piPackage = missingPi; };
    }
    {
      name = "missing-profile";
      path = tamper "missing-profile" enforced ''
        rm "$out/share/pi-agent/nono/profiles/pi-managed.json"
      '';
    }
    {
      name = "tampered-catalog";
      path = tamper "tampered-catalog" enforced ''
        substituteInPlace "$out/share/pi-agent/nono/catalog.json" \
          --replace-fail "pi-review" "pi-reviev"
      '';
    }
    {
      name = "tampered-profile";
      path = tamper "tampered-profile" enforced ''
        substituteInPlace "$out/share/pi-agent/nono/profiles/pi-managed.json" \
          --replace-fail "pi-managed coding profile" "pi-managed altered profile"
      '';
    }
    {
      name = "tampered-resolved";
      path = tamper "tampered-resolved" enforced ''
        substituteInPlace "$out/share/pi-agent/nono/resolved/pi-managed.json" \
          --replace-fail "pi-managed coding profile" "pi-managed altered profile"
      '';
    }
    {
      name = "missing-parser";
      path = mkExecutor { piPackage = missingParserPi; };
    }
    {
      name = "tampered-parser";
      path = mkExecutor { piPackage = tamperedParserPi; };
    }
    {
      name = "malformed-parser";
      path = mkExecutor { piPackage = malformedParserPi; };
    }
    {
      name = "missing-pi-manifest";
      path = mkExecutor { piPackage = missingManifestPi; };
    }
    {
      name = "tampered-pi-manifest";
      path = mkExecutor { piPackage = tamperedManifestPi; };
    }
    {
      name = "missing-parser-helper";
      path = tamper "missing-parser-helper" enforced ''
        rm "$out/lib/pi-agent/pi-args-parser-helper.mjs"
      '';
    }
    {
      name = "tampered-parser-helper";
      path = tamper "tampered-parser-helper" enforced ''
        substituteInPlace "$out/lib/pi-agent/pi-args-parser-helper.mjs" \
          --replace-fail 'const MAX_INPUT_BYTES' 'const MAX_INPUT_BYTEZ'
      '';
    }
    {
      name = "tampered-parser-node-digest";
      path = tamper "tampered-parser-node-digest" enforced ''
        substituteInPlace "$out/lib/pi-agent/sandbox-executor.mjs" \
          --replace-fail 'parserNode: "' 'parserNode: "0'
      '';
    }
    {
      name = "malformed-parser-helper";
      path = tamper "malformed-parser-helper" enforced ''
        old_digest="$(sha256sum "$out/lib/pi-agent/pi-args-parser-helper.mjs" | cut -d ' ' -f1)"
        cp ${malformedParserHelper} "$out/lib/pi-agent/pi-args-parser-helper.mjs"
        new_digest="$(sha256sum "$out/lib/pi-agent/pi-args-parser-helper.mjs" | cut -d ' ' -f1)"
        substituteInPlace "$out/lib/pi-agent/sandbox-executor.mjs" \
          --replace-fail "$old_digest" "$new_digest"
      '';
    }
    {
      name = "probe-pi";
      path = probePi;
    }
    {
      name = "parser-pi";
      path = pkgs.pi-agent;
    }
  ];
in
if fixture == "packages" then
  packages
else if fixture == "wrong-pi-version" then
  mkExecutor { piPackage = wrongVersionPi; }
else if fixture == "metadata-free-pi" then
  mkExecutor { piPackage = metadataFreePi; }
else if fixture == "unselected-pi" then
  import (repoRoot + "/scripts/pi-agent-sandbox-executor.nix") {
    inherit pkgs;
    defaultState = "enforced";
    piPackage = probePi;
  }
else
  throw "unknown Pi sandbox executor fixture: ${fixture}"
