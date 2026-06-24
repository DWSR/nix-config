{ lib, ... }:
let
  defaultLangOpts = s: {
    symbol = s;
    format = "[ $symbol ($version) ]($style)";
    style = "bg:base01 fg:base04";
  };

  defaultToolOpts = s: {
    symbol = s;
    format = "[ $symbol ($version) ]($style)";
    style = "bg:base03 fg:base04";
  };

  firstBlockSep = "[](bg:base01 fg:base00)";
  secondBlockSep = "[](bg:base03 fg:base01)";
  endSep = "[](base00 fg:base01)";

in
{
  programs.starship = {
    enable = true;

    settings = {
      "$schema" = "https://starship.rs/config-schema.json";

      format = lib.concatStrings [
        # Left element
        "[](fg:base00)"
        "$directory"
        firstBlockSep
        "$git_branch"
        "$git_status"
        "$git_metrics"
        endSep
        "$fill"

        # Center element
        "[](fg:base00)"
        "$time"
        firstBlockSep
        "$c"
        "$crystal"
        "$dart"
        "$deno"
        "$dotnet"
        "$elixir"
        "$elm"
        "$erlang"
        "$golang"
        "$python"
        "$haskell"
        "$java"
        "$julia"
        "$kotlin"
        "$lua"
        "$nodejs"
        "$nim"
        "$ocaml"
        "$perl"
        "$php"
        "$purescript"
        "$red"
        "$ruby"
        "$rust"
        "$scala"
        "$swift"
        "$zig"
        secondBlockSep
        "$cmake"
        "$gradle"
        "$helm"
        "$terraform"
        "$vagrant"
        "$conda"
        endSep
        "$fill"

        # Right element
        "[](fg:base00)"
        "$nix_shell"
        "$direnv"
        "$cmd_duration"
        firstBlockSep
        "$status"
        endSep
        "$line_break"
        "$character"
      ];

      # general
      scan_timeout = 50;
      command_timeout = 1000;
      add_newline = true;

      time = {
        disabled = false;
        format = "[ $time ]($style)";
        style = "bg:base00 fg:base0A";
      };

      character = {
        success_symbol = "[](bold base0B)";
        error_symbol = "[](bold base08)";
        vimcmd_symbol = "[](bold base0A)";
      };

      username = {
        disabled = false;
        style_root = "bg:base00 fg:base08";
        style_user = "bg:base00 fg:base04";
        format = "[$user]($style)";
        show_always = true;
      };

      hostname = {
        disabled = false;
        ssh_only = false;
        ssh_symbol = " ";
        trim_at = ".";
        format = "[$hostname$ssh_symbol]($style)";
        style = "bg:base00 fg:base04";
      };

      os = {
        disabled = false;
        format = "[ $symbol ]($style)";
        style = "bg:base00 fg:base04";

        symbols = {
          Alpaquita = " ";
          Alpine = " ";
          Amazon = " ";
          Android = " ";
          Arch = " ";
          Artix = " ";
          CentOS = " ";
          Debian = " ";
          DragonFly = " ";
          Emscripten = " ";
          EndeavourOS = " ";
          Fedora = " ";
          FreeBSD = " ";
          Garuda = "󰛓 ";
          Gentoo = " ";
          HardenedBSD = "󰞌 ";
          Illumos = "󰈸 ";
          Linux = " ";
          Mabox = " ";
          Macos = " ";
          Manjaro = " ";
          Mariner = " ";
          MidnightBSD = " ";
          Mint = " ";
          NetBSD = " ";
          NixOS = " ";
          OpenBSD = "󰈺 ";
          openSUSE = " ";
          OracleLinux = "󰌷 ";
          Pop = " ";
          Raspbian = " ";
          Redhat = " ";
          RedHatEnterprise = " ";
          Redox = "󰀘 ";
          Solus = "󰠳 ";
          SUSE = " ";
          Ubuntu = " ";
          Unknown = " ";
          Windows = "󰍲 ";
        };
      };

      directory = {
        truncation_length = 3;
        truncate_to_repo = true;
        format = "[ $path ]($style)[$read_only]($read_only_style)";
        style = "bg:base00 fg:base04";
        disabled = false;
        read_only = " 󰌾 ";
        read_only_style = "bg:base00 fg:base08";
        truncation_symbol = "/";

        substitutions = {
          "Documents" = "󰈙 ";
          "Dokumente" = "󰈙 ";
          "Downloads" = " ";
          "Music" = " ";
          "Musik" = " ";
          "Pictures" = " ";
          "Bilder" = " ";
          "Projects" = " ";
          "src" = " ";
          "repos" = " ";
        };
      };

      status = {
        format = "[ $symbol ]($style)";
        style = "bold";
        symbol = "[](bg:base00 fg:base08)";
        success_symbol = "[](bg:base00 fg:base0B)";
        not_executable_symbol = "[🛇](bg:base00 fg:base08)";
        not_found_symbol = "[󰍉](bg:base00 fg:base08)";
        sigint_symbol = "[](bg:base00 fg:base0A)";
        signal_symbol = "[](bg:base00 fg:base08)";
        disabled = false;
      };

      fill = {
        symbol = "─";
        style = "fg:base03";
      };

      cmd_duration = {
        min_time = 0;
        format = "[ $duration]($style)";
        style = "bg:base01 fg:base0A";
      };

      direnv = {
        disabled = false;
        format = "[ $symbol $loaded/$allowed ]($style)";
        style = "bg:base03 fg:base04";
        symbol = " ";
        allowed_msg = "a";
        not_allowed_msg = "n";
        denied_msg = "d";
        loaded_msg = "l";
        unloaded_msg = "u";
      };

      # git
      git_branch = {
        symbol = "";
        style = "bg:base01 fg:base0A";
        format = "[ $symbol $branch ]($style)";
      };

      git_status = {
        style = "bg:base01 fg:base0A";
        format = "[$all_status$ahead_behind]($style)";
      };

      git_metrics = {
        disabled = false;
        added_style = "bg:base01 fg:base0B";
        deleted_style = "bg:base01 fg:base08";
        format = "[+$added ]($added_style)[-$deleted ]($deleted_style)";
      };

      # languages
      c = defaultLangOpts "";
      crystal = defaultLangOpts " ";
      dart = defaultLangOpts "";
      deno = defaultLangOpts "";
      dotnet = defaultLangOpts "";
      erlang = defaultLangOpts "";
      elixir = defaultLangOpts "";
      elm = defaultLangOpts "";
      golang = defaultLangOpts "";
      kotlin = defaultLangOpts "󱈙";
      lua = defaultLangOpts "󰢱";
      ocaml = defaultLangOpts "";
      perl = defaultLangOpts "";
      purescript = defaultLangOpts "";
      red = defaultLangOpts " ";
      ruby = defaultLangOpts "󰴭";
      swift = defaultLangOpts "󰛥";
      zig = defaultLangOpts "";

      python = {
        symbol = "";
        python_binary = "python3";
        style = "bg:base03 fg:base04";
        format = "[ $symbol ($version) (($virtualenv)) ]($style)";
      };

      # tools
      cmake = defaultToolOpts "";
      conda = defaultToolOpts " ";
      gradle = defaultToolOpts "";
      helm = defaultToolOpts "";
      kubernetes = defaultToolOpts "󱃾";
      nix_shell = defaultToolOpts "󱄅";
      terraform = defaultToolOpts "󱁢";
      vagrant = defaultToolOpts "";
    };
  };
}
