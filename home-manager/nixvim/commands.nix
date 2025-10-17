{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim.userCommands = {
    "BufferKill" = {
      desc = "Close the current buffer";
      command = helpers.mkRaw ''
        function()
          buf_kill("bd")
        end
      '';
    };
  };
}
