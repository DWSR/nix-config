{ lib, ... }: {
  programs.starship = {
    enable = true;

    settings = {
      "$schema" = "https://starship.rs/config-schema.json";

      format = lib.concatStrings [
        # Left element
        "[](fg:nord0)"
        "$directory"
        "[](bg:nord1 fg:nord0)"
        "$git_branch"
        "$git_status"
        "$git_metrics"
        "[](nord0 fg:nord1)"
        "$fill"

        # Center element
        "[](fg:nord1)"
        "$time"
        "$c"
        "$cmake"
        "$dart"
        "$deno"
        "$dotnet"
        "$elixir"
        "$elm"
        "$erlang"
        "$golang"
        "$python"
        "$gradle"
        "$haskell"
        "$helm"
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
        "$terraform"
        "$vagrant"
        "$zig"
        "$conda"
        "$crystal"
        "[](nord0 fg:nord3)"
        "$fill"

        # Right element
        "[](nord0 fg:nord3)"
        "$nix_shell"
        "$direnv"
        "$cmd_duration"
        "$status"
        "[](nord0 fg:nord3)"
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
        format = "[ $time]($style)";
        style = "bg:nord0";
      };

      character = {
        success_symbol = "[](bold green)";
        error_symbol = "[](bold red)";
        vimcmd_symbol = "[](bold yellow)";
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
        symbol = "[](bg:nord3 fg:nord11)";
        success_symbol = "[](fg:nord14)";
        not_executable_symbol = "[🛇](fg:nord11)";
        not_found_symbol = "[󰍉](fg:nord11)";
        sigint_symbol = "[](fg:nord13)";
        signal_symbol = "[](fg:nord11)";
        disabled = false;
      };

      fill = {
        symbol = "─";
        style = "fg:nord3";
      };

      cmd_duration = {
        min_time = 0;
        format = "[$duration]($style)";
        style = "fg:nord13";
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
        style = "bg:nord2 fg:nord4";
        format = "[ $symbol $branch ]($style)";
      };

      git_status = {
        style = "bg:nord2 fg:nord4";
        format = "[$all_status$ahead_behind ]($style)";
      };

      git_metrics = {
        disabled = false;
        added_style = "bg:nord2 fg:nord14";
        deleted_style = "bg:nord2 fg:nord11";
        format = "[+$added ]($added_style)[-$deleted ]($deleted_style)";
      };

      # languages
      c = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      crystal = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      dart = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      deno = {
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      dotnet = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      erlang = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      elixir = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      elm = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      golang = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      python = {
        symbol = " ";
        python_binary = "python3";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) (($virtualenv)) ]($style)";
      };

      kotlin = {
        symbol = "󱈙 ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      lua = {
        symbol = "󰢱 ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      ocaml = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      perl = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      purescript = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      red = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      ruby = {
        symbol = "󰴭 ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      swift = {
        symbol = "󰛥 ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      zig = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      # tools
      cmake = {
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      conda = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      gradle = {
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      helm = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      kubernetes = {
        symbol = "󱃾 ";
        format = "on [$symbol $context(($namespace))]($style) ";
        style = "blue bold";
        disabled = false;
      };

      nix_shell = {
        symbol = " 󱄅";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      terraform = {
        symbol = "󱁢 ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };

      vagrant = {
        symbol = " ";
        style = "bg:nord3 fg:nord4";
        format = "[ $symbol ($version) ]($style)";
      };
    };
  };
}
