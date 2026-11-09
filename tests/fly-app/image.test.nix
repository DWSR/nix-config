{
  pkgs,
  nixSnapshotter ? pkgs.nix-snapshotter,
}:

assert pkgs.lib.assertMsg pkgs.stdenv.hostPlatform.isLinux
  "fly-app-image-test: the pinned OCI builder fixture must build on Linux";

let
  runtime = pkgs.pkgsStatic.busybox;
  runtimeRoot = pkgs.buildEnv {
    name = "fly-app-image-runtime";
    paths = [ runtime ];
    pathsToLink = [ "/bin" ];
  };
  runtimeClosure = pkgs.closureInfo {
    rootPaths = [ runtime ];
  };
  dockerToolsBaseGzip = pkgs.dockerTools.buildImage {
    name = "fly-app-image-base";
    tag = "latest";
    copyToRoot = runtimeRoot;
    config = {
      Cmd = [
        "/bin/sh"
        "-c"
        "echo fly-app-image-runnable"
      ];
      WorkingDir = "/";
    };
  };
  # The pinned importer requires an uncompressed Docker archive with writable
  # extracted metadata; DockerTools emits a gzip stream with read-only entries.
  dockerToolsBase =
    pkgs.runCommand "fly-app-image-base.tar"
      {
        nativeBuildInputs = [
          pkgs.gzip
          pkgs.gnutar
        ];
      }
      ''
        mkdir unpack
        cd unpack
        gzip -dc ${dockerToolsBaseGzip} | tar -xf -
        find . -type d -exec chmod u+rwx {} +
        tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf "$out" .
      '';
  image = nixSnapshotter.buildImage {
    name = "fly-app-image-fixture";
    tag = "latest";
    fromImage = dockerToolsBase;
    config = {
      Cmd = [
        "/bin/sh"
        "-c"
        "echo fly-app-image-runnable"
      ];
      WorkingDir = "/";
    };
  };
  publisher = image.copyToRegistry { };
in
assert builtins.isFunction image.copyToRegistry;
assert builtins.isAttrs publisher;
pkgs.runCommand "fly-app-image-test"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
      python3 - ${image} ${runtimeClosure}/store-paths ${publisher}/bin/copy-to-registry ${runtime} <<'PY'
    import gzip
    import io
    import json
    import os
    import posixpath
    import subprocess
    import sys
    import tarfile
    import tempfile

    archive_path, closure_path, publisher_path, runtime_path = sys.argv[1:]
    expected_command = ["/bin/sh", "-c", "echo fly-app-image-runnable"]

    with tarfile.open(archive_path, "r:") as archive:
        index = json.load(archive.extractfile("index.json"))
        descriptors = index.get("manifests", [])
        if len(descriptors) != 1:
            raise SystemExit(f"expected one OCI manifest, found {len(descriptors)}")
        manifest_path = "blobs/sha256/" + descriptors[0]["digest"].split(":", 1)[1]
        manifest = json.load(archive.extractfile(manifest_path))
        layers = manifest.get("layers", [])
        if len(layers) < 2:
            raise SystemExit(f"expected imported base and snapshotter layers, found {len(layers)}")
        config_digest = manifest["config"]["digest"].split(":", 1)[1]
        config_path = "blobs/sha256/" + config_digest
        image_config = json.load(archive.extractfile(config_path))

        if image_config.get("config", {}).get("Cmd") != expected_command:
            raise SystemExit("OCI image config does not retain the runnable fixture command")

        base_digest = layers[0]["digest"].split(":", 1)[1]
        base_path = "blobs/sha256/" + base_digest
        base_layer_data = archive.extractfile(base_path).read()
        base_layer_stream = io.BytesIO(base_layer_data)
        if base_layer_data[:2] == bytes((31, 139)):
            base_layer_stream = gzip.GzipFile(fileobj=base_layer_stream)
        base_layer = tarfile.open(fileobj=base_layer_stream, mode="r:")
        with base_layer:
            members = {
                posixpath.normpath(member.name).lstrip("/"): member
                for member in base_layer.getmembers()
            }
            with open(closure_path) as closure_file:
                closure_paths = [line.strip() for line in closure_file if line.strip()]
            if not closure_paths:
                raise SystemExit("DockerTools runtime closure fixture is empty")
            missing = [
                store_path for store_path in closure_paths
                if "nix/store/" + os.path.basename(store_path) not in members
            ]
            if missing:
                raise SystemExit("DockerTools runtime closure absent from base layer: " + ", ".join(missing))

            link = members.get("bin/sh")
            expected_shell = os.path.basename(runtime_path) + "/bin/sh"
            if link is None or not link.issym() or not link.linkname.endswith(expected_shell):
                raise SystemExit("/bin/sh is not linked to the declared runtime package")

            target = link.linkname.lstrip("/")
            seen = set()
            while target in members and members[target].issym():
                if target in seen:
                    raise SystemExit("runtime shell symlink cycle")
                seen.add(target)
                next_target = members[target].linkname
                target = (
                    next_target.lstrip("/")
                    if next_target.startswith("/")
                    else posixpath.normpath(posixpath.join(posixpath.dirname(target), next_target))
                )
            executable = members.get(target)
            if executable is None or not executable.isfile() or executable.size == 0 or not executable.mode & 0o111:
                raise SystemExit("the embedded runtime shell is missing or not executable")
            runtime_binary = base_layer.extractfile(executable).read()

    if not os.path.isfile(publisher_path) or not os.access(publisher_path, os.X_OK):
        raise SystemExit("pinned copyToRegistry interface did not produce an executable publisher")
    with open(publisher_path) as publisher_file:
        publisher_script = publisher_file.read()
    if "nix2container push" not in publisher_script or archive_path not in publisher_script:
        raise SystemExit("publisher does not invoke the pinned push interface for this OCI archive")

    with tempfile.TemporaryDirectory() as rootfs:
        package_root = os.path.join(rootfs, "nix", "store", os.path.basename(runtime_path))
        os.makedirs(os.path.join(package_root, "bin"))
        shell_path = os.path.join(package_root, "bin", "sh")
        with open(shell_path, "wb") as shell_file:
            shell_file.write(runtime_binary)
        os.chmod(shell_path, 0o755)

        result = subprocess.run(
            [shell_path, "-c", "echo fly-app-image-runnable"],
            env={"PATH": os.path.join(package_root, "bin")},
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0 or result.stdout.strip() != "fly-app-image-runnable":
            raise SystemExit("archive-extracted runtime failed its configured command: " + result.stderr.strip())

    print("OCI runtime closure, runnable rootfs, and pinned publisher interface verified")
    PY
      touch "$out"
  ''
