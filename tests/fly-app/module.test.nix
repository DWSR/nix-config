# Evaluation, serialization, and output-isolation tests for the reusable Fly
# app module and named-app generator (spec nix-module-for-fly-io-app, Task 5.1;
# Requirements 1.1, 1.2, 2.1, 2.2, 3.6, 3.7, 4.1, 4.2, 6.1, 6.2).
#
# The module is evaluated with `lib.evalModules` only, so the fixture needs no
# NixOS host, Fly account, token, or network. Invalid declarations are replayed
# through `nix eval` with an eval-only store and a stubbed `pkgs.writeText`;
# that makes the module's option-specific assertions observable without
# touching the build store.
{
  pkgs,
  lib ? pkgs.lib,
  modulePath ? ../../modules/fly-app.nix,
  generatorPath ? ../../lib/fly-apps.nix,
}:

let
  inherit (builtins)
    attrNames
    toJSON
    tryEval
    ;

  tokenSentinel = "fly-test-sentinel-not-a-real-token";

  evaluate =
    moduleConfig:
    lib.evalModules {
      modules = [
        modulePath
        moduleConfig
      ];
      specialArgs = { inherit pkgs; };
    };

  evalApp = moduleConfig: (evaluate moduleConfig).config.flyApp;

  specFailure =
    moduleConfig: tryEval (builtins.seq (builtins.toString (evalApp moduleConfig).spec) true);

  derivationImage = pkgs.runCommand "fly-app-module-test-image" { } ''
    mkdir -p "$out"
    printf 'fly-app-module-test-image\n' > "$out/image.tar"
  '';

  # Single-container app: open app settings and arbitrary Machine API fields
  # with an existing image reference.
  singleSettings = {
    primary_region = "ord";
    kill_signal = "SIGINT";
    kill_timeout = 30;
    min_machines_running = 1;
    auto_stop_machines = "stop";
    env = {
      APP_ENV = "production";
      FEATURE_FLAGS = "alpha,beta";
    };
    services = [
      {
        internal_port = 8080;
        protocol = "tcp";
        concurrency = {
          hard_limit = 25;
          soft_limit = 20;
          type = "connections";
        };
      }
    ];
    experimental = {
      enable_metrics = true;
      labels = [
        "one"
        "two"
      ];
    };
  };

  singleMachineConfig = {
    guest = {
      cpu_kind = "shared";
      cpus = 2;
      memory_mb = 1024;
      memory_mb_overhead = 128;
    };
    restart = {
      policy = "always";
      max_retries = 10;
    };
    mounts = [
      {
        volume = "data";
        path = "/data";
      }
    ];
    processes = [
      {
        name = "app";
        env = {
          PORT = "8080";
        };
      }
    ];
    metadata = {
      fly_platform_version = "v2";
      managed_by = "nix";
    };
    metrics = {
      port = 9091;
      path = "/metrics";
    };
    dns = {
      skip_registration = true;
    };
    statics = [
      {
        guest_path = "/app/public";
        url_prefix = "/static";
      }
    ];
    env = {
      MACHINE_ROLE = "web";
    };
    init = {
      exec = [ "/bin/init" ];
    };
    nullable_field = null;
  };

  singleModule = {
    flyApp = {
      name = "fly-module-single";
      settings = singleSettings;
      machines.web = {
        config = singleMachineConfig;
        image.existingImage = "registry.fly.io/fly-module-single:2026-11-11";
      };
    };
  };

  singleApp = evalApp singleModule;

  expectedSingle = {
    name = "fly-module-single";
    settings = singleSettings;
    machines.web = {
      config = singleMachineConfig;
      containers = { };
      image = {
        existingImage = "registry.fly.io/fly-module-single:2026-11-11";
      };
    };
  };

  # Multi-container app: each container selects its own image source and the
  # Machine selects the container used for app deployment.
  multiSettings = {
    primary_region = "sjc";
    env = {
      APP_ENV = "production";
    };
    services = [
      {
        internal_port = 443;
        protocol = "tcp";
        ports = [
          {
            port = 443;
            handlers = [
              "tls"
              "http"
            ];
          }
        ];
      }
    ];
  };

  multiMachineConfig = {
    guest = {
      cpu_kind = "performance";
      cpus = 4;
      memory_mb = 2048;
      memory_mb_overhead = 256;
    };
    restart = {
      policy = "on-failure";
    };
    metadata = {
      fly_process_group = "app";
      managed_by = "nix";
    };
    services = [
      {
        ports = [
          {
            port = 443;
            handlers = [
              "tls"
              "http"
            ];
          }
        ];
      }
    ];
    checks = {
      app = {
        type = "http";
        port = 8080;
        path = "/health";
      };
    };
  };

  appContainerConfig = {
    entrypoint = [ "/bin/app" ];
    cmd = [
      "--serve"
      "--port=8080"
    ];
    env = {
      APP_ROLE = "primary";
      APP_ENV = "production";
    };
    user = "1000";
    stop = {
      signal = "SIGTERM";
      timeout = "10s";
    };
    files = [
      {
        guest_path = "/etc/app.conf";
        raw_value = "port = 8080";
      }
    ];
    secrets = [ { name = "DATABASE_URL"; } ];
  };

  sidecarContainerConfig = {
    entrypoint = [ "/bin/sidecar" ];
    env = {
      APP_ROLE = "sidecar";
    };
    network = {
      mode = "private";
    };
    restart = {
      policy = "always";
    };
  };

  multiModule = {
    flyApp = {
      name = "fly-module-multi";
      settings = multiSettings;
      machines.main = {
        config = multiMachineConfig;
        containers.app = {
          config = appContainerConfig;
          image.derivation = derivationImage;
        };
        containers.sidecar = {
          config = sidecarContainerConfig;
          image.existingImage = "registry.fly.io/fly-module-sidecar:2.1.0";
        };
        deployContainer = "app";
      };
    };
  };

  multiApp = evalApp multiModule;

  expectedMulti = {
    name = "fly-module-multi";
    settings = multiSettings;
    machines.main = {
      config = multiMachineConfig;
      containers = {
        app = {
          config = appContainerConfig;
          image = {
            derivation = "${derivationImage}";
          };
        };
        sidecar = {
          config = sidecarContainerConfig;
          image = {
            existingImage = "registry.fly.io/fly-module-sidecar:2.1.0";
          };
        };
      };
      deployContainer = "app";
    };
  };

  singleExpectedFile = pkgs.writeText "fly-app-module-single-expected.json" (
    toJSON expectedSingle + "\n"
  );
  multiExpectedFile = pkgs.writeText "fly-app-module-multi-expected.json" (
    toJSON expectedMulti + "\n"
  );

  # The stub observably receives exactly the selected specification and nothing
  # else, so a token in argv or a cross-app spec is caught by the assertions
  # below.
  deployProgram = pkgs.writeShellScriptBin "fly-app-deploy" ''
    set -eu
    if [ "$#" -ne 2 ] || [ "$1" != "--spec" ] || [ -z "$2" ]; then
      echo "fly-app-module-test: expected exactly --spec <path>" >&2
      exit 64
    fi
    if [ -n "''${FLY_APP_ARGV_LOG:-}" ]; then
      printf '%s\n' "$@" > "$FLY_APP_ARGV_LOG"
    fi
    exec ${pkgs.python3}/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["name"])' "$2"
  '';

  # Two named apps must remain independently targetable.
  generatorApps = {
    alpha = {
      flyApp = {
        name = "fly-module-alpha";
        settings = {
          primary_region = "ord";
        };
        machines.web = {
          config = {
            guest = {
              cpu_kind = "shared";
              cpus = 1;
              memory_mb = 512;
            };
          };
          image.existingImage = "registry.fly.io/fly-module-alpha:latest";
        };
      };
    };
    beta = {
      flyApp = {
        name = "fly-module-beta";
        settings = {
          primary_region = "sjc";
        };
        machines.worker.image.derivation = derivationImage;
      };
    };
  };

  mkApps =
    appModules:
    import generatorPath {
      inherit
        lib
        pkgs
        deployProgram
        appModules
        ;
    };

  apps = mkApps generatorApps;
  alphaSpec = (evalApp generatorApps.alpha).spec;
  betaSpec = (evalApp generatorApps.beta).spec;
  alphaProgram = apps.deploy-alpha.program;
  betaProgram = apps.deploy-beta.program;

  # A broken declaration in one app must not make another app's command look
  # successful.
  mixedApps = mkApps {
    good = generatorApps.alpha;
    broken = {
      flyApp = {
        name = "fly-module-broken";
        machines.web.image = {
          existingImage = "registry.fly.io/fly-module-broken:latest";
          derivation = derivationImage;
        };
      };
    };
  };

  brokenProgram = tryEval (builtins.seq (builtins.toString mixedApps.deploy-broken.program) true);

  collisionResult = tryEval (
    builtins.deepSeq (attrNames (mkApps {
      alpha.flyApp.name = "same-target";
      beta.flyApp.name = "same-target";
    })) true
  );
  invalidNameResult = tryEval (
    builtins.deepSeq (attrNames (mkApps {
      "bad/name".flyApp.name = "bad-name";
    })) true
  );

  optionNames = attrNames (evaluate { flyApp.name = "fly-module-options"; }).options.flyApp;

  # Invalid image and deploy-container choices must fail evaluation with the
  # option-specific diagnostic named here. Each case is also replayed through
  # `nix eval` so the assertion text itself, not just the failure, is verified.
  failureCases = [
    {
      name = "conflicting-machine-image";
      module = {
        flyApp = {
          name = "fly-module-conflict";
          machines.web.image = {
            existingImage = "registry.fly.io/fly-module-conflict:latest";
            derivation = "/nix/store/00000000000000000000000000000000-fixture-image";
          };
        };
      };
      message = "Fly Machine 'web' must use exactly one image source for each required image, and cannot mix Machine and container image declarations.";
    }
    {
      name = "missing-machine-image";
      module = {
        flyApp = {
          name = "fly-module-missing";
          machines.web.config = { };
        };
      };
      message = "Fly Machine 'web' must use exactly one image source for each required image, and cannot mix Machine and container image declarations.";
    }
    {
      name = "missing-deploy-container";
      module = {
        flyApp = {
          name = "fly-module-multi-no-deploy";
          machines.main = {
            containers.app.image.existingImage = "registry.fly.io/fly-module-app:latest";
            containers.sidecar.image.existingImage = "registry.fly.io/fly-module-sidecar:latest";
          };
        };
      };
      message = "Fly Machine 'main' must select an existing deployContainer when it has multiple containers.";
    }
    {
      name = "unknown-deploy-container";
      module = {
        flyApp = {
          name = "fly-module-multi-unknown-deploy";
          machines.main = {
            deployContainer = "absent";
            containers.app.image.existingImage = "registry.fly.io/fly-module-app:latest";
            containers.sidecar.image.existingImage = "registry.fly.io/fly-module-sidecar:latest";
          };
        };
      };
      message = "Fly Machine 'main' must select an existing deployContainer when it has multiple containers.";
    }
    {
      name = "machine-and-container-images";
      module = {
        flyApp = {
          name = "fly-module-mixed-sources";
          machines.main = {
            image.existingImage = "registry.fly.io/fly-module-main:latest";
            containers.app.image.existingImage = "registry.fly.io/fly-module-app:latest";
          };
        };
      };
      message = "Fly Machine 'main' must use exactly one image source for each required image, and cannot mix Machine and container image declarations.";
    }
    {
      name = "conflicting-container-image";
      module = {
        flyApp = {
          name = "fly-module-container-conflict";
          machines.main = {
            containers.app.image = {
              existingImage = "registry.fly.io/fly-module-app:latest";
              derivation = "/nix/store/00000000000000000000000000000000-fixture-image";
            };
          };
        };
      };
      message = "Fly Machine 'main' must use exactly one image source for each required image, and cannot mix Machine and container image declarations.";
    }
    {
      name = "missing-container-image";
      module = {
        flyApp = {
          name = "fly-module-container-missing";
          machines.main.containers.app.config = { };
        };
      };
      message = "Fly Machine 'main' must use exactly one image source for each required image, and cannot mix Machine and container image declarations.";
    }
  ];

  failureResults = map (case: specFailure case.module) failureCases;

  nixpkgsLib = "${pkgs.path}/lib";
  moduleSource = builtins.path {
    path = modulePath;
    name = "fly-app.nix";
  };

  failureExpression = moduleConfig: ''
    let
      lib = import ${nixpkgsLib};
      fakePkgs = {
        writeText = _name: text:
          builtins.seq text "/nix/store/00000000000000000000000000000000-fly-app-spec.json";
      };
      evaluated = (lib.evalModules {
        modules = [
          ${moduleSource}
          (builtins.fromJSON ${toJSON (toJSON moduleConfig)})
        ];
        specialArgs = { pkgs = fakePkgs; };
      }).config.flyApp;
    in
    builtins.toString evaluated.spec
  '';

  failureManifest = pkgs.writeText "fly-app-module-failures.json" (
    toJSON (
      map (case: {
        inherit (case) name message;
        path = toString (pkgs.writeText "fly-app-module-${case.name}.nix" (failureExpression case.module));
      }) failureCases
    )
  );
in
assert lib.assertMsg (
  optionNames == [
    "machines"
    "name"
    "settings"
    "spec"
  ]
) "fly-app module must expose only the name, settings, machines, and spec options.";
assert lib.assertMsg (
  attrNames apps == [
    "deploy-alpha"
    "deploy-beta"
  ]
) "fly-app generator must expose one deploy-<app> output per declared app name.";
assert lib.assertMsg (
  apps.deploy-alpha.type == "app" && apps.deploy-beta.type == "app"
) "each generated fly-app output must have flake app type.";
assert lib.assertMsg (
  alphaProgram != betaProgram && alphaSpec != betaSpec
) "each generated fly-app output must carry its own specification.";
assert lib.assertMsg (
  !collisionResult.success
) "two app names targeting the same Fly app must fail evaluation.";
assert lib.assertMsg (
  !invalidNameResult.success
) "an app name that is not usable as a flake attribute must fail evaluation.";
assert lib.assertMsg (
  !brokenProgram.success
) "an invalid declaration in one app must not make another app's command succeed.";
assert lib.assertMsg (
  attrNames mixedApps == [
    "deploy-broken"
    "deploy-good"
  ]
) "a broken app must not remove another app's generated output.";
assert lib.assertMsg (lib.all (
  result: !result.success
) failureResults) "every invalid image or deployContainer choice must fail evaluation.";
pkgs.runCommand "fly-app-module-test"
  {
    nativeBuildInputs = [
      pkgs.nix
      pkgs.python3
    ];
    FLY_APP_ALPHA_PROGRAM = "${alphaProgram}";
    FLY_APP_ALPHA_SPEC = "${alphaSpec}";
    FLY_APP_BETA_PROGRAM = "${betaProgram}";
    FLY_APP_BETA_SPEC = "${betaSpec}";
    FLY_APP_FAILURE_MANIFEST = "${failureManifest}";
    FLY_APP_FIXTURE_IMAGE = "${derivationImage}";
    FLY_APP_GOOD_PROGRAM = "${mixedApps.deploy-good.program}";
    FLY_APP_MULTI_EXPECTED = "${multiExpectedFile}";
    FLY_APP_MULTI_SPEC = "${multiApp.spec}";
    FLY_APP_SINGLE_EXPECTED = "${singleExpectedFile}";
    FLY_APP_SINGLE_SPEC = "${singleApp.spec}";
    FLY_APP_TOKEN_SENTINEL = tokenSentinel;
  }
  ''
    ${pkgs.python3}/bin/python3 - <<'PY'
    import json
    import os
    from pathlib import Path
    import shutil
    import subprocess
    import sys
    import tempfile

    failures = []


    def expect(condition, message):
        if not condition:
            failures.append(message)


    def load(variable):
        return json.loads(Path(os.environ[variable]).read_text(encoding="utf-8"))


    sentinel = os.environ["FLY_APP_TOKEN_SENTINEL"]
    fixture_image = os.environ["FLY_APP_FIXTURE_IMAGE"]
    single = load("FLY_APP_SINGLE_SPEC")
    multi = load("FLY_APP_MULTI_SPEC")
    expected_single = load("FLY_APP_SINGLE_EXPECTED")
    expected_multi = load("FLY_APP_MULTI_EXPECTED")
    alpha_spec = os.environ["FLY_APP_ALPHA_SPEC"]
    beta_spec = os.environ["FLY_APP_BETA_SPEC"]

    expect(
        set(single) == {"name", "settings", "machines"},
        "single-container spec must contain only name, settings, and machines",
    )
    expect(
        set(multi) == {"name", "settings", "machines"},
        "multi-container spec must contain only name, settings, and machines",
    )
    expect(
        single == expected_single,
        "single-container spec does not match the declared app: " + json.dumps(single, sort_keys=True),
    )
    expect(
        multi == expected_multi,
        "multi-container spec does not match the declared app: " + json.dumps(multi, sort_keys=True),
    )

    def field(document, *keys):
        value = document
        for key in keys:
            if not isinstance(value, dict) or key not in value:
                return None
            value = value[key]
        return value

    web = field(single, "machines", "web")
    expect(isinstance(web, dict), "single-container app must declare Machine 'web'")
    expect(field(web, "config") == field(expected_single, "machines", "web", "config"),
           "single-container Machine lost arbitrary config fields")
    expect(field(web, "image") == {"existingImage": "registry.fly.io/fly-module-single:2026-11-11"},
           "single-container Machine did not serialize its existing image source")
    expect(field(web, "containers") == {}, "single-container Machine must not declare containers")
    expect(not (isinstance(web, dict) and "deployContainer" in web),
           "single-container Machine must not declare deployContainer")
    expect(field(single, "settings", "experimental", "labels") == ["one", "two"],
           "nested app settings did not survive serialization")
    expect(field(single, "machines", "web", "config", "nullable_field") is None,
           "null Machine fields must survive serialization")

    main = field(multi, "machines", "main")
    expect(isinstance(main, dict), "multi-container app must declare Machine 'main'")
    expect(field(main, "deployContainer") == "app",
           "explicit deployContainer must survive serialization")
    expect(not (isinstance(main, dict) and "image" in main),
           "multi-container Machine must not declare a Machine-level image")
    containers = field(main, "containers")
    expect(isinstance(containers, dict) and set(containers) == {"app", "sidecar"},
           "multi-container Machine must keep each declared container")
    expect(set(field(containers, "app", "image") or {}) == {"derivation"},
           "derivation-backed container must keep exactly its derivation source")
    expect(field(containers, "app", "image", "derivation") == fixture_image,
           "derivation-backed container source must be the fixture derivation")
    expect(field(containers, "sidecar", "image") ==
           {"existingImage": "registry.fly.io/fly-module-sidecar:2.1.0"},
           "existing-image container must keep exactly its existingImage source")
    expect(field(main, "config") == field(expected_multi, "machines", "main", "config"),
           "multi-container Machine lost arbitrary config fields")
    expect(field(containers, "app", "config") ==
           field(expected_multi, "machines", "main", "containers", "app", "config"),
           "multi-container Machine lost arbitrary container config fields")
    expect(field(containers, "sidecar", "config") ==
           field(expected_multi, "machines", "main", "containers", "sidecar", "config"),
           "sidecar container lost arbitrary config fields")
    expect(field(main, "config", "checks", "app", "path") == "/health",
           "nested Machine API fields did not survive serialization")
    expect(field(containers, "app", "config", "secrets") == [{"name": "DATABASE_URL"}],
           "nested container API fields did not survive serialization")

    for label, document in (("single", single), ("multi", multi)):
        text = json.dumps(document, sort_keys=True)
        expect(sentinel not in text, label + " spec contains the fixture token")
        expect("FLY_API_TOKEN" not in text, label + " spec mentions FLY_API_TOKEN")

    alpha_text = Path(os.environ["FLY_APP_ALPHA_PROGRAM"]).read_text(encoding="utf-8")
    beta_text = Path(os.environ["FLY_APP_BETA_PROGRAM"]).read_text(encoding="utf-8")
    expect(alpha_spec in alpha_text, "alpha command does not target its own spec")
    expect(beta_spec not in alpha_text, "alpha command references beta's spec")
    expect(beta_spec in beta_text, "beta command does not target its own spec")
    expect(alpha_spec not in beta_text, "beta command references alpha's spec")
    expect(alpha_text != beta_text, "the two named app commands must be distinct")
    for label, text in (("alpha", alpha_text), ("beta", beta_text)):
        expect("FLY_API_TOKEN" not in text, label + " command embeds FLY_API_TOKEN")
        expect(sentinel not in text, label + " command embeds the fixture token")

    def invoke(program, argv_log):
        environment = dict(os.environ)
        environment["FLY_API_TOKEN"] = sentinel
        environment["FLY_APP_ARGV_LOG"] = str(argv_log)
        return subprocess.run([program], env=environment, capture_output=True, text=True)

    with tempfile.TemporaryDirectory() as temporary:
        invocations = (
            ("alpha", os.environ["FLY_APP_ALPHA_PROGRAM"], "fly-module-alpha", alpha_spec),
            ("beta", os.environ["FLY_APP_BETA_PROGRAM"], "fly-module-beta", beta_spec),
            ("isolated-good", os.environ["FLY_APP_GOOD_PROGRAM"], "fly-module-alpha", None),
        )
        for label, program, expected_name, expected_spec in invocations:
            argv_log = Path(temporary) / (label + ".argv")
            result = invoke(program, argv_log)
            expect(result.returncode == 0,
                   label + " command failed: " + result.stderr.strip())
            expect(result.stdout.strip() == expected_name,
                   label + " command targeted " + result.stdout.strip() +
                   " instead of " + expected_name)
            arguments = (argv_log.read_text(encoding="utf-8").splitlines()
                         if argv_log.exists() else [])
            expect(arguments[:1] == ["--spec"],
                   label + " command did not pass --spec first: " + repr(arguments))
            expect(len(arguments) == 2,
                   label + " command passed unexpected arguments: " + repr(arguments))
            if expected_spec is not None:
                expect(arguments[1:] == [expected_spec],
                       label + " command did not pass its own spec: " + repr(arguments))
            expect(sentinel not in "\n".join(arguments),
                   label + " command exposed the token in its arguments")
            expect(sentinel not in result.stdout and sentinel not in result.stderr,
                   label + " command exposed the token in its diagnostics")

    manifest_path = Path(os.environ["FLY_APP_FAILURE_MANIFEST"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    nix = shutil.which("nix")
    expect(nix is not None, "nix is not available to replay invalid declarations")
    if nix is not None:
        for case in manifest:
            with tempfile.TemporaryDirectory() as temporary:
                environment = dict(os.environ)
                environment["HOME"] = temporary
                environment["XDG_CACHE_HOME"] = str(Path(temporary) / "cache")
                environment["NIX_REMOTE"] = "dummy://"
                result = subprocess.run(
                    [nix, "--extra-experimental-features", "nix-command",
                     "eval", "--store", "dummy://", "--raw", "--file", case["path"]],
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
            expect(result.returncode != 0,
                   "invalid declaration '" + case["name"] + "' evaluated successfully")
            expect("error:" in result.stderr,
                   "invalid declaration '" + case["name"] + "' produced no Nix error")
            expect(case["message"] in result.stderr,
                   "invalid declaration '" + case["name"] + "' did not report: " + case["message"])

    if failures:
        for failure in failures:
            print("fly-app-module-test: " + failure, file=sys.stderr)
        raise SystemExit(1)
    print("fly-app module options, serialization, diagnostics, and output isolation verified")
    PY
    touch "$out"
  ''
