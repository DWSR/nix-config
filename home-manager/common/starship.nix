{ lib, ... }:
let
  defaultLangOpts = s: {
    symbol = s;
    format = "[ $symbol ($version) ]($style)";
    style = "bg:nord1 fg:nord4";
  };

  defaultToolOpts = s: {
    symbol = s;
    format = "[ $symbol ($version) ]($style)";
    style = "bg:nord3 fg:nord4";
  };

  firstBlockSep = "[](bg:nord1 fg:nord0)";
  secondBlockSep = "[](bg:nord3 fg:nord1)";
  endSep = "[](nord0 fg:nord1)";

in {
  programs.starship = {
    enable = true;

    settings = {
      "$schema" = "https://starship.rs/config-schema.json";

      format = lib.concatStrings [
        # Left element
        "[](fg:nord0)"
        "$directory"
        firstBlockSep
        "$git_branch"
        "$git_status"
        "$git_metrics"
        endSep
        "$fill"

        # Center element
        "[](fg:nord0)"
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
        "$scale"
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
        "[](fg:nord0)"
        "$nix_shell"
        "$direnv"
        "$cmd_duration"
        firstBlockSep
        "$status"
        endSep
        "$line_break"
        "$character"
      ];

      # theming
      palette = "nord";

      palettes.nord = {
        nord0 = "#2E3440";
        nord1 = "#3B4252";
        nord2 = "#434C5E";
        nord3 = "#4C566A";
        nord4 = "#D8DEE9";
        nord11 = "#BF616A";
        nord13 = "#EBCB8B";
        nord14 = "#A2BE8A";
      };

      # general
      scan_timeout = 50;
      command_timeout = 1000;
      add_newline = true;

      time = {
        disabled = false;
        format = "[ $time ]($style)";
        style = "bg:nord0 fg:nord13";
      };

      character = {
        success_symbol = "[](bold nord14)";
        error_symbol = "[](bold nord11)";
        vimcmd_symbol = "[](bold nord13)";
      };

      username = {
        disabled = false;
        style_root = "bg:nord0 fg:nord11";
        style_user = "bg:nord0 fg:nord4";
        format = "[$user]($style)";
        show_always = true;
      };

      hostname = {
        disabled = false;
        ssh_only = false;
        ssh_symbol = " ";
        trim_at = ".";
        format = "[$hostname$ssh_symbol]($style)";
        style = "bg:nord0 fg:nord4";
      };

      os = {
        disabled = false;
        format = "[ $symbol ]($style)";
        style = "bg:nord0 fg:nord4";

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
        style = "bg:nord0 fg:nord4";
        disabled = false;
        read_only = " 󰌾 ";
        read_only_style = "bg:nord0 fg:nord11";
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
        symbol = "[](bg:nord0 fg:nord11)";
        success_symbol = "[](bg:nord0 fg:nord14)";
        not_executable_symbol = "[🛇](bg:nord0 fg:nord11)";
        not_found_symbol = "[󰍉](bg:nord0 fg:nord11)";
        sigint_symbol = "[](bg:nord0 fg:nord13)";
        signal_symbol = "[](bg:nord0 fg:nord11)";
        disabled = false;
      };

      fill = {
        symbol = "─";
        style = "fg:nord3";
      };

      cmd_duration = {
        min_time = 0;
        format = "[ $duration]($style)";
        style = "bg:nord1 fg:nord13";
      };

      direnv = {
        disabled = false;
        format = "[ $symbol $loaded/$allowed ]($style)";
        style = "bg:nord3 fg:nord4";
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
        style = "bg:nord1 fg:nord13";
        format = "[ $symbol $branch ]($style)";
      };

      git_status = {
        style = "bg:nord1 fg:nord13";
        format = "[$all_status$ahead_behind]($style)";
      };

      git_metrics = {
        disabled = false;
        added_style = "bg:nord1 fg:nord14";
        deleted_style = "bg:nord1 fg:nord11";
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
        style = "bg:nord3 fg:nord4";
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
