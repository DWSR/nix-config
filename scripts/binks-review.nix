{
  coreutils,
  gh,
  git,
  gnugrep,
  google-cloud-sdk,
  homeDirectory,
  lib,
  python313,
  uv,
  writeShellApplication,
}:
let
  binksPrReviewVersion = "0.13.3";
  uvInstallPath = lib.makeBinPath [
    coreutils
    git
    python313
  ];
  gitEligibilityPath = lib.makeBinPath [
    coreutils
    git
  ];
in
writeShellApplication {
  name = "binks-review";

  runtimeInputs = [
    coreutils
    gh
    git
    gnugrep
    google-cloud-sdk
    python313
    uv
  ];

  text = ''
    package="binks-pr-review"
    package_version="${binksPrReviewVersion}"
    package_spec="$package==$package_version"
    entrypoint="binks-pr-review"
    binks_production_url="https://binks.shopify.io"
    force_no_upload=0

    if [[ "''${1:-}" == "--no-upload" ]]; then
      force_no_upload=1
      shift
    fi

    check_repository_eligibility() {
      local remote_url remote_path owner repository
      local -a git_environment

      git_environment=(
        "${coreutils}/bin/env"
        -i
        "GIT_CONFIG_GLOBAL=/dev/null"
        "GIT_CONFIG_NOSYSTEM=1"
        "GIT_CONFIG_SYSTEM=/dev/null"
        "HOME=${homeDirectory}"
        "LC_ALL=C"
        "PATH=${gitEligibilityPath}"
      )

      # Read only literal repository-scoped configuration (local + worktree).
      # Ignore caller GIT_CONFIG_* overrides and fail closed on includes, URL
      # rewrites, or multiple origins that could change Git's effective URL.
      if "''${git_environment[@]}" "${git}/bin/git" config --no-includes --get-regexp '^include\.' >/dev/null 2>&1 \
        || "''${git_environment[@]}" "${git}/bin/git" config --no-includes --get-regexp '^includeif\.' >/dev/null 2>&1 \
        || "''${git_environment[@]}" "${git}/bin/git" config --no-includes --get-regexp '^url\.' >/dev/null 2>&1; then
        printf '%s\n' 'INELIGIBLE: local Git includes or URL rewrite rules are present' >&2
        return 1
      fi

      if ! remote_url="$("''${git_environment[@]}" "${git}/bin/git" config --no-includes --get-all remote.origin.url 2>/dev/null)" \
        || [[ -z "$remote_url" ]] \
        || [[ "$remote_url" == *$'\n'* ]]; then
        printf '%s\n' 'INELIGIBLE: remote.origin.url is missing or ambiguous' >&2
        return 1
      fi

      shopt -s nocasematch
      case "$remote_url" in
        https://github.com/*)
          remote_path="''${remote_url#https://github.com/}"
          ;;
        ssh://git@github.com/*)
          remote_path="''${remote_url#ssh://git@github.com/}"
          ;;
        git@github.com:*)
          remote_path="''${remote_url#git@github.com:}"
          ;;
        *)
          shopt -u nocasematch
          printf '%s\n' 'INELIGIBLE: origin is not an exact supported github.com URL' >&2
          return 1
          ;;
      esac

      remote_path="''${remote_path%.git}"
      owner="''${remote_path%%/*}"
      repository="''${remote_path#*/}"
      if [[ -z "$owner" \
        || -z "$repository" \
        || "$repository" == "$remote_path" \
        || "$repository" == */* \
        || "$repository" == "." \
        || "$repository" == ".." \
        || ! "$repository" =~ ^[A-Za-z0-9._-]+$ ]]; then
        shopt -u nocasematch
        printf '%s\n' 'INELIGIBLE: origin does not identify one GitHub organization and repository' >&2
        return 1
      fi

      if [[ "$owner" != "shopify" && "$owner" != "shop" ]]; then
        shopt -u nocasematch
        printf '%s\n' 'INELIGIBLE: GitHub organization is not Shopify or shop' >&2
        return 1
      fi
      shopt -u nocasematch

      printf 'ELIGIBLE: github.com/%s/%s\n' "$owner" "$repository"
    }

    if [[ "''${1:-}" == "--check-repository-eligibility" ]]; then
      if [[ "$#" -ne 1 ]]; then
        printf '%s\n' 'binks-review: --check-repository-eligibility accepts no other arguments' >&2
        exit 2
      fi
      check_repository_eligibility
      exit $?
    fi

    cloudsmith_url="pkgs.shopify.io/basic/data/python/simple/"
    cloudsmith_token_path="gs://dev-tokens/cloudsmith/shopify/data/latest"
    uv_toml="${homeDirectory}/.config/uv/uv.toml"

    uv_tool_dir="${homeDirectory}/.local/share/binks-review/tools"
    uv_tool_bin_dir="${homeDirectory}/.local/share/binks-review/bin"
    uv_cache_dir="${homeDirectory}/.cache/binks-review/uv"

    cloudsmith_username="''${UV_INDEX_CLOUDSMITH_USERNAME:-}"
    cloudsmith_password="''${UV_INDEX_CLOUDSMITH_PASSWORD:-}"
    requested_upload="''${BINKS_REVIEW_UPLOAD:-0}"
    requested_upload_user="''${BINKS_API_USER:-}"
    requested_upload_password="''${BINKS_API_PASSWORD:-}"
    proxy_binks_key="''${BINKS_AI_PROXY_KEY:-}"
    proxy_shopify_key="''${SHOPIFY_PROXY_KEY:-}"
    proxy_opencode_key="''${OPENCODE_API_KEY:-}"
    proxy_legacy_key="''${AI_PROXY_KEY:-}"
    proxy_openai_key="''${OPENAI_API_KEY:-}"
    proxy_anthropic_key="''${ANTHROPIC_API_KEY:-}"
    proxy_base_hint="''${BINKS_AI_PROXY_URL:-''${AI_PROXY_BASE_URL:-''${DEFAULT_PROXY_BASE:-}}}"

    if [[ "$force_no_upload" == 1 ]]; then
      requested_upload=0
      requested_upload_user=""
      requested_upload_password=""
    fi

    # Do not expose wrapper-managed credentials or routing to the mutable tool
    # installation during version checks. Restore only the canonical Binks key
    # and upload destination after the pinned version has been verified.
    unset \
      AI_PROXY_KEY \
      AI_PROXY_BASE_URL \
      ANTHROPIC_API_KEY \
      ANTHROPIC_AUTH_TOKEN \
      ANTHROPIC_BASE_URL \
      BINKS_AI_PROXY_KEY \
      BINKS_AI_PROXY_URL \
      BINKS_API_PASSWORD \
      BINKS_API_USER \
      BINKS_BASE_URL \
      BINKS_REVIEW_UPLOAD \
      DEFAULT_PROXY_BASE \
      OPENAI_API_KEY \
      OPENAI_BASE_URL \
      OPENCODE_API_KEY \
      SHOPIFY_PROXY_KEY \
      UV_CONFIG_FILE \
      UV_DEFAULT_INDEX \
      UV_EXTRA_INDEX_URL \
      UV_FIND_LINKS \
      UV_INDEX \
      UV_INDEX_CLOUDSMITH_PASSWORD \
      UV_INDEX_CLOUDSMITH_USERNAME \
      UV_INDEX_URL

    for variable_name in "''${!UV_INDEX_@}"; do
      unset "$variable_name"
    done

    tool_bin_dir="$uv_tool_bin_dir"

    has_cloudsmith_config() {
      [[ -f "$uv_toml" ]] && grep -q "$cloudsmith_url" "$uv_toml"
    }

    resolve_cloudsmith_index() {
      if [[ -n "$cloudsmith_password" ]]; then
        cloudsmith_install_url="https://''${cloudsmith_username:-token}:$cloudsmith_password@$cloudsmith_url"
        return 0
      fi

      if has_cloudsmith_config; then
        return 0
      fi

      printf 'Cloudsmith index not configured in %s; fetching token...\n' "$uv_toml" >&2

      local token
      if ! token="$(gcloud storage cat "$cloudsmith_token_path" 2>/dev/null)" || [[ -z "$token" ]]; then
        printf '%s\n' \
          'ERROR: Could not fetch the Shopify Cloudsmith token.' \
          "" \
          'binks-pr-review is private and needs the Shopify Cloudsmith Python index.' \
          'Run dev up in a uv-based Shopify project to populate ~/.config/uv/uv.toml,' \
          'or authenticate gcloud in a normal host shell and retry.' >&2
        return 1
      fi

      cloudsmith_install_url="https://token:$token@$cloudsmith_url"
    }

    installed_version=""
    if [[ -x "$tool_bin_dir/$entrypoint" ]]; then
      installed_version="$("$tool_bin_dir/$entrypoint" --version 2>/dev/null || true)"
    fi

    # Reconcile only the Nix-pinned version. There is no timer or periodic
    # update check; changing binksPrReviewVersion is the update mechanism.
    if [[ "$installed_version" != "$package $package_version" ]]; then
      if [[ -n "''${OPENCODE_SESSION_ID:-}" ]]; then
        printf '%s\n' \
          "ERROR: $package_spec is not installed in the managed Binks environment." \
          "" \
          'Run binks-review --version once from a normal host shell after rebuilding' \
          'Home Manager, then retry from OpenCode. The OpenCode sandbox has read-only' \
          'access to the installed Binks environment and cannot install or update it.' >&2
        exit 1
      fi

      cloudsmith_install_url=""
      resolve_cloudsmith_index

      uv_environment=(
        "${coreutils}/bin/env"
        -i
        "HOME=${homeDirectory}"
        "PATH=${uvInstallPath}"
        "UV_CACHE_DIR=$uv_cache_dir"
        "UV_PYTHON_DOWNLOADS=never"
        "UV_TOOL_BIN_DIR=$uv_tool_bin_dir"
        "UV_TOOL_DIR=$uv_tool_dir"
      )
      if [[ -n "$cloudsmith_install_url" ]]; then
        uv_environment+=("UV_EXTRA_INDEX_URL=$cloudsmith_install_url")
      fi

      "''${uv_environment[@]}" "${uv}/bin/uv" tool install \
        --quiet \
        --upgrade \
        --python "${python313}/bin/python3" \
        "$package_spec"
    fi

    if [[ ! -x "$tool_bin_dir/$entrypoint" ]]; then
      printf 'binks-review: uv did not install %s\n' "$entrypoint" >&2
      exit 1
    fi

    installed_version="$("$tool_bin_dir/$entrypoint" --version 2>/dev/null || true)"
    if [[ "$installed_version" != "$package $package_version" ]]; then
      printf 'binks-review: expected %s, found %s\n' "$package_version" "''${installed_version:-unknown}" >&2
      exit 1
    fi

    if [[ "$proxy_base_hint" != *"proxy-shopify-ai.local.shop.dev"* ]]; then
      if [[ -n "$proxy_binks_key" ]]; then
        export BINKS_AI_PROXY_KEY="$proxy_binks_key"
      elif [[ -n "$proxy_shopify_key" ]]; then
        export BINKS_AI_PROXY_KEY="$proxy_shopify_key"
      elif [[ -n "$proxy_opencode_key" ]]; then
        export BINKS_AI_PROXY_KEY="$proxy_opencode_key"
      elif [[ -n "$proxy_legacy_key" ]]; then
        export BINKS_AI_PROXY_KEY="$proxy_legacy_key"
      elif [[ -n "$proxy_openai_key" ]]; then
        export BINKS_AI_PROXY_KEY="$proxy_openai_key"
      elif [[ -n "$proxy_anthropic_key" ]]; then
        export BINKS_AI_PROXY_KEY="$proxy_anthropic_key"
      else
        if ! command -v devx >/dev/null 2>&1; then
          printf 'binks-review: no AI proxy key is set and devx is unavailable\n' >&2
          exit 1
        fi
        BINKS_AI_PROXY_KEY="$(devx llm-gateway print-token --key)"
        export BINKS_AI_PROXY_KEY
      fi
    fi

    # The pinned CLI treats custom BINKS_BASE_URL values as credential-free
    # upload targets. Force the canonical production URL so clearing upload
    # credentials is a fail-closed no-upload signal.
    export BINKS_BASE_URL="$binks_production_url"
    case "$requested_upload" in
      0|"")
        ;;
      1)
        export BINKS_API_USER="''${requested_upload_user:-binks-api-upload-prod}"
        if [[ -z "$requested_upload_password" ]]; then
          upload_password=""
          if upload_password="$(gcloud storage cat gs://dev-tokens/binks/upload/latest 2>/dev/null)" \
            && [[ -n "$upload_password" ]]; then
            export BINKS_API_PASSWORD="$upload_password"
          else
            printf 'WARNING: Binks result upload is unavailable; local review will continue.\n' >&2
          fi
        else
          export BINKS_API_PASSWORD="$requested_upload_password"
        fi
        ;;
      *)
        printf 'binks-review: BINKS_REVIEW_UPLOAD must be 0 or 1\n' >&2
        exit 2
        ;;
    esac

    exec "$tool_bin_dir/$entrypoint" "$@"
  '';
}
