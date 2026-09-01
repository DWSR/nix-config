{
  defaultState,
  piPackage,
  pkgs,
  nonoPackage ? pkgs.nono,
  profileCatalog ? import ../home-manager/common/pi-agent/profiles.nix {
    inherit (pkgs) lib;
    inherit pkgs;
  },
}:
let
  expectedPiPname = "pi-coding-agent";
  expectedPiVersion = "0.83.0";
  checkedPiPackage =
    if
      (piPackage.pname or null) == expectedPiPname
      && (piPackage.version or null) == expectedPiVersion
      && builtins.toString piPackage == builtins.toString pkgs.pi-agent
    then
      piPackage
    else
      throw "pi-agent sandbox executor: selected Pi package is not the reviewed pi-coding-agent 0.83.0 runtime";
  piPackageRoot = "${checkedPiPackage}";
  piPackageModuleRoot = "${piPackageRoot}/lib/node_modules/@earendil-works/pi-coding-agent";
  piPackageManifest = "${piPackageModuleRoot}/package.json";
  piParserModule = "${piPackageModuleRoot}/dist/cli/args.js";
  catalogJson = builtins.toJSON profileCatalog.catalog;
  catalogDigest = builtins.hashString "sha256" catalogJson;
  resolverPackage = import ./pi-agent-sandbox-resolver.nix {
    inherit defaultState pkgs;
  };
  parserHelperSource = pkgs.writeText "pi-agent-args-parser-helper.mjs" (
    builtins.replaceStrings [ "__PI_AGENT_PI_PARSER_MODULE__" ] [ piParserModule ] (
      builtins.readFile ./pi-agent-sandbox-parser-helper.mjs
    )
  );
  source =
    builtins.replaceStrings
      [
        "__PI_AGENT_SANDBOX_RESOLVER_MODULE__"
        "PI_AGENT_EXPECTED_CATALOG_PLACEHOLDER"
        "__PI_AGENT_EXECUTOR_CATALOG_DIGEST__"
        "__PI_AGENT_NONO_VERSION__"
        "__PI_AGENT_NONO_EXECUTABLE__"
        "__PI_AGENT_PI_EXECUTABLE__"
        "__PI_AGENT_PI_PACKAGE_ROOT__"
        "__PI_AGENT_PI_PACKAGE_MANIFEST__"
        "__PI_AGENT_PI_PARSER_MODULE__"
        "__PI_AGENT_PARSER_NODE_EXECUTABLE__"
      ]
      [
        "${resolverPackage}/lib/pi-agent/sandbox-resolver.mjs"
        catalogJson
        catalogDigest
        profileCatalog.nonoVersion
        "${nonoPackage}/bin/nono"
        "${checkedPiPackage}/bin/pi"
        piPackageRoot
        piPackageManifest
        piParserModule
        "${pkgs.nodejs}/bin/node"
      ]
      (builtins.readFile ./pi-agent-sandbox-executor.mjs);
  sourceFile = pkgs.writeText "pi-agent-sandbox-executor.mjs" source;
in
pkgs.runCommand "pi-agent-sandbox-executor-${defaultState}"
  {
    nativeBuildInputs = [ pkgs.coreutils ];
  }
  ''
    mkdir -p "$out"
    cp -R -L ${resolverPackage}/. "$out/"
    chmod -R u+w "$out"
    cp -R -L ${profileCatalog.package}/. "$out/"
    chmod -R u+w "$out"
    mkdir -p "$out/lib/pi-agent"
    cp ${sourceFile} "$out/lib/pi-agent/sandbox-executor.mjs"
    cp ${parserHelperSource} "$out/lib/pi-agent/pi-args-parser-helper.mjs"

    nono_digest="$(sha256sum "${nonoPackage}/bin/nono" | cut -d ' ' -f1)"
    pi_digest="$(sha256sum "${checkedPiPackage}/bin/pi" | cut -d ' ' -f1)"
    parser_node_digest="$(sha256sum "${pkgs.nodejs}/bin/node" | cut -d ' ' -f1)"
    pi_parser_helper_digest="$(sha256sum "$out/lib/pi-agent/pi-args-parser-helper.mjs" | cut -d ' ' -f1)"
    audit_source_digest="$(sha256sum "$out/share/pi-agent/nono/profiles/pi-audit.json" | cut -d ' ' -f1)"
    audit_resolved_digest="$(sha256sum "$out/share/pi-agent/nono/resolved/pi-audit.json" | cut -d ' ' -f1)"
    managed_source_digest="$(sha256sum "$out/share/pi-agent/nono/profiles/pi-managed.json" | cut -d ' ' -f1)"
    managed_resolved_digest="$(sha256sum "$out/share/pi-agent/nono/resolved/pi-managed.json" | cut -d ' ' -f1)"
    review_source_digest="$(sha256sum "$out/share/pi-agent/nono/profiles/pi-review.json" | cut -d ' ' -f1)"
    review_resolved_digest="$(sha256sum "$out/share/pi-agent/nono/resolved/pi-review.json" | cut -d ' ' -f1)"

    substituteInPlace "$out/lib/pi-agent/sandbox-executor.mjs" \
      --replace-fail "__PI_AGENT_NONO_EXECUTABLE_DIGEST__" "$nono_digest" \
      --replace-fail "__PI_AGENT_PI_EXECUTABLE_DIGEST__" "$pi_digest" \
      --replace-fail "__PI_AGENT_PARSER_NODE_EXECUTABLE_DIGEST__" "$parser_node_digest" \
      --replace-fail "__PI_AGENT_PI_PARSER_HELPER_DIGEST__" "$pi_parser_helper_digest" \
      --replace-fail "__PI_AGENT_PI_AUDIT_SOURCE_DIGEST__" "$audit_source_digest" \
      --replace-fail "__PI_AGENT_PI_AUDIT_RESOLVED_DIGEST__" "$audit_resolved_digest" \
      --replace-fail "__PI_AGENT_PI_MANAGED_SOURCE_DIGEST__" "$managed_source_digest" \
      --replace-fail "__PI_AGENT_PI_MANAGED_RESOLVED_DIGEST__" "$managed_resolved_digest" \
      --replace-fail "__PI_AGENT_PI_REVIEW_SOURCE_DIGEST__" "$review_source_digest" \
      --replace-fail "__PI_AGENT_PI_REVIEW_RESOLVED_DIGEST__" "$review_resolved_digest"
  ''
