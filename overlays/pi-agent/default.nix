{ inputs }:
final: _prev:
let
  system = final.stdenv.hostPlatform.system;
  supportedSystem = "aarch64-darwin";
  requireSupported =
    value: if system == supportedSystem then value else throw "pi-agent supports only aarch64-darwin";
  upstream = requireSupported inputs.pi-nix.packages.${system}.coding-agent;
  undiciPatch = ./pi-undici-8.9.0.patch;
  piLock = ./pi-package-lock.json;
  npmDepsHash = "sha256-q7yPSmOAWfl3bwHr7U/YEjvIOOyIZbmr0rDnqlsnFTA=";
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
    upstream.overrideAttrs (
      old:
      let
        patches = (old.patches or [ ]) ++ [ undiciPatch ];
        postPatch = (old.postPatch or "") + ''
          cp ${piLock} package-lock.json
        '';
      in
      {
        inherit patches postPatch npmDepsHash;
        npmDeps = final.fetchNpmDeps {
          inherit (old) src;
          inherit patches postPatch;
          hash = npmDepsHash;
        };
        meta = (old.meta or { }) // {
          platforms = [ supportedSystem ];
        };
      }
    )
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
