# Miscellaneous package overrides and custom packages
{ inputs }:
final: prev: {
  # TODO: Remove once fzf 0.71.0 is released and available in nixpkgs
  fzf = prev.fzf.overrideAttrs (old: {
    version = "0.71.0-pre";

    src = final.fetchFromGitHub {
      owner = "junegunn";
      repo = "fzf";
      rev = "b7138e67a60638c02361c38f1053eadd09709660";
      hash = "sha256-9uHtEdIP3LOQvyEVpr0CO4D83YcX5BmSmnCCRVUzh4E=";
    };

    vendorHash = "sha256-uFXHoseFOxGIGPiWxWfDl339vUv855VHYgSs9rnDyuI=";
  });

  shadowenv-vim = final.vimUtils.buildVimPlugin {
    pname = "shadowenv-vim";
    version = "unstable-2024-07-23";

    src = final.fetchFromGitHub {
      owner = "Shopify";
      repo = "shadowenv.vim";
      rev = "c306d272b2280b7163b160fc27630eb9c16a3f4a";
      hash = "sha256-MEcZfUmjXsBXuyeMTUNS778Kq4g4+lJ/NkeXVawoQpA=";
    };
  };

  git-issue-tracker = final.stdenv.mkDerivation {
    pname = "git-issue-tracker";
    version = inputs.git-issue-tracker.shortRev or "unknown";
    src = inputs.git-issue-tracker;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out/bin
      cp -r bin/. $out/bin/
      chmod +x $out/bin/*
    '';
  };

  python312 = prev.python312.override {
    packageOverrides = pyFinal: _pyPrev: {
      kagiapi = pyFinal.buildPythonPackage rec {
        pname = "kagiapi";
        version = "0.2.1";
        format = "wheel";

        src = pyFinal.fetchPypi {
          inherit pname version format;
          dist = "py3";
          python = "py3";
          abi = "none";
          platform = "any";
          hash = "sha256-8/FGaQgEHRF3cLf5O+4SCX4RTdUYxN2jVBPfeFVGeZo=";
        };
        dependencies = with pyFinal; [ requests ];
      };
    };
  };

  kagimcp = final.python312Packages.buildPythonApplication {
    pname = "kagimcp";
    version = "0.1.4";
    format = "wheel";

    src = final.python312Packages.fetchPypi {
      pname = "kagimcp";
      version = "0.1.4";
      format = "wheel";
      dist = "py3";
      python = "py3";
      abi = "none";
      platform = "any";
      hash = "sha256-gJhxPOKy9i+wpjsvCvWwytSkDdKb1jD8z4DvjQHq8Hs=";
    };

    dependencies = with final.python312Packages; [
      kagiapi
      mcp
      pydantic
    ];
  };
}
