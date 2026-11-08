{
  pkgs,
  nixSnapshotter ? pkgs.nix-snapshotter,
}:
let
  runtime = pkgs.pkgsStatic.hello;
  runtimeRoot = pkgs.buildEnv {
    name = "fly-app-image-runtime-root";
    paths = [ runtime ];
    pathsToLink = [ "/bin" ];
  };
  dockerBase = pkgs.dockerTools.buildImage {
    name = "fly-app-image-base";
    compressor = "none";
    copyToRoot = runtimeRoot;
    extraCommands = "chmod -R u+w .";
  };
  # The pinned fromImage parser extracts members in order. Relax parent directory
  # modes so later files can be materialized without changing image layer bytes.
  dockerBaseForSnapshotter =
    pkgs.runCommand "fly-app-docker-base-for-snapshotter.tar"
      {
        nativeBuildInputs = [ pkgs.python3 ];
      }
      ''
        python3 - ${dockerBase} "$out" <<'PY'
        import sys
        import tarfile

        source, destination = sys.argv[1:]
        with tarfile.open(source, "r:") as original, tarfile.open(destination, "w:", format=tarfile.PAX_FORMAT) as normalized:
            for member in original:
                if member.isdir():
                    member.mode = 0o755
                normalized.addfile(member, original.extractfile(member) if member.isfile() else None)
        PY
      '';

  image = nixSnapshotter.buildImage {
    name = "fly-app-image-fixture";
    fromImage = dockerBaseForSnapshotter;
    copyToRoot = [ ];
    config.Cmd = [ "/bin/hello" ];
  };
  publisher = image.copyToRegistry {
    imageName = "registry.example/fly-fixture";
    imageTag = "contract";
  };
  closureInfo = pkgs.closureInfo { rootPaths = [ runtime ]; };

  inspect = pkgs.writeText "inspect-fly-app-oci.py" ''
    import hashlib
    import io
    import json
    import os
    import pathlib
    import subprocess
    import sys
    import tarfile

    archive, root, closure_file, publisher = sys.argv[1:]
    root = pathlib.Path(root)
    root.mkdir(parents=True, exist_ok=True)

    with tarfile.open(archive, "r:*") as oci:
        index = json.load(oci.extractfile("index.json"))
        assert index["manifests"], "OCI archive has no manifest"
        descriptor = index["manifests"][0]

        def read_blob(descriptor):
            path = "blobs/sha256/" + descriptor["digest"].split(":", 1)[1]
            payload = oci.extractfile(path).read()
            assert hashlib.sha256(payload).hexdigest() == descriptor["digest"].split(":", 1)[1], f"blob digest mismatch: {path}"
            return json.loads(payload)

        manifest = read_blob(descriptor)
        assert manifest["layers"], "OCI manifest has no image layers"
        config = read_blob(manifest["config"])
        assert config["config"]["Cmd"] == ["/bin/hello"], "OCI config lost the runnable command"

        for layer in manifest["layers"]:
            path = "blobs/sha256/" + layer["digest"].split(":", 1)[1]
            payload = oci.extractfile(path).read()
            expected = layer["digest"].split(":", 1)[1]
            assert hashlib.sha256(payload).hexdigest() == expected, f"layer digest mismatch: {path}"
            with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as layer_tar:
                for member in layer_tar:
                    member_path = pathlib.PurePosixPath(member.name)
                    assert not member_path.is_absolute() and ".." not in member_path.parts, f"unsafe OCI layer path: {member.name}"
                    target = root.joinpath(*member_path.parts)
                    parent = root
                    for part in member_path.parts[:-1]:
                        parent = parent / part
                        assert not parent.is_symlink(), f"OCI layer parent is a symlink: {parent}"
                        parent.mkdir(exist_ok=True)
                    if member.issym():
                        if target.is_symlink() or target.exists():
                            target.unlink()
                        target.symlink_to(member.linkname)
                    elif member.isdir():
                        target.mkdir(exist_ok=True)
                    elif member.isfile():
                        with layer_tar.extractfile(member) as source, open(target, "wb") as destination:
                            destination.write(source.read())
                        target.chmod(member.mode)
                    else:
                        raise AssertionError(f"unsupported OCI layer entry: {member.name}")

    def resolve_image_path(image_path, want_directory=False):
        pending = list(pathlib.PurePosixPath(image_path).parts)
        resolved = []
        links = 0
        while pending:
            part = pending.pop(0)
            if part in ("", "/", "."):
                continue
            if part == "..":
                assert resolved, f"image path escapes root: {image_path}"
                resolved.pop()
                continue
            candidate = root.joinpath(*resolved, part)
            if candidate.is_symlink():
                links += 1
                assert links <= 40, f"symlink loop resolving {image_path}"
                target = os.readlink(candidate)
                if os.path.isabs(target):
                    resolved = []
                pending = list(pathlib.PurePosixPath(target).parts) + pending
            else:
                resolved.append(part)
        result = root.joinpath(*resolved)
        if want_directory:
            assert result.is_dir(), f"runtime closure directory is absent from OCI rootfs: {image_path} -> {result}"
        else:
            assert result.is_file(), f"runnable file is absent from OCI rootfs: {image_path} -> {result}"
            assert os.access(result, os.X_OK), f"OCI file is not executable: {image_path}"
        return result

    executable = resolve_image_path("/bin/hello")
    with open(closure_file, encoding="utf-8") as closure:
        store_paths = [line.strip() for line in closure if line.strip()]
    assert store_paths, "runtime closure is empty"
    for store_path in store_paths:
        contents = resolve_image_path(store_path, want_directory=True)
        assert contents.is_dir(), f"runtime closure entry is not a directory: {store_path}"
        assert any(contents.iterdir()), f"runtime closure entry is an empty mountpoint: {store_path}"

    env = {"HOME": "/nonexistent", "PATH": "/nonexistent"}
    result = subprocess.run([str(executable)], check=True, capture_output=True, text=True, env=env)
    assert result.stdout == "Hello, world!\n", f"unexpected executable output: {result.stdout!r}"

    publisher_path = pathlib.Path(publisher) / "bin/copy-to-registry"
    assert publisher_path.is_file() and os.access(publisher_path, os.X_OK), "pinned publisher executable is missing"
    publisher_text = publisher_path.read_text(encoding="utf-8")
    assert "nix2container push" in publisher_text, "publisher does not use pinned nix2container push API"
    assert '--ref "registry.example/fly-fixture:contract"' in publisher_text, "publisher image reference is wrong"
  '';
in
pkgs.runCommand "fly-app-image-contract"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
    python3 ${inspect} ${image} "$TMPDIR/rootfs" ${closureInfo}/store-paths ${publisher}
    touch "$out"
  ''
