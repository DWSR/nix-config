{
  flyApp = {
    name = "mc-atuin";

    settings = {
      primary_region = "yyz";

      experimental = {
        cmd = [
          "serve"
          "start"
        ];
        auto_rollback = true;
      };

      env = {
        ATUIN_HOST = "0.0.0.0";
        ATUIN_PORT = "8888";
        ATUIN_OPEN_REGISTRATION = "true";
        ATUIN_DB_URI = "sqlite:///data/atuin.db";
      };

      mounts = [
        {
          source = "atuin_data";
          destination = "/data";
          initial_size = "1";
          snapshot_retention = 14;
          auto_extend_size_threshold = 90;
          auto_extend_size_increment = "1GB";
          auto_extend_size_limit = "1GB";
        }
      ];

      services = [
        {
          protocol = "tcp";
          internal_port = 8888;
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

          http_checks = [
            {
              grace_period = "10s";
              method = "get";
              path = "/healthz";
              protocol = "http";
            }
          ];
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
          ATUIN_HOST = "0.0.0.0";
          ATUIN_PORT = "8888";
          ATUIN_OPEN_REGISTRATION = "true";
          ATUIN_DB_URI = "sqlite:///data/atuin.db";
        };

        init.cmd = [
          "serve"
          "start"
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

        mounts = [
          {
            # Existing `atuin_data` volume in yyz; the Machines API takes its
            # ID, and Fly-set fields round-trip through the reconciler.
            volume = "vol_4qlw3g6j6qx8296r";
            name = "atuin_data";
            path = "/data";
            size_gb = 1;
            encrypted = true;
            extend_threshold_percent = 90;
            add_size_gb = 1;
            size_gb_limit = 1;
          }
        ];

        services = [
          {
            protocol = "tcp";
            internal_port = 8888;
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

            checks = [
              {
                type = "http";
                grace_period = "10s";
                method = "get";
                path = "/healthz";
                protocol = "http";
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

      image.existingImage = "ghcr.io/atuinsh/atuin:18.10.0@sha256:4a29feda6f352581ece849807445fe1f50f2074b4643b7bfe62b27e23705b068";
    };
  };
}
