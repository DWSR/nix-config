{ lib, pkgs }:
let
  expectedNonoVersion = "0.69.0";
  nonoVersion = pkgs.nono.version;
  profileNames = [
    "pi-audit"
    "pi-managed"
    "pi-review"
  ];
  profileTopLevelKeys = [
    "environment"
    "extends"
    "filesystem"
    "groups"
    "meta"
    "network"
    "security"
    "workdir"
  ];

  source = {
    repository = "https://github.com/nolabs-ai/nono-packs";
    revision = "b61adcb636a2bdbffd1aea29586993cc8f3aa552";
    hash = "sha256-3gMOrcBcFkqSNyttSFGnQcdiHwMQeSJ198GU0sjWFjo=";
    packagePath = "pi";
    packageVersion = "0.2.0";
    policyPath = "pi/policy.json";
    policyVersion = "1.0.0";
  };
  license = {
    identifier = "Apache-2.0";
    declaredBy = "pi/package.json";
    licensePath = "share/pi-agent/nono/LICENSE-Apache-2.0.txt";
    noticePath = "share/pi-agent/nono/NOTICE";
    textSource = "https://www.apache.org/licenses/LICENSE-2.0.txt";
    textHash = "sha256-z8d0m5b2O9McPEK1xHG/dWgUBT6EfBDz6wA0F7xSPTA=";
  };
  upstreamSource = pkgs.fetchFromGitHub {
    owner = "nolabs-ai";
    repo = "nono-packs";
    rev = source.revision;
    inherit (source) hash;
  };
  licenseText = pkgs.fetchurl {
    url = license.textSource;
    hash = license.textHash;
  };
  notice = pkgs.writeText "pi-agent-nono-NOTICE" ''
    Pi nono profile catalog

    This catalog contains adapted standalone profiles derived from:
    - Source: ${source.repository}
    - Revision: ${source.revision}
    - Package: pi ${source.packageVersion}
    - Policy: ${source.policyPath} (policy version ${source.policyVersion})

    The pinned package metadata at ${license.declaredBy} declares the source
    policy under ${license.identifier}. The complete canonical license text is
    distributed at ${license.licensePath}.

    Local modifications remove runtime pack wiring, credential routes, git
    configuration, LaunchServices, and profile drafts; they add the explicit
    managed, audit, and review sandbox postures.
  '';

  runtimeGroups = [
    "node_runtime"
    "rust_runtime"
    "python_runtime"
    "user_caches_macos"
    "nix_runtime"
    "unlink_protection"
  ];
  statePaths = [
    "$HOME/.pi/agent"
    "$XDG_DATA_HOME/cavemem"
    "$TMPDIR/pi-agent"
  ];
  sensitiveDirectories = [
    "$HOME/.1password"
    "$HOME/.aws"
    "$HOME/.azure"
    "$HOME/.config/gcloud"
    "$HOME/.config/gh"
    "$HOME/.config/git"
    "$HOME/.config/op"
    "$HOME/.docker"
    "$HOME/.gnupg"
    "$HOME/.kube"
    "$HOME/.ssh"
    "$HOME/Library/Application Support/1Password"
    "$HOME/Library/Keychains"
  ];
  requiredEnvironmentNames = [
    "CAVEMEM_DATA_DIR"
    "COLORTERM"
    "HOME"
    "LANG"
    "LC_ALL"
    "LC_CTYPE"
    "LOGNAME"
    "NIX_SSL_CERT_FILE"
    "NO_COLOR"
    "PATH"
    "PI_AGENT_BASH_TIMEOUT_MS"
    "PI_AGENT_LAUNCH_ID"
    "PI_CODING_AGENT_DIR"
    "SHELL"
    "SHOPIFY_PI_TOKEN"
    "SSL_CERT_FILE"
    "TERM"
    "TERM_PROGRAM"
    "TMPDIR"
    "USER"
    "XDG_CACHE_HOME"
    "XDG_CONFIG_HOME"
    "XDG_DATA_HOME"
    "XDG_STATE_HOME"
  ];
  deniedEnvironmentNames = [
    "AI_GATEWAY_API_KEY"
    "ANTHROPIC_*"
    "AWS_*"
    "AZURE_*"
    "CLOUDFLARE_*"
    "COPILOT_*"
    "GEMINI_API_KEY"
    "GOOGLE_*"
    "GROQ_API_KEY"
    "OPENAI_API_KEY"
    "OPENROUTER_API_KEY"
    "SSH_AUTH_SOCK"
    "XAI_API_KEY"
  ];
  postures = {
    pi-audit = {
      description = "pi-audit compatibility profile with unrestricted diagnostic egress";
      networkBlock = false;
      networkPolicy = "unrestricted-audit";
      processMode = "allow_same_sandbox";
      workspaceAccess = "readwrite";
    };
    pi-managed = {
      description = "pi-managed coding profile awaiting a validated runtime provider host";
      networkBlock = true;
      networkPolicy = "runtime-provider-host-required";
      processMode = "allow_same_sandbox";
      workspaceAccess = "readwrite";
    };
    pi-review = {
      description = "pi-review profile with a read-only workspace and isolated process control";
      networkBlock = true;
      networkPolicy = "runtime-provider-host-required";
      processMode = "isolated";
      workspaceAccess = "read";
    };
  };

  mkProfile =
    name:
    let
      posture = postures.${name};
    in
    {
      extends = [ "default" ];
      meta = {
        inherit name;
        version = "1.0.0-pi-agent.1";
        inherit (posture) description;
        author = "DWSR, adapted from nolabs-ai/pi 0.2.0";
      };
      groups.include = runtimeGroups;
      security = {
        signal_mode = posture.processMode;
        process_info_mode = posture.processMode;
        ipc_mode = "shared_memory_only";
        capability_elevation = false;
      };
      filesystem = {
        allow = statePaths;
        read = [ ];
        deny = sensitiveDirectories;
      };
      network = {
        block = posture.networkBlock;
        allow_domain = [ ];
        open_port = [ 8080 ];
        listen_port = [ ];
      };
      environment = {
        allow_vars = requiredEnvironmentNames;
        deny_vars = deniedEnvironmentNames;
      };
      workdir.access = posture.workspaceAccess;
    };

  fail = name: message: throw "pi-agent profile ${name}: ${message}";
  requiredField =
    name: path: value: field:
    if builtins.isAttrs value && builtins.hasAttr field value then
      value.${field}
    else
      fail name "missing required field ${path}${field}";
  require =
    name: message: condition:
    if condition then true else fail name message;
  exactFields =
    name: path: expected: value:
    require name "${path} fields must be exactly ${lib.concatStringsSep ", " expected}" (
      builtins.isAttrs value && builtins.attrNames value == expected
    );
  validateProfile =
    name: profile:
    let
      posture = postures.${name};
      extends = requiredField name "" profile "extends";
      meta = requiredField name "" profile "meta";
      groups = requiredField name "" profile "groups";
      security = requiredField name "" profile "security";
      filesystem = requiredField name "" profile "filesystem";
      network = requiredField name "" profile "network";
      environment = requiredField name "" profile "environment";
      workdir = requiredField name "" profile "workdir";
      metaName = requiredField name "meta." meta "name";
      metaVersion = requiredField name "meta." meta "version";
      metaDescription = requiredField name "meta." meta "description";
      metaAuthor = requiredField name "meta." meta "author";
      includedGroups = requiredField name "groups." groups "include";
      signalMode = requiredField name "security." security "signal_mode";
      processInfoMode = requiredField name "security." security "process_info_mode";
      ipcMode = requiredField name "security." security "ipc_mode";
      capabilityElevation = requiredField name "security." security "capability_elevation";
      filesystemAllow = requiredField name "filesystem." filesystem "allow";
      filesystemRead = requiredField name "filesystem." filesystem "read";
      filesystemDeny = requiredField name "filesystem." filesystem "deny";
      networkBlock = requiredField name "network." network "block";
      networkAllowDomain = requiredField name "network." network "allow_domain";
      networkOpenPort = requiredField name "network." network "open_port";
      networkListenPort = requiredField name "network." network "listen_port";
      environmentAllowVars = requiredField name "environment." environment "allow_vars";
      environmentDenyVars = requiredField name "environment." environment "deny_vars";
      workdirAccess = requiredField name "workdir." workdir "access";
      requiredValues = [
        extends
        metaName
        metaVersion
        metaDescription
        metaAuthor
        includedGroups
        signalMode
        processInfoMode
        ipcMode
        capabilityElevation
        filesystemAllow
        filesystemRead
        filesystemDeny
        networkBlock
        networkAllowDomain
        networkOpenPort
        networkListenPort
        environmentAllowVars
        environmentDenyVars
        workdirAccess
      ];
      checks = [
        (exactFields name "top-level" profileTopLevelKeys profile)
        (exactFields name "meta" [ "author" "description" "name" "version" ] meta)
        (exactFields name "groups" [ "include" ] groups)
        (exactFields name "security" [
          "capability_elevation"
          "ipc_mode"
          "process_info_mode"
          "signal_mode"
        ] security)
        (exactFields name "filesystem" [ "allow" "deny" "read" ] filesystem)
        (exactFields name "network" [ "allow_domain" "block" "listen_port" "open_port" ] network)
        (exactFields name "environment" [ "allow_vars" "deny_vars" ] environment)
        (exactFields name "workdir" [ "access" ] workdir)
        (require name "extends must be exactly [default]" (extends == [ "default" ]))
        (require name "meta.name must match the catalog key" (metaName == name))
        (require name "meta.version must identify the adapted policy" (metaVersion == "1.0.0-pi-agent.1"))
        (require name "meta.description must be non-empty" (
          builtins.isString metaDescription && metaDescription != ""
        ))
        (require name "meta.author must identify the adaptation" (
          metaAuthor == "DWSR, adapted from nolabs-ai/pi 0.2.0"
        ))
        (require name "groups.include must retain only the reviewed runtime groups" (
          includedGroups == runtimeGroups
        ))
        (require name "security.signal_mode must match the posture" (signalMode == posture.processMode))
        (require name "security.process_info_mode must match the posture" (
          processInfoMode == posture.processMode
        ))
        (require name "security.ipc_mode must remain shared_memory_only" (ipcMode == "shared_memory_only"))
        (require name "security.capability_elevation must be false" (capabilityElevation == false))
        (require name "filesystem.allow must grant $HOME/.pi/agent readwrite" (
          builtins.elem "$HOME/.pi/agent" filesystemAllow
        ))
        (require name "filesystem.allow must grant $XDG_DATA_HOME/cavemem readwrite" (
          builtins.elem "$XDG_DATA_HOME/cavemem" filesystemAllow
        ))
        (require name "filesystem.allow must grant $TMPDIR/pi-agent readwrite" (
          builtins.elem "$TMPDIR/pi-agent" filesystemAllow
        ))
        (require name "filesystem.allow must contain only writable Pi, Cavemem, and private-temp state" (
          filesystemAllow == statePaths
        ))
        (require name "filesystem.read must be explicitly empty" (filesystemRead == [ ]))
        (require name "filesystem.deny must contain the complete credential-directory set" (
          filesystemDeny == sensitiveDirectories
        ))
        (require name "network.block must match the posture" (networkBlock == posture.networkBlock))
        (require name "network.allow_domain must remain empty until runtime host validation" (
          networkAllowDomain == [ ]
        ))
        (require name "network.open_port must be exactly [8080]" (networkOpenPort == [ 8080 ]))
        (require name "network.listen_port must be empty" (networkListenPort == [ ]))
        (require name "environment.allow_vars must match the root-Pi contract" (
          environmentAllowVars == requiredEnvironmentNames
        ))
        (require name "environment.deny_vars must match the credential deny set" (
          environmentDenyVars == deniedEnvironmentNames
        ))
        (require name "workdir.access must be ${posture.workspaceAccess}" (
          workdirAccess == posture.workspaceAccess
        ))
      ];
    in
    builtins.deepSeq requiredValues (builtins.deepSeq checks profile);
  validateProfiles =
    candidate:
    if builtins.attrNames candidate != profileNames then
      throw "pi-agent profile catalog must contain exactly ${lib.concatStringsSep ", " profileNames}"
    else
      lib.mapAttrs validateProfile candidate;

  profiles = validateProfiles (lib.genAttrs profileNames mkProfile);
  contracts = lib.mapAttrs (name: _profile: {
    mcpPort = 8080;
    providerHost = null;
    agentDirAccess = "readwrite";
    cavememDirAccess = "readwrite";
    tempDirAccess = "readwrite";
    workspaceAccess = postures.${name}.workspaceAccess;
    processMode = postures.${name}.processMode;
    inherit requiredEnvironmentNames;
  }) profiles;
  catalog = {
    schemaVersion = 1;
    inherit license nonoVersion source;
    profiles = lib.mapAttrs (name: _profile: {
      sourcePath = "share/pi-agent/nono/profiles/${name}.json";
      resolvedPath = "share/pi-agent/nono/resolved/${name}.json";
      networkPolicy = postures.${name}.networkPolicy;
      grantContract = contracts.${name};
    }) profiles;
  };
  profileFiles = lib.mapAttrs (
    name: profile: pkgs.writeText "${name}.json" (builtins.toJSON profile)
  ) profiles;
  catalogFile = pkgs.writeText "pi-agent-nono-catalog.json" (builtins.toJSON catalog);
  installProfiles = lib.concatMapStringsSep "\n" (name: ''
    cp ${profileFiles.${name}} "$out/share/pi-agent/nono/profiles/${name}.json"
    cp ${profileFiles.${name}} "$XDG_CONFIG_HOME/nono/profiles/${name}.json"
  '') profileNames;
  validateProfilesInBuild = lib.concatMapStringsSep "\n" (
    name:
    let
      posture = postures.${name};
      block = if posture.networkBlock then "true" else "false";
    in
    ''
      profile="$out/share/pi-agent/nono/profiles/${name}.json"
      resolved="$out/share/pi-agent/nono/resolved/${name}.json"
      manifest="$validation_dir/${name}.manifest.json"

      nono profile validate --strict "$profile" >/dev/null
      nono profile show "${name}" --json --silent | jq -S . > "$resolved"
      jq -e \
        --arg name "${name}" \
        --arg process_mode "${posture.processMode}" \
        --arg workspace_access "${posture.workspaceAccess}" \
        --argjson network_block ${block} \
        '(. | keys | sort) == ["description", "extends", "filesystem", "groups", "name", "network", "rollback", "security", "workdir"]
          and .name == $name
          and .extends == ["default"]
          and .security.signal_mode == $process_mode
          and .security.process_info_mode == $process_mode
          and .security.ipc_mode == "shared_memory_only"
          and .security.capability_elevation == false
          and .network.block == $network_block
          and .network.open_port == [8080]
          and .network.listen_port == []
          and .workdir.access == $workspace_access
          and (.groups.include | index("git_config") | not)
          and .network.credentials == []' \
        "$resolved" >/dev/null

      nono profile show "${name}" --format manifest --silent > "$manifest"
      jq -e \
        --arg process_mode "${posture.processMode}" \
        --arg workspace_access "${posture.workspaceAccess}" \
        --arg workspace "$workspace" \
        --arg home "$HOME" \
        --arg data "$XDG_DATA_HOME" \
        --arg tmp "$TMPDIR" \
        '(. | keys | sort) == ["$schema", "filesystem", "network", "process", "version"]
          and .process.signal_mode == $process_mode
          and .process.process_info_mode == $process_mode
          and .process.ipc_mode == "shared_memory_only"
          and any(.filesystem.grants[]; .path == ($home + "/.pi/agent") and .access == "readwrite")
          and any(.filesystem.grants[]; .path == ($data + "/cavemem") and .access == "readwrite")
          and any(.filesystem.grants[]; .path == ($tmp + "/pi-agent") and .access == "readwrite")
          and any(.filesystem.grants[]; .path == $workspace and .access == $workspace_access)
          and any(.filesystem.grants[]; .path == "/nix/store" and .access == "read")
          and .network.ports.localhost == [8080]' \
        "$manifest" >/dev/null

    ''
  ) profileNames;

  package =
    assert lib.assertMsg (nonoVersion == expectedNonoVersion)
      "pi-agent profiles require pkgs.nono ${expectedNonoVersion}, got ${nonoVersion}; revalidate the catalog before changing the selected nono";
    pkgs.runCommand "pi-agent-nono-profile-catalog-1.0.0"
      {
        nativeBuildInputs = [
          pkgs.jq
          pkgs.nono
        ];
      }
      ''
        set -euo pipefail

        jq -e \
          '.schema_version == 1
            and .name == "pi"
            and .version == "${source.packageVersion}"
            and .license == "${license.identifier}"
            and .min_nono_version == "0.55.0"' \
          ${upstreamSource}/${source.packagePath}/package.json >/dev/null
        jq -e \
          '.extends == "default"
            and .meta.version == "${source.policyVersion}"
            and (.groups.include | index("node_runtime") != null)
            and (.groups.include | index("git_config") != null)
            and .allow_launch_services == true
            and (.filesystem.allow | index("$NONO_CONFIG/profile-drafts") != null)' \
          ${upstreamSource}/${source.policyPath} >/dev/null

        build_root="$TMPDIR/pi-agent-profile-validation"
        export HOME="$build_root/home"
        export TMPDIR="$build_root/private-tmp"
        export XDG_CACHE_HOME="$HOME/.cache"
        export XDG_CONFIG_HOME="$HOME/.config"
        export XDG_DATA_HOME="$HOME/.local/share"
        export XDG_STATE_HOME="$HOME/.local/state"
        export NONO_NO_UPDATE_CHECK=1
        workspace="$build_root/workspace"
        validation_dir="$build_root/validation"

        mkdir -p \
          "$out/share/pi-agent/nono/profiles" \
          "$out/share/pi-agent/nono/resolved" \
          "$XDG_CONFIG_HOME/nono/profiles" \
          "$XDG_DATA_HOME/cavemem" \
          "$HOME/.pi/agent" \
          "$TMPDIR/pi-agent" \
          "$workspace" \
          "$validation_dir"

        ${installProfiles}
        cp ${catalogFile} "$out/share/pi-agent/nono/catalog.json"
        cp ${licenseText} "$out/${license.licensePath}"
        cp ${notice} "$out/${license.noticePath}"
        nono profile schema >/dev/null

        cd "$workspace"
        ${validateProfilesInBuild}
      '';
in
{
  inherit
    catalog
    contracts
    nonoVersion
    package
    profiles
    source
    validateProfiles
    ;
}
