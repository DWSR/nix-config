{ ... }:
{
  programs.nixvim.userCommands = {
    "BufferKill" = {
      desc = "Close the current buffer";
      command = {
      __raw = ''
        function()
          buf_kill("bd")
        end
      '';
      };
    };
  };
}
