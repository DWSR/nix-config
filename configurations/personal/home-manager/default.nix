{
  inputs,
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.home.mcp) readKeychainSecret;
in
{
  imports = [
    # Local override of inputs.op-shell-plugins.hmModules.default to silence
    # the `programs.zsh.initExtra is deprecated` home-manager warning until
    # upstream migrates to `initContent`. See op-shell-plugins.nix for details.
    ./op-shell-plugins.nix

    ../../../home-manager/common
    ../../../home-manager/mcp
    ./deskflow.nix
    ./fabro-cli.nix
    ./git.nix
    ./omlx.nix
    ./opencode.nix
    ./sqlite-backup.nix
  ];

  disabledModules = [
    # Replaced by ./op-shell-plugins.nix above.
    "${inputs.op-shell-plugins}/nix/home-manager.nix"
  ];

  home = {
    stateVersion = "26.05";

    omlx.enable = true;

    packages = with pkgs; [
      butane
      fastmail-mcp
      flyctl
      ghq
      git-issue-tracker
      hcloud
      kagimcp
      nh
      omlx
      slack-mcp-server
      vfkit
      wireshark
    ];

    mcp = {
      githubToken = readKeychainSecret "mcp-github-token";

      gitMcpSigning = {
        enable = true;
        identityLabel = "git-mcp-Brandons-MacBook-Pro";
        ctkPublicKeyHash = "1369125950525141027de79370edc83f4f38cd9a";
        sshPublicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBLn2sYSgv7JkEHM8P9AiF/ol5L9TQRqyTT9VNoARiUNHFpuuxUmmXjkPHRM1bC/OaCUKFbK29Ew1I9G0ra7QyssAAAAEc3NoOg==";
        sshFingerprint = "SHA256:O5RAWRtioDIJp8b8X4276kiZNrqz2qTdszTfkk1cc8I";
        githubSigningKeyRegistered = true;
      };

      keychainSecrets = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
        "mcp-kagi-token" = "op://Private/Kagi/API Token";
        "mcp-fastmail-token" = "op://Private/Fastmail/API Tokens/mcp";
        "mcp-fastmail-username" = "op://Private/Fastmail/username";
        "mcp-fastmail-caldav-password" = "op://Private/Fastmail/App Passwords/MCP";
        "mcp-beeper-token" = "op://Private/Beeper/Desktop API Access Tokens/mcphub";
        "mcp-hangops-xoxc" = "op://Private/HangOps/Tokens/xoxc";
        "mcp-hangops-xoxd" = "op://Private/HangOps/Tokens/xoxd";
        "agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
        # Fabro dev-token login credential (the VM's dev-token auth pair is
        # the same 1Password item — secrets/fabro.fabro.yaml SESSION_SECRET
        # + FABRO_DEV_TOKEN). The fabro-login wrapper
        # (configurations/personal/home-manager/fabro-cli.nix) reads it
        # from the Keychain and runs the one-time `fabro auth login`
        # exchange against svc:fabro.
        "fabro-dev-token" = "op://Private/Fabro/Dev Token";
        # oMLX local inference server API key (secrets/mcp.personal.yaml
        # `omlx-api-key`). mcp-secrets-activate writes it to the Keychain
        # under -s mcpproxy -a omlx-api-key; the personal opencode wrapper
        # (configurations/personal/home-manager/opencode.nix) reads it and
        # exports OMLX_API_KEY for the provider.omlx `{env:...}` reference.
        "omlx-api-key" = "op://Private/oMLX/API Key";
        # mcpproxy daemon bearer (its `${env:MCP_PROXY_API_KEY}` top-level
        # api_key; formerly a bridge-owned non-1Password entry that the
        # 1Password sync silently dropped — now an ordinary item). One-time
        # seeding: copy the deployed value out of the Keychain
        # (`security find-generic-password -s mcpproxy -a mcpproxy-api-key -w`)
        # into the 1Password item, then run the sync as usual.
        "mcpproxy-api-key" = "op://Private/MCP Proxy/API Key";
        # OpenCode subscription API key (one key covers both the Go
        # subscription catalog and Zen pay-as-you-go). Sourced from
        # OpenCode Console; if opencode on this host is already connected,
        # the same key lives in ~/.local/share/opencode/auth.json.
        "opencode-api-key" = "op://Private/OpenCode/API Key";
      };

      # gh CLI auth token. Reuses the same PAT as mcp-github-token because
      # both consumers need the same GitHub repo / read scopes; the PAT is
      # already provisioned for mcphub's github MCP server. If you ever
      # need a separately-scoped gh CLI token, point this at a distinct
      # 1P item.
      ghAuthToken = "op://Private/GitHub/Tokens/Full Control";

      # Expose the same GitHub PAT to Nix as `access-tokens = github.com=…`
      # so `nix` / `darwin-rebuild` can fetch `github:` flake inputs and
      # tarballs without rate-limiting/auth failures. Reuses the existing
      # `mcp-github-token` secret; the sops bridge renders it into
      # /etc/nix/nix.conf.d/github-access-token.conf at activation.
      nixAccessTokenSecret = "mcp-github-token";

      extraServers = {
        kagi = {
          command = "${pkgs.kagimcp}/bin/kagimcp";
          env.KAGI_API_KEY = readKeychainSecret "mcp-kagi-token";
        };

        fastmail = {
          command = "${pkgs.fastmail-mcp}/bin/fastmail-mcp";
          env = {
            FASTMAIL_API_TOKEN = readKeychainSecret "mcp-fastmail-token";
            FASTMAIL_CALDAV_USERNAME = readKeychainSecret "mcp-fastmail-username";
            FASTMAIL_CALDAV_PASSWORD = readKeychainSecret "mcp-fastmail-caldav-password";
          };
        };

        grep-app = {
          command = "${pkgs.grep-app-mcp}/bin/grep-app-mcp";
        };

        ast-grep = {
          command = "${pkgs.ast-grep-mcp}/bin/ast-grep-mcp";
        };

        gh-stack-mcp = {
          command = "${pkgs.gh-stack-mcp}/bin/gh-stack-mcp";
        };

        beeper = {
          type = "http";
          url = "http://localhost:23373/v0/mcp";
          headers = {
            Authorization = "Bearer " + readKeychainSecret "mcp-beeper-token";
          };
        };

        slack-hangops = {
          command = "${pkgs.slack-mcp-server}/bin/slack-mcp-server";
          env = {
            SLACK_MCP_XOXC_TOKEN = readKeychainSecret "mcp-hangops-xoxc";
            SLACK_MCP_XOXD_TOKEN = readKeychainSecret "mcp-hangops-xoxd";
            SLACK_MCP_ENABLED_TOOLS = lib.strings.concatStringsSep "," [
              "conversations_history"
              "conversations_replies"
              "conversations_add_message"
              "reactions_add"
              "reactions_remove"
              "attachment_get_data"
              "conversations_search_messages"
              "channels_list"
              "usergroups_list"
              "usergroups_me"
              "usergroups_create"
              "usergroups_update"
              "usergroups_users_update"
            ];
          };
        };
      };
    };
  };

  programs.agentmemory = {
    enable = true;
    dataDir = "${config.xdg.dataHome}/agentmemory";
    runtimeDir = "${config.home.homeDirectory}/.agentmemory";
    logDir = "${config.home.homeDirectory}/Library/Logs/agentmemory";
    bearerReference = "agentmemory-bearer";
  };

  # NixOS Lima VM that hosts fabro. The launchd agent (dev.dwsr.lima-fabro)
  # keeps the instance up via limactl hostagent commands; the guest boots
  # the pinned upstream nixos-lima release image until a Linux builder
  # exists for the flake's own packages.aarch64-linux.fabro-vm-image. The
  # hostname provision makes the guest targetable as "fabro" and
  # guestSystem points lima-vm-deploy (no repo clone inside the guest) at
  # the flake's fabro-vm NixOS configuration.
  virtualisation.limaVM = {
    enable = true;
    hostname = "fabro";
    guestSystem = "fabro-vm";

    # The fabro server's state lives ON THE MAC: /var/lib/fabro in the
    # guest is this writable virtiofs share, so the fabro home and
    # storage subdirectories the guest service writes (home/, storage/)
    # are host files that survive VM recreation and get covered by the
    # usual backups of ~/.local. VZ maps the whole share to the Lima
    # cidata user (brandonmcnama), so the guest's fabro service runs as
    # that identity (configurations/fabro-vm/fabro.nix). CLI-era files
    # at the top level of ~/.local/state/fabro stay CLI-owned; the guest
    # owns only the home/ and storage/ subdirectories. Applies at
    # (re)create of the instance — the running instance's lima.yaml is
    # edited in place for live application.
    mounts = [
      {
        location = "~/.local/state/fabro";
        mountPoint = "/var/lib/fabro";
        writable = true;
      }
    ];
  };

  # macOS Lima guest that serves as the aarch64-darwin builder. Independent of
  # the fabro NixOS instance above (5.7): its own module, options, supervisor,
  # and launchd agents.
  virtualisation.limaMacGuest = {
    enable = true;
    package = pkgs.stdenv.mkDerivation {
      pname = "lima";
      version = "2.3.0-beta.1";
      src = pkgs.fetchurl {
        url = "https://github.com/lima-vm/lima/releases/download/v2.3.0-beta.1/lima-2.3.0-beta.1-Darwin-arm64.tar.gz";
        sha256 = "sha256-qh+m8a/5ff0AJiDwi3ac4n4K6K+8h2YDVeCvYt+fcjw=";
      };
      sourceRoot = ".";
      installPhase = ''
                mkdir -p $out
                cp -r ./* $out/
                cat > $out/lima.entitlements <<'ENTITLEMENTS'
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>com.apple.security.virtualization</key>
          <true/>
        </dict>
        </plist>
        ENTITLEMENTS
                /usr/bin/codesign --force --sign - --entitlements $out/lima.entitlements $out/bin/limactl
      '';
    };
    name = "mac-builder";
    image = {
      location = "https://updates.cdn-apple.com/2026FallFCS/59241290-5d51-4ca8-9df4-31624b9a4eac/UniversalMac_27.0.1_26A434_Restore.ipsw";
      digest = "sha256:2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1";
      arch = "aarch64";
    };
    cpus = 4;
    memory = "8GiB";
    disk = "64GiB";
    suppressFirstLoginSetup = true;
    forward = {
      enable = true;
      bindAddress = "0.0.0.0";
      port = 2222;
    };
    deploy = {
      enable = true;
      hostName = "mac-builder";
      ageKeySecretRef = "op://Private/sops-age-key-mac-builder";
    };
  };

  programs.ssh = {
    includes = [ "~/.orbstack/ssh/config" ];

    settings = {
      "192.168.1.1" = {
        User = "root";
        IdentitiesOnly = true;
        IdentityFile = "~/.ssh/unifi.pub";
        SetEnv.TERM = "xterm-256color";

        PasswordAuthentication = "no";
        HostKeyAlgorithms = "+ssh-rsa";
      };

      "192.168.1.69" = {
        User = "root";
        SetEnv.TERM = "xterm-256color";
        PasswordAuthentication = "yes";
      };
    };
  };

  programs.atuin.settings.sync_address = "https://atuin.mcnama.family";

  programs._1password-shell-plugins = {
    enable = true;

    plugins = with pkgs; [
      flyctl
      gh
      hcloud
    ];
  };

}
