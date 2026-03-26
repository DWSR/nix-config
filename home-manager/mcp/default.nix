{ pkgs, lib, config, ... }:
let
  githubToken = if config.home.mcp.githubToken == null
    then builtins.throw "home.mcp.githubToken must be set"
    else config.home.mcp.githubToken;
in
{
  options.home.mcp = {
    githubToken = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "GitHub personal access token for MCP server";
    };

    extraServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      default = {};
      description = "Additional MCP servers to add to mcphub configuration";
      example = {
        custom-server = {
          command = "\${pkgs.custom-mcp}/bin/custom-mcp";
          args = [ "arg1" ];
          env.CUSTOM_VAR = "value";
        };
      };
    };

    enable = lib.mkEnableOption "MCP hub configuration" // { default = true; };
  };

  config = lib.mkIf config.home.mcp.enable {
    home.packages = with pkgs; [
      mcp-hub
      github-mcp-server
      mcp-nixos
    ];

    xdg.configFile."mcphub/servers.json" = {
      enable = true;
      text = builtins.toJSON {
        servers = {
          nixos = {
            command = "${pkgs.mcp-nixos}/bin/mcp-nixos";
            args = [ "--" ];
          };

          github = {
            command = "${pkgs.github-mcp-server}/bin/github-mcp-server";
            args = [
              "stdio"
              "--toolsets=all"
            ];
            env.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
          };


        } // config.home.mcp.extraServers;
      };
    };
  };
}
