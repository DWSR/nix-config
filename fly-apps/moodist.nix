{
  flyApp = {
    name = "mc-moodist";

    settings = {
      primary_region = "yyz";
      kill_signal = "SIGQUIT";
      kill_timeout = 30;

      experimental.cmd = [
        "caddy"
        "run"
        "--config"
        "/etc/caddy/Caddyfile"
        "--adapter"
        "caddyfile"
      ];

      services = [
        {
          internal_port = 8080;
          protocol = "tcp";
          auto_start_machines = true;
          auto_stop_machines = "stop";
          processes = [ "app" ];

          ports = [
            {
              port = 80;
              handlers = [ "http" ];
              force_https = true;
            }
            {
              port = 443;
              handlers = [
                "tls"
                "http"
              ];
              tls_options = {
                alpn = [ "http/1.1" ];
                versions = [
                  "TLSv1.2"
                  "TLSv1.3"
                ];
              };
            }
          ];

          concurrency = {
            type = "connections";
            hard_limit = 100;
            soft_limit = 75;
          };
        }
      ];

      vm = [
        {
          memory = "256";
          cpu_kind = "shared";
          cpus = 1;
          processes = [ "app" ];
        }
      ];
    };

    machines.app = {
      config = {
        env = {
          FLY_PROCESS_GROUP = "app";
          PRIMARY_REGION = "yyz";
        };

        init.cmd = [
          "caddy"
          "run"
          "--config"
          "/etc/caddy/Caddyfile"
          "--adapter"
          "caddyfile"
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

        stop_config = {
          signal = "SIGQUIT";
          timeout = "30s";
        };

        services = [
          {
            internal_port = 8080;
            protocol = "tcp";
            autostart = true;
            autostop = true;
            force_instance_key = null;

            ports = [
              {
                port = 80;
                handlers = [ "http" ];
                force_https = true;
              }
              {
                port = 443;
                handlers = [
                  "tls"
                  "http"
                ];
                tls_options = {
                  alpn = [ "http/1.1" ];
                  versions = [
                    "TLSv1.2"
                    "TLSv1.3"
                  ];
                };
              }
            ];

            concurrency = {
              type = "connections";
              hard_limit = 100;
              soft_limit = 75;
            };
          }
        ];
      };

      image.existingImage = "ghcr.io/remvze/moodist:v3.1.1@sha256:1a8f3c48a7d4a01f7b215613d0434fa83eba8d34efedf26e6a5b0a82154043d7";
    };
  };
}
