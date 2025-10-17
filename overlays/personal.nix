{ pkgs, lib, config, homebrew, home-manager, nixvim, Neve, ... }:
let
  username = "brandonmcnama";
in
{
  home-manager = {
    users."${username}" = {
      imports = [nixvim.homeModules.nixvim];

      programs.nixvim = {
        enable = true;
        imports = [Neve.nixvimModule];
        defaultEditor = true;
        vimdiffAlias = true;
        colorschemes.catppuccin.enable = lib.mkForce false;
        colorschemes.nord.enable = true;
      };


      programs.git = {
        enable = true;

        aliases = {
          yolo = "!git add -A && git commit -m \"wip\" && git push";
          ignore = "!gi() { curl -sL https://www.toptal.com/developers/gitignore/api/$@ ;}; gi";
          roast = "blame";
          wip = "commit -m wip --no-verify";
          lol = "log --graph --oneline --decorate";
        };

        extraConfig = {
          push.autoRemoteSetup = true;
          commit.gpgSign = true;
          ghq.root = "~/repos";
          branch.sort = "-committerdate";
          init.defaultBranch = "main";
          rebase.updateRefs = true;
          pull.rebase = true;
          url."ssh://git@github.com/".insteadOf = ["https://github.com/" "https://git@github.com/"];
          help.autocorrect = 1;

          gpg = {
            format = "ssh";
            ssh.program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
          };
        };

        delta = {
          enable = true;
          options = {
            features = "decorations";
            interactive.keep-plus-minus-markers = false;
            decorations = {
              commit-decoration-style = "blue ol";
              commit-style = "raw";
              file-style = "omit";
              hunk-header-decoration-style = "blue box";
              hunk-header-file-style = "red";
              hunk-header-line-number-style = "#067a00";
              hunk-header-style = "file line-number syntax";
            };
          };
        };

        lfs.enable = true;
        maintenance.enable = true;

        signing = {
          format = "ssh";
          signByDefault = true;
          signer = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";
          key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJtopEfMT4upVKkHhfZfGQojwVTtzxoTsxFLdMvAgDsl";
        };

        userName = "Brandon McNama";
        userEmail = "brandonmcnama@outlook.com";
      };

      programs.ssh = {
        enable = true;
        compression = true;
        controlMaster = "auto";
        includes = ["~/.orbstack/ssh/config"];
        extraConfig = "IdentityAgent \"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";

        matchBlocks = {
          "192.168.1.1" = {
            user = "root";
            identitiesOnly = true;
            identityFile = "~/.ssh/unifi.pub";

            extraOptions = {
              "PasswordAuthentication" = "no";
              "HostKeyAlgorithms" = "+ssh-rsa";
            };
          };
        };
      };
    };
  };

  environment.systemPackages = with pkgs; [
    git
    neovim
    atuin
    gh
    eza
    fzf
    starship
    kubectl
    k9s
    mise
    direnv
    lunarvim
    openssh
    flyctl
    dyff
    _1password-cli
    cloc
    cosign
    crane
    curl
    entr
    rclone
    rsync
    readline
    tree
    viddy
    karabiner-elements
    obsidian
    alejandra
    yaml-language-server
    bash-language-server
    golangci-lint-langserver
    nerdfonts
    nodejs-slim_22
    apple-sdk
    zoom-us
    discord
    lazygit
    xz
  ];

  users.users."${username}" = {
    home = "/Users/${username}";
  };

  nix-homebrew.user = username;

  fonts.packages = with pkgs; [
    (nerdfonts.override { fonts = [ "Monaspace" ]; })
    pkgs.monaspace
  ];

  homebrew.casks = [
    "1password"
    "contexts"
    "domzilla-caffeine"
    "ghostty"
    "ears"
    "moom"
    "orbstack"
    "orion"
    "oversight"
    "pocket-casts"
    "raycast"
    "zsa-wally"
    "homerow"
    "obs"
    "loopback"
    "audio-hijack"
    "slack"
    "deskflow"
    "keymapp"
    "microsoft-teams"
  ];
}
