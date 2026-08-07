{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystem = "aarch64-darwin";
  requireSupported =
    value: if system == supportedSystem then value else throw "pi-agent supports only aarch64-darwin";
  upstream = requireSupported inputs.pi-nix.packages.${system}.coding-agent;
  manifest = final.writeText "pi-agent-extensions.json" (
    builtins.toJSON {
      schemaVersion = 1;
      piVersion = upstream.version;
      extensions = { };
    }
  );
in
{
  pi-agent = requireSupported (
    upstream.overrideAttrs (old: {
      # Tasks 1.3 and 1.4 append the dependency and recovery patches here.
      patches = old.patches or [ ];
      meta = (old.meta or { }) // {
        platforms = [ supportedSystem ];
      };
    })
  );

  pi-agent-extensions = requireSupported (
    final.runCommand "pi-agent-extensions-${upstream.version}-placeholder"
      {
        passthru = { inherit manifest; };
        meta = {
          description = "Managed Pi extension package placeholder";
          platforms = [ supportedSystem ];
        };
      }
      ''
        install -Dm444 ${manifest} "$out/share/pi-agent/extensions.json"
      ''
  );
}
