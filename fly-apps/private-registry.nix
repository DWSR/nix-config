# `mc-registry` serves the private OCI registry. The htpasswd credential file
# is not checked in; before the first Nix-managed deployment, store its
# base64-encoded contents as the Fly secret REGISTRY_HTPASSWD:
#   fly secrets set -a mc-registry \
#     REGISTRY_HTPASSWD="$(base64 < htpasswd | tr -d '\n')"
{
  flyApp = {
    name = "mc-registry";

    settings = {
      primary_region = "yyz";

      deploy.strategy = "canary";

      experimental.exec = [
        "/bin/registry"
        "serve"
        "/config/config.yml"
      ];

      http_service = {
        internal_port = 5000;
        auto_stop_machines = "stop";
        auto_start_machines = true;
        min_machines_running = 0;

        concurrency = {
          type = "requests";
          soft_limit = 50;
        };

        http_options.h2_backend = true;

        checks = [
          {
            interval = "10s";
            timeout = "2s";
            grace_period = "10s";
            method = "GET";
            path = "/";
            protocol = "http";
          }
        ];
      };

      files = [
        {
          guest_path = "/config/config.yml";
          raw_value = "dmVyc2lvbjogMC4xCmxvZzoKICBhY2Nlc3Nsb2c6CiAgICBkaXNhYmxlZDogdHJ1ZQogIGxldmVsOiB3YXJuCiAgZm9ybWF0dGVyOiBqc29uCnN0b3JhZ2U6CiAgczM6CiAgICByZWdpb246IGV1LWNlbnRyYWwtMDAzCiAgICByZWdpb25lbmRwb2ludDogczMuZXUtY2VudHJhbC0wMDMuYmFja2JsYXplYjIuY29tCiAgICBidWNrZXQ6IGR3c3ItcHJpdmF0ZS1yZWdpc3RyeQogICAgc2VjdXJlOiB0cnVlCiAgICB2NGF1dGg6IHRydWUKICAgIGxvZ2xldmVsOiB3YXJuCiAgY2FjaGU6CiAgICBibG9iZGVzY3JpcHRvcjogcmVkaXMKICBkZWxldGU6CiAgICBlbmFibGVkOiBmYWxzZQogIG1haW50ZW5hbmNlOgogICAgdXBsb2FkcHVyZ2luZzoKICAgICAgZW5hYmxlZDogZmFsc2UKYXV0aDoKICBodHBhc3N3ZDoKICAgIHJlYWxtOiByZWdpc3RyeS5tZW50YWxjbHV0dGVyLndvcmsKICAgIHBhdGg6IC9jb25maWcvaHRwYXNzd2QKaHR0cDoKICBhZGRyOiAiMC4wLjAuMDo1MDAwIgogICMgc2VjcmV0OiBzZXQgaW4gc2VjcmV0CiAgZHJhaW50aW1lb3V0OiAxMHMKICBoMmM6CiAgICBlbmFibGVkOiB0cnVlCiAgZGVidWc6CiAgICBhZGRyOiAiMC4wLjAuMDo1MDAxIgogICAgcHJvbWV0aGV1czoKICAgICAgZW5hYmxlZDogdHJ1ZQogICAgICBwYXRoOiAvbWV0cmljcwpyZWRpczoKICBkYjogMAogIHBvb2xzaXplOiAxMAogIGNvbm5tYXhpZGxldGltZTogMTgwcwogICMgYWRkcnM6IHNldCBpbiBzZWNyZXQKICAjIHBhc3N3b3JkOiBzZXQgaW4gc2VjcmV0Cg==";
        }
        {
          guest_path = "/config/htpasswd";
          secret_name = "REGISTRY_HTPASSWD";
        }
      ];

      vm = [
        {
          size = "shared-cpu-1x";
          memory = "256";
          cpus = 1;
        }
      ];

      metrics = [
        {
          port = 5001;
          path = "/metrics";
        }
      ];
    };

    machines.app = {
      config = {
        env = {
          FLY_PROCESS_GROUP = "app";
          PRIMARY_REGION = "yyz";
        };

        init.exec = [
          "/bin/registry"
          "serve"
          "/config/config.yml"
        ];

        guest = {
          cpu_kind = "shared";
          cpus = 1;
          memory_mb = 256;
        };

        metadata.fly_process_group = "app";

        restart = {
          policy = "on-failure";
          max_retries = 10;
        };

        services = [
          {
            protocol = "tcp";
            internal_port = 5000;
            autostop = true;
            autostart = true;
            min_machines_running = 0;
            force_instance_key = null;

            ports = [
              {
                port = 80;
                handlers = [ "http" ];
                http_options.h2_backend = true;
              }
              {
                port = 443;
                handlers = [
                  "http"
                  "tls"
                ];
                http_options.h2_backend = true;
              }
            ];

            checks = [
              {
                type = "http";
                interval = "10s";
                timeout = "2s";
                grace_period = "10s";
                method = "GET";
                path = "/";
                protocol = "http";
              }
            ];

            concurrency = {
              type = "requests";
              soft_limit = 50;
            };
          }
        ];

        metrics = {
          port = 5001;
          path = "/metrics";
        };

        files = [
          {
            guest_path = "/config/config.yml";
            raw_value = "dmVyc2lvbjogMC4xCmxvZzoKICBhY2Nlc3Nsb2c6CiAgICBkaXNhYmxlZDogdHJ1ZQogIGxldmVsOiB3YXJuCiAgZm9ybWF0dGVyOiBqc29uCnN0b3JhZ2U6CiAgczM6CiAgICByZWdpb246IGV1LWNlbnRyYWwtMDAzCiAgICByZWdpb25lbmRwb2ludDogczMuZXUtY2VudHJhbC0wMDMuYmFja2JsYXplYjIuY29tCiAgICBidWNrZXQ6IGR3c3ItcHJpdmF0ZS1yZWdpc3RyeQogICAgc2VjdXJlOiB0cnVlCiAgICB2NGF1dGg6IHRydWUKICAgIGxvZ2xldmVsOiB3YXJuCiAgY2FjaGU6CiAgICBibG9iZGVzY3JpcHRvcjogcmVkaXMKICBkZWxldGU6CiAgICBlbmFibGVkOiBmYWxzZQogIG1haW50ZW5hbmNlOgogICAgdXBsb2FkcHVyZ2luZzoKICAgICAgZW5hYmxlZDogZmFsc2UKYXV0aDoKICBodHBhc3N3ZDoKICAgIHJlYWxtOiByZWdpc3RyeS5tZW50YWxjbHV0dGVyLndvcmsKICAgIHBhdGg6IC9jb25maWcvaHRwYXNzd2QKaHR0cDoKICBhZGRyOiAiMC4wLjAuMDo1MDAwIgogICMgc2VjcmV0OiBzZXQgaW4gc2VjcmV0CiAgZHJhaW50aW1lb3V0OiAxMHMKICBoMmM6CiAgICBlbmFibGVkOiB0cnVlCiAgZGVidWc6CiAgICBhZGRyOiAiMC4wLjAuMDo1MDAxIgogICAgcHJvbWV0aGV1czoKICAgICAgZW5hYmxlZDogdHJ1ZQogICAgICBwYXRoOiAvbWV0cmljcwpyZWRpczoKICBkYjogMAogIHBvb2xzaXplOiAxMAogIGNvbm5tYXhpZGxldGltZTogMTgwcwogICMgYWRkcnM6IHNldCBpbiBzZWNyZXQKICAjIHBhc3N3b3JkOiBzZXQgaW4gc2VjcmV0Cg==";
          }
          {
            guest_path = "/config/htpasswd";
            secret_name = "REGISTRY_HTPASSWD";
          }
        ];
      };

      image.existingImage = "docker.io/library/registry@sha256:ac0192b549007e22998eb74e8d8488dcfe70f1489520c3b144a6047ac5efbe90";
    };
  };
}
