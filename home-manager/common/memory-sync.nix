{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.memory-sync;
  memoryBackend =
    if config.home ? opencode && config.home.opencode ? memoryBackend then
      config.home.opencode.memoryBackend
    else
      "cavemem";
  isCavemem = memoryBackend == "cavemem";

  # Build the script derivation once, reference twice (programs.memory-sync.package
  # for downstream consumers, home.packages for PATH installation).
  memory-sync-script = import ../../scripts/memory-sync.nix {
    inherit pkgs lib;
    opencodePackage = config.programs.opencode.package;
  };
in
{
  options.programs.memory-sync = {
    enable = lib.mkEnableOption ''
      memory-sync orchestrator: invokes vault-synthesizer to draft
      memory candidates from cavemem observations, then vault-curator
      to deduplicate and refine. Designed for ad-hoc operator
      invocation; not driven by hooks. Reads/writes only
      $XDG_STATE_HOME/memory-sync/.

      Requires programs.opencode.enable = true on the same host;
      the assertion below enforces this at HM evaluation time.
    '';

    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = memory-sync-script;
      description = ''
        The built memory-sync script derivation. Read-only; surfaces
        the derivation to downstream consumers (e.g., a launchd job
        that wants to invoke it by absolute store path).
      '';
    };
  };

  config = lib.mkIf (cfg.enable && isCavemem) {
    home.packages = [ cfg.package ];

    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.memory-sync.enable requires programs.opencode.enable.

          memory-sync orchestrates two opencode subagents
          (vault-synthesizer and vault-curator) by invoking the
          wrapped opencode binary baked at derivation time. Without
          programs.opencode.enable = true, the wrapped derivation
          does not exist on this host and memory-sync cannot run.
        '';
      }
    ];
  };
}
