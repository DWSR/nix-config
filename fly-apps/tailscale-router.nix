{
  flyApp = {
    name = "mc-tailscale-router";

    settings = {
      primary_region = "yyz";

      deploy.strategy = "rolling";

      experimental.exec = [
        "/bin/sh"
        "-c"
        "export PATH=$PATH:/usr/local/bin; containerboot"
      ];

      env = {
        PORT = "41641";
        TS_ENABLE_HEALTH_CHECK = "true";
        TS_ENABLE_METRICS = "true";
        TS_EXPERIMENTAL_ENABLE_FORWARDING_OPTIMIZATIONS = "true";
        TS_EXTRA_ARGS = "--advertise-tags=tag:flyio,tag:exit-node --advertise-exit-node";
        TS_ROUTES = "fdaa:a:7d38:0:1::/80";
        TS_USERSPACE = "false";
      };

      services = [
        {
          protocol = "udp";
          internal_port = 41641;
          processes = [ "app" ];

          ports = [ { port = 41641; } ];

          concurrency = {
            type = "connections";
            hard_limit = 100;
            soft_limit = 75;
          };
        }
      ];

      vm = [
        {
          memory = "512";
          cpus = 2;
        }
      ];

      metrics = [
        {
          port = 9002;
          path = "/metrics";
        }
      ];
    };

    machines.app = {
      config = {
        env = {
          FLY_PROCESS_GROUP = "app";
          PRIMARY_REGION = "yyz";
          PORT = "41641";
          TS_ENABLE_HEALTH_CHECK = "true";
          TS_ENABLE_METRICS = "true";
          TS_EXPERIMENTAL_ENABLE_FORWARDING_OPTIMIZATIONS = "true";
          TS_EXTRA_ARGS = "--advertise-tags=tag:flyio,tag:exit-node --advertise-exit-node";
          TS_ROUTES = "fdaa:a:7d38:0:1::/80";
          TS_USERSPACE = "false";
        };

        init.exec = [
          "/bin/sh"
          "-c"
          "export PATH=$PATH:/usr/local/bin; containerboot"
        ];

        guest = {
          cpu_kind = "shared";
          cpus = 2;
          memory_mb = 512;
        };

        metadata.fly_process_group = "app";

        restart = {
          policy = "on-failure";
          max_retries = 10;
        };

        services = [
          {
            protocol = "udp";
            internal_port = 41641;
            force_instance_key = null;

            ports = [ { port = 41641; } ];

            concurrency = {
              type = "connections";
              hard_limit = 100;
              soft_limit = 75;
            };
          }
        ];

        metrics = {
          port = 9002;
          path = "/metrics";
        };
      };

      image.existingImage = "docker.io/tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c";
    };
  };
}
