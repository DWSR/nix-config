{ inputs, pkgs, ...}:
{
  programs.starship = {
    enable = true;

    settings = {
      format = "($username@)($hostname )($shlvl )($directory )($vcsh )($git_branch )($git_commit )($git_state )($git_status )($kubernetes)($docker_context )($package )($cmake )($dart )($deno )($dotnet )($elixir )($elm)($erlang)($golang)($helm)($java)($julia)($kotlin)($nim)($nodejs)($ocaml)($perl)($php)($purescript)($python)($red)($ruby)$rust$scala$swift$terraform$vagrant$zig$nix_shell$conda$memory_usage$aws$gcloud$env_var$crystal$custom$cmd_duration$line_break$lua$jobs$battery$time$status$shell$character";
      python.python_binary = "python3";
      directory.truncate_to_repo = false;
      time.disabled = false;
      status.disabled = false;
      kubernetes = {
        symbol = "ﴱ";
        format = "on [$symbol $context(\($namespace\))]($style) ";
        style = "blue bold";
        disabled = false;
      };
    };
  };
}
