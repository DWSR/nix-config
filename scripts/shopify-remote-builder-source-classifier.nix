{ writeShellApplication, jq }:

# The graph normalizer supplies this bounded profile shape. It deliberately
# contains only canonical fetcher names and source-policy fields; graph walking
# and network destination proof remain owned by the surrounding validator.
writeShellApplication {
  name = "shopify-remote-builder-source-classifier";
  runtimeInputs = [ jq ];
  text = ''
    set +e
    jq -csS '
      def result($decision; $profile; $reason): {
        decision: $decision,
        profile: (if $profile == "" then null else $profile end),
        reason: (if $reason == "" then null else $reason end)
      };

      def valid_hash:
        type == "string"
        and utf8bytelength == 51
        and test("^sha256-[A-Za-z0-9+/]{43}=$");

      def credential_url:
        test("^https://[^/?#]*@")
        or contains("?");

      def valid_dns_label:
        type == "string"
        and utf8bytelength >= 1
        and utf8bytelength <= 63
        and test("^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$");

      def valid_dns_hostname:
        type == "string"
        and utf8bytelength <= 253
        and (split(".") | length > 0 and all(.[]; valid_dns_label));

      def valid_ipv4_octet:
        type == "string"
        and test("^(0|[1-9][0-9]{0,2})$")
        and tonumber <= 255;

      def valid_ipv4:
        type == "string"
        and (split(".") | length == 4 and all(.[]; valid_ipv4_octet));

      def numeric_ipv4_shape:
        type == "string"
        and (split(".") | length == 4 and all(.[]; test("^[0-9]+$")));

      def valid_ipv6_piece:
        if valid_ipv4 then
          2
        elif type == "string" and test("^[0-9A-Fa-f]{1,4}$") then
          1
        else
          0
        end;

      def valid_ipv6_units:
        if . == "" then
          0
        else
          split(":") as $parts
          | if any($parts[]; . == "") then
              -1
            elif any($parts[]; valid_ipv6_piece == 0) then
              -1
            elif ([$parts[] | select(valid_ipv4)] | length) > 0
              and (($parts[-1] | valid_ipv4) | not) then
              -1
            elif ([$parts[] | select(valid_ipv4)] | length) > 1 then
              -1
            else
              [$parts[] | valid_ipv6_piece] | add
            end
        end;

      def valid_ipv6:
        type == "string"
        and (contains("%") | not)
        and (
          if contains("::") then
            (split("::") | length == 2)
            and (
              split("::") as $parts
              | ($parts[0] | valid_ipv6_units) as $left
              | ($parts[1] | valid_ipv6_units) as $right
              | $left >= 0 and $right >= 0 and ($left + $right) < 8
            )
          else
            valid_ipv6_units == 8
          end
        );

      def valid_host:
        if valid_ipv4 then
          true
        elif numeric_ipv4_shape then
          false
        else
          valid_dns_hostname or valid_ipv6
        end;

      def valid_authority:
        if startswith("[") then
          index("]") as $close
          | if $close == null or $close <= 1 then
              false
            else
              .[($close + 1):] as $suffix
              | if $suffix == "" or $suffix == ":443" then
                  (.[1:$close] | valid_ipv6)
                else
                  false
                end
            end
        else
          split(":") as $parts
          | if ($parts | length) == 1 then
              ($parts[0] | valid_host)
            elif ($parts | length) == 2 and $parts[1] == "443" then
              ($parts[0] | valid_host)
            else
              false
            end
        end;

      def valid_https_url:
        type == "string"
        and utf8bytelength <= 4096
        and startswith("https://")
        and (test("[[:space:]]") | not)
        and (contains("?") | not)
        and (contains("#") | not)
        and (.[8:] | split("/")[0] | valid_authority);

      def unknown_options($options; $allowed):
        (($options | keys) - $allowed | length) > 0;

      def classify_common_options($options; $allowed):
        if unknown_options($options; $allowed) then
          result("ineligible"; ""; "custom options")
        elif ($options | has("hooks")) and ($options.hooks | type) != "array" then
          result("ineligible"; ""; "custom hook")
        elif ($options | has("hooks")) and ($options.hooks | length) > 0 then
          result("ineligible"; ""; "custom hook")
        elif ($options | has("mirrors")) and ($options.mirrors | type) != "array" then
          result("ineligible"; ""; "mirrors")
        elif ($options | has("mirrors")) and ($options.mirrors | length) > 0 then
          result("ineligible"; ""; "mirrors")
        elif ($options | has("curlOpts")) and ($options.curlOpts | type) != "array" then
          result("ineligible"; ""; "custom options")
        elif ($options | has("curlOpts")) and ($options.curlOpts | length) > 0 then
          result("ineligible"; ""; "custom options")
        else
          null
        end;

      def classify_http($profile; $profileName; $hashMode; $allowedOptions):
        if $profile.hashMode != $hashMode then
          result("ineligible"; ""; "mutable source")
        elif ($profile | has("revision")) then
          result("ineligible"; ""; "mutable source")
        elif ($profile.options | type) != "object" then
          result("ineligible"; ""; "schema drift")
        elif $profileName == "fetchzip"
          and ($profile.options | has("stripRoot"))
          and (($profile.options.stripRoot | type) != "boolean" or $profile.options.stripRoot != true) then
          result("ineligible"; ""; "custom options")
        else
          (classify_common_options(
            $profile.options;
            (if $profileName == "fetchzip"
             then ["curlOpts", "hooks", "mirrors", "stripRoot"]
             else ["curlOpts", "hooks", "mirrors"]
             end)
          )) as $optionResult
          | if $optionResult != null then
              $optionResult
            else
              result("supported"; $profileName; "")
            end
        end;

      def classify_git($profile):
        if ($profile | has("revision") | not)
          or ($profile.revision | type != "string")
          or ($profile.revision | utf8bytelength != 40)
          or ($profile.revision | test("^[0-9A-Fa-f]{40}$") | not) then
          result("ineligible"; ""; "mutable source")
        elif $profile.hashMode != "recursive" then
          result("ineligible"; ""; "mutable source")
        elif ($profile.options | type) != "object" then
          result("ineligible"; ""; "schema drift")
        elif unknown_options(
          $profile.options;
          ["curlOpts", "gitConfig", "hooks", "lfs", "mirrors", "submodules", "tags"]
        ) then
          result("ineligible"; ""; "custom options")
        elif ($profile.options | has("submodules") | not)
          or ($profile.options | has("lfs") | not)
          or ($profile.options | has("tags") | not) then
          result("ineligible"; ""; "custom options")
        elif ($profile.options.submodules | type) != "boolean"
          or $profile.options.submodules == true then
          result("ineligible"; ""; "submodules")
        elif ($profile.options.lfs | type) != "boolean"
          or $profile.options.lfs == true then
          result("ineligible"; ""; "lfs")
        elif ($profile.options.tags | type) != "boolean"
          or $profile.options.tags == true then
          result("ineligible"; ""; "tags")
        elif ($profile.options | has("gitConfig"))
          and $profile.options.gitConfig != null then
          result("ineligible"; ""; "custom options")
        else
          (classify_common_options(
            $profile.options;
            ["curlOpts", "gitConfig", "hooks", "lfs", "mirrors", "submodules", "tags"]
          )) as $optionResult
          | if $optionResult != null then
              $optionResult
            else
              result("supported"; "fetchgit"; "")
            end
        end;

       if length != 1 then
         result("ineligible"; ""; "schema drift")
       else
         .[0] as $profile
         | if ($profile | type) != "object" then
             result("ineligible"; ""; "schema drift")
           elif (($profile | keys) - ["builder", "hash", "hashMode", "options", "revision", "schemaVersion", "urls"] | length) > 0 then
             result("ineligible"; ""; "schema drift")
           elif $profile.schemaVersion != 1 then
             result("ineligible"; ""; "schema drift")
           elif ($profile.builder | type) != "string" then
             result("ineligible"; ""; "unknown fetcher")
           elif (["fetchgit", "fetchurl", "fetchzip"] | index($profile.builder) | not) then
             result("ineligible"; ""; "unknown fetcher")
           elif ($profile.urls | type) != "array" then
             result("ineligible"; ""; "schema drift")
           elif ($profile.urls | length) == 0 then
             result("ineligible"; ""; "mutable source")
           elif ($profile.urls | length) != 1 then
             result("ineligible"; ""; "multiple sources")
           elif ($profile.urls[0] | type) != "string" then
             result("ineligible"; ""; "schema drift")
           elif ($profile.urls[0] | startswith("https://") | not) then
             result("ineligible"; ""; "local input")
           elif ($profile.urls[0] | credential_url) then
             result("ineligible"; ""; "credential syntax")
           elif ($profile.urls[0] | valid_https_url | not) then
             result("ineligible"; ""; "schema drift")
           elif ($profile.hash | valid_hash | not) then
             result("ineligible"; ""; "mutable source")
           elif $profile.builder == "fetchurl" then
             classify_http($profile; "fetchurl"; "flat"; ["curlOpts", "hooks", "mirrors"])
           elif $profile.builder == "fetchzip" then
             classify_http($profile; "fetchzip"; "recursive"; ["curlOpts", "hooks", "mirrors", "stripRoot"])
           else
             classify_git($profile)
           end
       end
    ' 2>/dev/null
    status=$?
    set -e
    if [ "$status" -ne 0 ]; then
      printf '%s\n' '{"decision":"ineligible","profile":null,"reason":"schema drift"}'
    fi
  '';
}
