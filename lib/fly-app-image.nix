{
  pkgs,
  nixSnapshotter ? pkgs.nix-snapshotter,
  name,
  tag ? "latest",
  contents,
  config,
}:
let
  root = pkgs.buildEnv {
    name = "${name}-root";
    paths = contents;
    pathsToLink = [ "/bin" ];
  };
  baseGzip = pkgs.dockerTools.buildImage {
    name = "${name}-base";
    tag = "latest";
    copyToRoot = root;
    inherit config;
  };
  # The pinned importer needs a writable, uncompressed Docker archive.
  base =
    pkgs.runCommand "${name}-base.tar"
      {
        nativeBuildInputs = [
          pkgs.gzip
          pkgs.gnutar
        ];
      }
      ''
        mkdir unpack
        cd unpack
        gzip -dc ${baseGzip} | tar -xf -
        find . -type d -exec chmod u+rwx {} +
        tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$out" .
      '';
  image = nixSnapshotter.buildImage {
    inherit name tag config;
    fromImage = base;
  };
  publisher = image.copyToRegistry { };
in
{
  inherit image publisher;
  archive = image;
}
