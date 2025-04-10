{ pkgs, homebrew, home-manager, ... }:
let
  username = "brandonmcnama";
in
{
  environment.systemPackages = with pkgs; [
    neovim
    atuin
    kubectl
    k9s
    mise
    direnv
    lunarvim
    openssh
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
    "raycast"
    "homerow"
    "loopback"
    "audio-hijack"
    "slack"
    "deskflow"
    "keymapp"
  ];
}
