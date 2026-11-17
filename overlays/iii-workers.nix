# Pinned iii 0.26.0 worker catalog: registry snapshot 2026-11-16.
#
# Pure data transcribed from `.kiro/specs/iii-engine-on-the-fabro-host/
# research.md` § Worker catalog snapshot (2026-11-16). Nothing here is resolved
# at evaluation time: every entry records an exact version, the archive-root
# executable, and one immutable artifact URL plus its SHA-256 SRI hash per
# target. There is no `latest`, no registry query, and no URL-template
# fallback, so a version bump or a moved artifact is a deliberate edit.
#
# `acp`, `compose-ui`, and `mcp` do not follow the
# `https://cdn.iii.cloud/workers/<name>/<version>/<name>-<target>.tar.gz`
# template, so their full URLs are recorded; `acp` also ships `iii-acp` as its
# archive-root executable. Entries are sorted by worker name so a bump touches
# one contiguous block.
{
  engineVersion = "0.26.0";

  # Nix system -> upstream artifact target triple.
  targetTriples = {
    "aarch64-linux" = "aarch64-unknown-linux-gnu";
    "aarch64-darwin" = "aarch64-apple-darwin";
  };

  workers = {
    a2ui = {
      version = "0.2.2";
      binary = "a2ui";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/a2ui/0.2.2/a2ui-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-VrXwGzk4Xqr4voqqi+gCtmpF8mWDW479cSCA6UsrN+Q=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/a2ui/0.2.2/a2ui-aarch64-apple-darwin.tar.gz";
          hash = "sha256-zR/9Ef/GiDUqSU9jZorhx8DVdii38iqqkHaU21vLA5Q=";
        };
      };
    };
    acp = {
      version = "0.4.3";
      binary = "iii-acp";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/acp/0.4.3/acp-iii-acp-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-fdP6tzHKfP0yIeKnHLNlX2Mbzyara0E+DWxDPX+v6Cc=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/acp/0.4.3/acp-iii-acp-aarch64-apple-darwin.tar.gz";
          hash = "sha256-4gmmiLAB5C01Ra9ysL9Qg8yMmDSpxzsgvOGIQT+8N+A=";
        };
      };
    };
    ade = {
      version = "1.10.7";
      binary = "ade";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/ade/1.10.7/ade-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-AmoHqEcZgAi987XY1akLUwWnls5hAa2kWqUz+4ops2g=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/ade/1.10.7/ade-aarch64-apple-darwin.tar.gz";
          hash = "sha256-PqBkdWrWI1K5mVBacAebfA0c7opTRjvQBjqfYgOJguA=";
        };
      };
    };
    approval-gate = {
      version = "1.1.3";
      binary = "approval-gate";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/approval-gate/1.1.3/approval-gate-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-ou3lY408DcI0CcFwvZImJ/8Jlyf7br8sO881QkPzODw=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/approval-gate/1.1.3/approval-gate-aarch64-apple-darwin.tar.gz";
          hash = "sha256-hu5XfqB9fhqHzXOvDODarjMCmIU/GQV+BLNk785eOoI=";
        };
      };
    };
    bridge = {
      version = "0.2.2";
      binary = "bridge";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/bridge/0.2.2/bridge-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-NggGh5I/kDbQfPOvZlSh2LtXaINn3NL24ipByLvnHhE=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/bridge/0.2.2/bridge-aarch64-apple-darwin.tar.gz";
          hash = "sha256-H+TL6NphafL2M6+kWTnMYyC5bjS0y0iPLyDlYhmtD2o=";
        };
      };
    };
    browser = {
      version = "0.3.4";
      binary = "browser";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/browser/0.3.4/browser-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-lZ2CUJtHVPCffdbPNO35neXhMtutulS2z4fxantODa8=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/browser/0.3.4/browser-aarch64-apple-darwin.tar.gz";
          hash = "sha256-2innCsd35eGiVfjwO6UgTO1cVaZ+bTRqEiHJqM4faU8=";
        };
      };
    };
    canvas = {
      version = "0.2.1";
      binary = "canvas";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/canvas/0.2.1/canvas-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-20XDfgQpF4nzh4Wti5N3RiHVlnOcluy8RbJDyVdqOKs=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/canvas/0.2.1/canvas-aarch64-apple-darwin.tar.gz";
          hash = "sha256-urOIoo09cWWwwCCFgagXhkb82O/PWUScPAd1EXjNwhw=";
        };
      };
    };
    code-runner = {
      version = "0.2.2";
      binary = "code-runner";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/code-runner/0.2.2/code-runner-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-cno74Sw1f0M0KaSqAz4zBapYBmaQGlnnakd/3IHK7o8=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/code-runner/0.2.2/code-runner-aarch64-apple-darwin.tar.gz";
          hash = "sha256-qliP5Kzm69DHvxr++iM0lPbF1ZXY35fMuyRJPx/f6UY=";
        };
      };
    };
    codex = {
      version = "0.2.1";
      binary = "codex";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/codex/0.2.1/codex-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-3vqp3UNnR6q2v8xvSqbJ9CCYfaei860jVo47EC5E0uc=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/codex/0.2.1/codex-aarch64-apple-darwin.tar.gz";
          hash = "sha256-CVd8EMif/O6dunrJA/SNgSGGmkLM4t5EfXgBJZpHXag=";
        };
      };
    };
    compose-ui = {
      version = "0.1.9";
      binary = "compose-ui";
      targets = {
        "aarch64-linux" = {
          url = "https://github.com/iii-hq/workers/releases/download/build-ff0797e0ed83137d92719a7d2788dbe17b07d796/compose-ui-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-Nip6Nonift9eMPBhGWB8M9Cl2lELVgHhj4mvmQafbjI=";
        };
        "aarch64-darwin" = {
          url = "https://github.com/iii-hq/workers/releases/download/build-ff0797e0ed83137d92719a7d2788dbe17b07d796/compose-ui-aarch64-apple-darwin.tar.gz";
          hash = "sha256-VObDNesr31Qv8lONl5ZfCsuBNHs5SOV3+iy9LSPQnsg=";
        };
      };
    };
    computer = {
      version = "0.2.3";
      binary = "computer";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/computer/0.2.3/computer-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-aTtXI/AeW/AA6WfkCYOpaUeGF/rhbjgwridYCD/MMmY=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/computer/0.2.3/computer-aarch64-apple-darwin.tar.gz";
          hash = "sha256-cdy9NsYE8isXVLGepy/kxtFST0T8KLkKEFz1ap4brjU=";
        };
      };
    };
    context-manager = {
      version = "1.2.3";
      binary = "context-manager";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/context-manager/1.2.3/context-manager-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-J2HAbVJvamwK8y3x3L3CP+rrQlNAkT7xPupoRRVAH7c=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/context-manager/1.2.3/context-manager-aarch64-apple-darwin.tar.gz";
          hash = "sha256-hLxqLVKATFcID7vIK+L3FJy0WXI+kencBxyuHjiJJtM=";
        };
      };
    };
    cron = {
      version = "0.22.1";
      binary = "cron";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/cron/0.22.1/cron-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-kLWY3OUdwGA3OcXoPp14/WUpOC4lJZlXFco/ktWcC7o=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/cron/0.22.1/cron-aarch64-apple-darwin.tar.gz";
          hash = "sha256-jHRzE3bNvEI73DGBPFIGnNH4WAVD3hrR9DB5F48eoAY=";
        };
      };
    };
    database = {
      version = "0.6.3";
      binary = "database";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/database/0.6.3/database-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-JF9OYfXvgPSwwg7j4ViSte5ckmXD3Mu6npyaX9uicaQ=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/database/0.6.3/database-aarch64-apple-darwin.tar.gz";
          hash = "sha256-m+YbAICrRYoIKRnI652WbAq/c5BmfqlcBDjRmq9YXyU=";
        };
      };
    };
    document = {
      version = "0.2.1";
      binary = "document";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/document/0.2.1/document-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-2tKo+uWI20nG0Bu7iNxjrn0Tcvedqe8iofRoYt3AYjo=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/document/0.2.1/document-aarch64-apple-darwin.tar.gz";
          hash = "sha256-eaZ3Xrh9f9BWvn9hDoPUlmd01yOHzlPDAGFY7jv9wV0=";
        };
      };
    };
    email = {
      version = "0.2.1";
      binary = "email";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/email/0.2.1/email-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-iDzBAcdjOM4plrAvqzFSbo+fSIcMcilhvPq7lWZGD3g=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/email/0.2.1/email-aarch64-apple-darwin.tar.gz";
          hash = "sha256-CgTfmwOJKJDaMWa8NYVG7g8woPUwpegwRq6rSCrGPs4=";
        };
      };
    };
    eval = {
      version = "0.3.4";
      binary = "eval";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/eval/0.3.4/eval-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-iJ/w5VnUiPWe9dIvuhldByt7wSdLcZ+jR8oqg8gyrbU=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/eval/0.3.4/eval-aarch64-apple-darwin.tar.gz";
          hash = "sha256-GyMyFI4//deUd1yKjRVjR0e+ohbZEoZpfrD3NeEDry4=";
        };
      };
    };
    fp = {
      version = "0.3.1";
      binary = "fp";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/fp/0.3.1/fp-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-yvB+wW1pspi1Y3I745hE8ts3CHhUja/8pewQgcvId30=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/fp/0.3.1/fp-aarch64-apple-darwin.tar.gz";
          hash = "sha256-bF5/97pxKXwrtNxXV4rhSnuElY4cKfiJmXfvxq9zbHo=";
        };
      };
    };
    github = {
      version = "0.5.3";
      binary = "github";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/github/0.5.3/github-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-4IL/TjHXYT9vppF+PErA6nbuITQKWxKqBd3hf2f6SyQ=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/github/0.5.3/github-aarch64-apple-darwin.tar.gz";
          hash = "sha256-ykQ8qiBJ9J5QelQMplwt8xcOPpH06waHmyWDV0EKSpw=";
        };
      };
    };
    harness = {
      version = "1.9.9";
      binary = "harness";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/harness/1.9.9/harness-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-eO4h8OZxAH6mG/Y3nQpaD66C3bvEtUMDrkCV2+Sj+l8=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/harness/1.9.9/harness-aarch64-apple-darwin.tar.gz";
          hash = "sha256-93MCiIZLNSx8QvBmmLHCpZGJYSp1kon6sZXAgaZt1bw=";
        };
      };
    };
    http = {
      version = "0.23.3";
      binary = "http";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/http/0.23.3/http-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-N7bKo8dQ0LtEadhvIbtjirCcGDENwPbIgkztvcZ0S7I=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/http/0.23.3/http-aarch64-apple-darwin.tar.gz";
          hash = "sha256-R0gyaArNfhdZfe/IXPRK6D4PzWbvunlXCOO0nk1Ng24=";
        };
      };
    };
    ide = {
      version = "0.13.5";
      binary = "ide";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/ide/0.13.5/ide-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-D5Z5gDCzBcuzbsjOwlMwZd3Pnfa6p0HDrKnXtefu790=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/ide/0.13.5/ide-aarch64-apple-darwin.tar.gz";
          hash = "sha256-ymLdRo4nukcz3MS2nAWtQ8Y+Quad1fu0B94Px5coB0o=";
        };
      };
    };
    iii-directory = {
      version = "1.3.5";
      binary = "iii-directory";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/iii-directory/1.3.5/iii-directory-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-4FqYNVg9kSwplsl/22dh2GcAEM4TjteN78nqS0Ny1yA=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/iii-directory/1.3.5/iii-directory-aarch64-apple-darwin.tar.gz";
          hash = "sha256-7oFblFGwF4nSIAnqRDYLH5TULuyt03ZUxhw9yQ9lkBI=";
        };
      };
    };
    image-resize = {
      version = "0.2.1";
      binary = "image-resize";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/image-resize/0.2.1/image-resize-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-mBqKz+wf4TfQvxknxWPxVbqcBWzxIwrbdn03LGXaESU=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/image-resize/0.2.1/image-resize-aarch64-apple-darwin.tar.gz";
          hash = "sha256-eZ8r0ttANODg8gc3G0s5mDhkKuXJXdvobLpjcpVec0w=";
        };
      };
    };
    judge = {
      version = "0.3.3";
      binary = "judge";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge/0.3.3/judge-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-zq88B0sN+xrNWuQxa7yjssHHPS5Q6frepfqgXgR2WS4=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge/0.3.3/judge-aarch64-apple-darwin.tar.gz";
          hash = "sha256-uA7xwr4McDvAk+jKGvgjB0k4ARM8QabFGR+O41uQOQw=";
        };
      };
    };
    judge-clef = {
      version = "0.3.2";
      binary = "judge-clef";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge-clef/0.3.2/judge-clef-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-iYsLhe+aY9RWzulQdw6ABmAayQtwSPir0aRAnkpjeVg=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge-clef/0.3.2/judge-clef-aarch64-apple-darwin.tar.gz";
          hash = "sha256-ukzIEcqCO9znN1gk1wuLVXKdySaX7cRS5tcyyghxqpU=";
        };
      };
    };
    judge-decider = {
      version = "0.3.2";
      binary = "judge-decider";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge-decider/0.3.2/judge-decider-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-f7QDWO1kjHc+8ZRkD381+1zgf2d4hMrf3Duz6JrnyJM=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge-decider/0.3.2/judge-decider-aarch64-apple-darwin.tar.gz";
          hash = "sha256-75hZcek95qaxZNSu8Ztj8lUjc438c18OKrSPGh5Mkwc=";
        };
      };
    };
    judge-laya = {
      version = "0.3.2";
      binary = "judge-laya";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge-laya/0.3.2/judge-laya-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-JOAROiJkB8r/ltoMIY/ig3Gp2yRv/AnNvMjWDXUVA3c=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge-laya/0.3.2/judge-laya-aarch64-apple-darwin.tar.gz";
          hash = "sha256-mhYfCT//xC91/nc6KSdlO9xquWYKX3ThXgigvTvhgNE=";
        };
      };
    };
    judge-openai = {
      version = "0.3.2";
      binary = "judge-openai";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge-openai/0.3.2/judge-openai-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-vZkLVYYxJZrsBlejBqBvf9eWnDxXmAwQtK7Te/VUngI=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge-openai/0.3.2/judge-openai-aarch64-apple-darwin.tar.gz";
          hash = "sha256-UG5ZgOXhssAJDmBiZbXna5UisynAlxCvx5PJ2MsS3xc=";
        };
      };
    };
    judge-semif = {
      version = "0.3.2";
      binary = "judge-semif";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge-semif/0.3.2/judge-semif-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-fLN+4OQvxvVBI6rxFtFONd8Xq+tdwoNKsDRyYI5gdKw=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge-semif/0.3.2/judge-semif-aarch64-apple-darwin.tar.gz";
          hash = "sha256-p3JKjVnYJ02OgSkMFWrunwHzJl1Wx8Pshl42Hzz3dDY=";
        };
      };
    };
    judge-typesafe = {
      version = "0.3.2";
      binary = "judge-typesafe";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/judge-typesafe/0.3.2/judge-typesafe-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-lH7EZN4zY9V0voMO+SWXwENjXMDW7DTVcjQiJew3NvA=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/judge-typesafe/0.3.2/judge-typesafe-aarch64-apple-darwin.tar.gz";
          hash = "sha256-68jWpMOWXaGQF8tzKxw47sZ+Wf4nHj8jdQLnP3lvnCQ=";
        };
      };
    };
    kanban = {
      version = "0.2.2";
      binary = "kanban";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/kanban/0.2.2/kanban-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-4e6CgXs7KiTVcjTlf+euLmSSu8igBfJNVnfmdhfEDxc=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/kanban/0.2.2/kanban-aarch64-apple-darwin.tar.gz";
          hash = "sha256-zgUsJxKwUrrdL6lsdZwQBES7vo/Sd3gFfEs64eaSv4s=";
        };
      };
    };
    llm-router = {
      version = "1.5.3";
      binary = "llm-router";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/llm-router/1.5.3/llm-router-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-J0JyLa1zP51quUIY8qplSjuhXbtuYPs38P+gfpGZBDQ=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/llm-router/1.5.3/llm-router-aarch64-apple-darwin.tar.gz";
          hash = "sha256-Q/tTEzqb5GKP1A/rXzqFtvUlKbUTOBM3JrNK4EO7ZnA=";
        };
      };
    };
    lsp = {
      version = "0.2.0";
      binary = "lsp";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/lsp/0.2.0/lsp-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-rwdqanGGqhn5dOum0mbyMnbG05W2EoBNNynra3E1Cf0=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/lsp/0.2.0/lsp-aarch64-apple-darwin.tar.gz";
          hash = "sha256-tRWhSZIdHeKFf4pd3IN08gXq+o36+Oo4goi43OLhFao=";
        };
      };
    };
    mcp = {
      version = "0.5.9";
      binary = "mcp";
      targets = {
        "aarch64-linux" = {
          url = "https://github.com/iii-hq/workers/releases/download/mcp/v0.5.9/mcp-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-bgu9wGdKjcv+OkpZomu6eXI1LREfDjzHVxb45XGcKfo=";
        };
        "aarch64-darwin" = {
          url = "https://github.com/iii-hq/workers/releases/download/mcp/v0.5.9/mcp-aarch64-apple-darwin.tar.gz";
          hash = "sha256-AXXbWoNY0drrWBgMO2uXeI2s0aJLr+Z3Vp+aQKeUKUI=";
        };
      };
    };
    memory = {
      version = "0.3.4";
      binary = "memory";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/memory/0.3.4/memory-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-8Ciz2oYevQ98LPcYWpK0V4NTCc5Ys/wxZyDmi/Q3HwQ=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/memory/0.3.4/memory-aarch64-apple-darwin.tar.gz";
          hash = "sha256-EGtbstUSKo0Q1j3P9FRVT+xdq9lWnjUtQZNNhVfHghE=";
        };
      };
    };
    memory-consolidate = {
      version = "0.2.3";
      binary = "memory-consolidate";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/memory-consolidate/0.2.3/memory-consolidate-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-WLjPw8oOEF1/2HvSHpyO/FAH7ZJ/66u8E8acXK5cKfo=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/memory-consolidate/0.2.3/memory-consolidate-aarch64-apple-darwin.tar.gz";
          hash = "sha256-+j66NUqca37d0LQeo+6zDqaX4qB46rTo3hkOWeMv2ao=";
        };
      };
    };
    mesh = {
      version = "0.3.2";
      binary = "mesh";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/mesh/0.3.2/mesh-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-OEdVznDP65ln087sUZW4ab+w0pRYz91j3+wnJYiYMAg=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/mesh/0.3.2/mesh-aarch64-apple-darwin.tar.gz";
          hash = "sha256-80YCqR9902wSteu7H8SJouMkjzOrZTCYygQj9IqnlDE=";
        };
      };
    };
    pdf = {
      version = "0.2.2";
      binary = "pdf";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/pdf/0.2.2/pdf-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-OGESocLpSKTYsgAFfcm2rk2ETXmXo2dyxlcPPR2czY8=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/pdf/0.2.2/pdf-aarch64-apple-darwin.tar.gz";
          hash = "sha256-zTYWvfZBoONywRpOMq/6RBA0f+58IcVEwiO/tIQGlRw=";
        };
      };
    };
    provider-anthropic = {
      version = "1.3.2";
      binary = "provider-anthropic";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-anthropic/1.3.2/provider-anthropic-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-G0cYPSf8oa9ghfsNsT/FCZWUcuAe3lySnTY5+2Sc21Y=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-anthropic/1.3.2/provider-anthropic-aarch64-apple-darwin.tar.gz";
          hash = "sha256-5+K2prG6mzfsXL2W8qJsLRLIzCnAmnbrWJsQSp7t+b0=";
        };
      };
    };
    provider-claude-code = {
      version = "0.2.4";
      binary = "provider-claude-code";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-claude-code/0.2.4/provider-claude-code-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-IisBSe14YolAVhgTsawgb5nrO30gzmFm/rMJcdI5EiI=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-claude-code/0.2.4/provider-claude-code-aarch64-apple-darwin.tar.gz";
          hash = "sha256-A+XeojgKQtIBwypDrN/JDNdGVtCEiVKxo043cy0LzI4=";
        };
      };
    };
    provider-command-code = {
      version = "0.2.0";
      binary = "provider-command-code";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-command-code/0.2.0/provider-command-code-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-P3nfI69eu5/8Av1ST60yloxSa7FeMoLlX31rgTHGPlo=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-command-code/0.2.0/provider-command-code-aarch64-apple-darwin.tar.gz";
          hash = "sha256-3EPchTcJ0sRGzm/ElPJEDmO49zJTeaUWl0OaogDS9T0=";
        };
      };
    };
    provider-deepseek = {
      version = "0.2.0";
      binary = "provider-deepseek";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-deepseek/0.2.0/provider-deepseek-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-v9W3L44BzHzcb0+h1HUZ373K4R+Ihdh/NkLvlY2j2RM=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-deepseek/0.2.0/provider-deepseek-aarch64-apple-darwin.tar.gz";
          hash = "sha256-kFKnUOgpNjKoR5yiJh2GAOVMJuE3GgCUJHkkxZ566VY=";
        };
      };
    };
    provider-elevenlabs = {
      version = "0.2.0";
      binary = "provider-elevenlabs";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-elevenlabs/0.2.0/provider-elevenlabs-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-CfG6/tyAT+GX+kOLwTQI7+MtmCMlQc4+JEIOnp6txa0=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-elevenlabs/0.2.0/provider-elevenlabs-aarch64-apple-darwin.tar.gz";
          hash = "sha256-YDq3eX/KstxBewg7AvPwEMiR+QR+Gz2H6127Ev3CrVE=";
        };
      };
    };
    provider-github-copilot = {
      version = "0.2.0";
      binary = "provider-github-copilot";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-github-copilot/0.2.0/provider-github-copilot-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-U1e+7sx1bjffsdD1xPw+P4F2JGDX8xZc9HevuWlws24=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-github-copilot/0.2.0/provider-github-copilot-aarch64-apple-darwin.tar.gz";
          hash = "sha256-nohG7+d0b9JbXE/G060RVrJhNHGKtxSIgJ/IxRX8Sv0=";
        };
      };
    };
    provider-kimi = {
      version = "1.2.1";
      binary = "provider-kimi";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-kimi/1.2.1/provider-kimi-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-UhhIe/lmHQLcK/DI4tQ1aipG061xWNbZBHFXmXDR2bo=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-kimi/1.2.1/provider-kimi-aarch64-apple-darwin.tar.gz";
          hash = "sha256-2BgMHoZzsvo48WS/vn2a4+iOAqpniqRtcpQs9sf6cxE=";
        };
      };
    };
    provider-llamacpp = {
      version = "0.4.1";
      binary = "provider-llamacpp";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-llamacpp/0.4.1/provider-llamacpp-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-tpGd7oUtJQ2qALHi2lJw+wacgbJclfP6gKUwbVu34ao=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-llamacpp/0.4.1/provider-llamacpp-aarch64-apple-darwin.tar.gz";
          hash = "sha256-mS/ojJetYpj+eRfhmHqPgt49Ppr7FnediI3GTrgRe04=";
        };
      };
    };
    provider-openai = {
      version = "1.3.1";
      binary = "provider-openai";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-openai/1.3.1/provider-openai-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-KxwOrat184KxF4jPtWJh5AHkdYr2d/1meAhA5QoiQqs=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-openai/1.3.1/provider-openai-aarch64-apple-darwin.tar.gz";
          hash = "sha256-y3lCe0o4w/brBxlq4KSlKrkHT61mQULTwjoaky5gSqU=";
        };
      };
    };
    provider-openai-codex = {
      version = "0.5.1";
      binary = "provider-openai-codex";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-openai-codex/0.5.1/provider-openai-codex-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-h98nayPk0iV06yu12FmYDPjZCMd0VBwtEyihmPEnVaY=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-openai-codex/0.5.1/provider-openai-codex-aarch64-apple-darwin.tar.gz";
          hash = "sha256-jVE0j5GQwMqhcFeSjWPltWBiMyJpYAxj7ENw0VZxjEk=";
        };
      };
    };
    provider-opencode-go = {
      version = "0.1.0";
      binary = "provider-opencode-go";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-opencode-go/0.1.0/provider-opencode-go-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-NuYvIyYI48xUbUWVLRcNoF56i8YKumBAMfc7YO4Ivkw=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-opencode-go/0.1.0/provider-opencode-go-aarch64-apple-darwin.tar.gz";
          hash = "sha256-OOG7w5JJ3Yo++tS8v3sggv80At2YRAFbLh3s+cp5Gds=";
        };
      };
    };
    provider-openrouter = {
      version = "0.2.0";
      binary = "provider-openrouter";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-openrouter/0.2.0/provider-openrouter-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-iHA1HGXkiG35kCrHq89bFhtsEsKOI3zSvvr4+1nrloI=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-openrouter/0.2.0/provider-openrouter-aarch64-apple-darwin.tar.gz";
          hash = "sha256-yDbvGo4ETlgffYW9ADfecjumoLB7K2Jsu+N9NzKRczk=";
        };
      };
    };
    provider-sarvam = {
      version = "0.2.0";
      binary = "provider-sarvam";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-sarvam/0.2.0/provider-sarvam-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-9myCxx05Z5029hZjBI5RzpsuM4RxAdf9H2YhWsyqX4A=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-sarvam/0.2.0/provider-sarvam-aarch64-apple-darwin.tar.gz";
          hash = "sha256-YxwS5suCrRp/KVfe4flfFV92wELukeCHfULpIz88Aus=";
        };
      };
    };
    provider-xai = {
      version = "1.4.2";
      binary = "provider-xai";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-xai/1.4.2/provider-xai-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-Jhbli3dbDjlbmAzsR+KLhAlBYTlrTAYBvyRYE9zkor4=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-xai/1.4.2/provider-xai-aarch64-apple-darwin.tar.gz";
          hash = "sha256-L4F7oHoHM3n7UralLD10EJ8kGPUqw4zrlhaXY/PdUtI=";
        };
      };
    };
    provider-zai = {
      version = "0.6.0";
      binary = "provider-zai";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/provider-zai/0.6.0/provider-zai-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-LDVfUp/BmzF/rYNivpXE1Z5yXO+Xi0CkD/WNkLlEmdc=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/provider-zai/0.6.0/provider-zai-aarch64-apple-darwin.tar.gz";
          hash = "sha256-tK4Oh0in7FzdIlfuvJX4R1/2X5XvvRLfxSwSrjnCzww=";
        };
      };
    };
    queue = {
      version = "0.22.2";
      binary = "queue";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/queue/0.22.2/queue-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-Drl4ZrlUw9IarfbqxyI7orozziAqRavCHVcTBypjvmA=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/queue/0.22.2/queue-aarch64-apple-darwin.tar.gz";
          hash = "sha256-JG60FqkXntB2LDb6FXo34BPq6Y1fVAF68h6ikmDOgmM=";
        };
      };
    };
    quick-tunnel = {
      version = "0.2.4";
      binary = "quick-tunnel";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/quick-tunnel/0.2.4/quick-tunnel-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-MrU7iuqRFCvl/KuwqV8khj0M/VEWn4V4U/DwK2gYk3o=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/quick-tunnel/0.2.4/quick-tunnel-aarch64-apple-darwin.tar.gz";
          hash = "sha256-jhp/N+bxI3LyFzx4Q5pKNSDQjFvZ6vqSAVtEDezwDuA=";
        };
      };
    };
    rbac-proxy = {
      version = "1.1.5";
      binary = "rbac-proxy";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/rbac-proxy/1.1.5/rbac-proxy-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-qkHmeqgU2/6HdmHLzm2FH0TVOsyJkQCEo8nfPj79mpY=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/rbac-proxy/1.1.5/rbac-proxy-aarch64-apple-darwin.tar.gz";
          hash = "sha256-B/vRYxmEiiNlvyCvLNaEsA5SM46sXrKiM6YlGHq+uc0=";
        };
      };
    };
    sandbox-libkrun = {
      version = "0.4.3";
      binary = "sandbox-libkrun";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/sandbox-libkrun/0.4.3/sandbox-libkrun-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-TrrdCRk+ZLkCnGZO60Ks0hrgvamKbMhRnPfoNJpEV40=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/sandbox-libkrun/0.4.3/sandbox-libkrun-aarch64-apple-darwin.tar.gz";
          hash = "sha256-C9sFClCsZosCZWm93uvdDGu1wDzB+W0CwV7GdalSpqA=";
        };
      };
    };
    secrets = {
      version = "0.2.2";
      binary = "secrets";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/secrets/0.2.2/secrets-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-wEXDVl54+PQ3XJoNIDxAHelI41gHNUxvAkzqODHvFug=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/secrets/0.2.2/secrets-aarch64-apple-darwin.tar.gz";
          hash = "sha256-UjCAC+MkkVYFdgxcPZ1s6saHEPOlrJOp6Vs8d/02g/U=";
        };
      };
    };
    security-scan = {
      version = "0.2.4";
      binary = "security-scan";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/security-scan/0.2.4/security-scan-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-NgD9BfPOJJYPBFTk8SreIIMq+Xnf3wPmWLkLQLnPEIs=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/security-scan/0.2.4/security-scan-aarch64-apple-darwin.tar.gz";
          hash = "sha256-6vjt9aBOhCsb96fu290UnOiXtqEbKb+iX6yWEJnEG1w=";
        };
      };
    };
    sentinel = {
      version = "0.2.5";
      binary = "sentinel";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/sentinel/0.2.5/sentinel-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-2UodJH3ZkJb4MuEtboG0j3vsbcHxQj9p8J5ieK4nSAE=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/sentinel/0.2.5/sentinel-aarch64-apple-darwin.tar.gz";
          hash = "sha256-KnVWyKNkSdmCfQ63QHVhOIQJ6QrFs12bqnVcSIDrvo8=";
        };
      };
    };
    session-manager = {
      version = "1.1.1";
      binary = "session-manager";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/session-manager/1.1.1/session-manager-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-y64X436L/qFBqlBsNEa6pOduFb0Tw6jLaRNpQYMQoyw=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/session-manager/1.1.1/session-manager-aarch64-apple-darwin.tar.gz";
          hash = "sha256-6oA3dh4mxF+CSJgfSByd0OZDDKdfs+yaf5N33smn1QY=";
        };
      };
    };
    slack = {
      version = "0.2.1";
      binary = "slack";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/slack/0.2.1/slack-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-bHQNZRn55amig9msXvjHS3rnJPYLe62kzFZTYdbeNiU=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/slack/0.2.1/slack-aarch64-apple-darwin.tar.gz";
          hash = "sha256-gHVdj4ugtzfMXyXbFojDOY3F08fdTV0xTY5EyqHY6LA=";
        };
      };
    };
    state = {
      version = "0.23.1";
      binary = "state";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/state/0.23.1/state-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-fB1kjoG19ByNcgDBCQ2zbAQL0N8fcapocCJcOoOlKn4=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/state/0.23.1/state-aarch64-apple-darwin.tar.gz";
          hash = "sha256-lCDoGGvgM15YTW3iPY2dojdigzccU2RH/JpDnZit/U4=";
        };
      };
    };
    storage = {
      version = "0.2.3";
      binary = "storage";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/storage/0.2.3/storage-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-dTiyOMx2PjzVYzCR7OrgJA8hoU2UGF+2NsgufUnrSCc=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/storage/0.2.3/storage-aarch64-apple-darwin.tar.gz";
          hash = "sha256-bVRHrCobu1p5GkqVPwrkA96an7dqZKwFQBJUom/fj/k=";
        };
      };
    };
    stories = {
      version = "0.2.1";
      binary = "stories";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/stories/0.2.1/stories-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-r+6nHdSeDa6YlzCw2z/3GLmzlqp/NlgGyXGCfBo+NP0=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/stories/0.2.1/stories-aarch64-apple-darwin.tar.gz";
          hash = "sha256-IqEVnPS5ASrIYvkAGW4eRELvDb3IVDt8LGzk8uRF6XE=";
        };
      };
    };
    tailscale = {
      version = "0.2.1";
      binary = "tailscale";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/tailscale/0.2.1/tailscale-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-tfH3q3nKeUZLgc1SG89z8qi+4G6iKqOpuGFyF+/9o0g=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/tailscale/0.2.1/tailscale-aarch64-apple-darwin.tar.gz";
          hash = "sha256-j5wzpS/8soE5AUV+XWiPEVjviCP79bg1/79LqDKo30A=";
        };
      };
    };
    telegram-bot = {
      version = "0.4.3";
      binary = "telegram-bot";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/telegram-bot/0.4.3/telegram-bot-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-8iWZpCsV2UTOIAh6PYFMka/yN0pE/4VyUbM8n7Nv8Tk=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/telegram-bot/0.4.3/telegram-bot-aarch64-apple-darwin.tar.gz";
          hash = "sha256-K6Z3/oGsC3Wl2Deajxg8mYtKZCAhOGtmCOr7UQMxzJY=";
        };
      };
    };
    tmux = {
      version = "0.2.9";
      binary = "tmux";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/tmux/0.2.9/tmux-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-pvKrNawhDNbb/StlPhgvHsl3KQ5RKAl5oLUGt/37y/o=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/tmux/0.2.9/tmux-aarch64-apple-darwin.tar.gz";
          hash = "sha256-mwZgCV62RM5r8g90X2xECZw/yJswfExnlI9McGiDgo4=";
        };
      };
    };
    web = {
      version = "1.3.1";
      binary = "web";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/web/1.3.1/web-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-zSc6wyYZZgKoOxPxEBBNsnAFG1Qd8bGtFqTTq9lNdhM=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/web/1.3.1/web-aarch64-apple-darwin.tar.gz";
          hash = "sha256-q4qlJtukerm6i3s76BeQ+mRtMMPmgFq79w05aA5q6W0=";
        };
      };
    };
    whatsapp = {
      version = "0.3.2";
      binary = "whatsapp";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/whatsapp/0.3.2/whatsapp-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-kzLhyL6z1CrogAqC4IggIXEgzgOrwFqW+kf+inTE/PI=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/whatsapp/0.3.2/whatsapp-aarch64-apple-darwin.tar.gz";
          hash = "sha256-R8Q+qTFkcaZgIawPxm2FT/+fovmjkKEWcYak+kldNjE=";
        };
      };
    };
    workflow = {
      version = "0.3.0";
      binary = "workflow";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/workflow/0.3.0/workflow-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-KVrDUhDk4XIVaosaK+mOn1NkwcZ2UAiGpKU5/psRfaY=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/workflow/0.3.0/workflow-aarch64-apple-darwin.tar.gz";
          hash = "sha256-Q3xd7I4PpeSXhw4Sp4LTAg+WPWIZcRkgDj+bUTge0m8=";
        };
      };
    };
    worktree = {
      version = "0.4.3";
      binary = "worktree";
      targets = {
        "aarch64-linux" = {
          url = "https://cdn.iii.cloud/workers/worktree/0.4.3/worktree-aarch64-unknown-linux-gnu.tar.gz";
          hash = "sha256-Rzph5qJuo2uVKMgIhjbZuIAzADN8v1wX+KyRT3rrN10=";
        };
        "aarch64-darwin" = {
          url = "https://cdn.iii.cloud/workers/worktree/0.4.3/worktree-aarch64-apple-darwin.tar.gz";
          hash = "sha256-+QqpNTOEVb7fCbXDRSO+hGle5ihjODYtpJqS4Zuq/iM=";
        };
      };
    };
  };
}
