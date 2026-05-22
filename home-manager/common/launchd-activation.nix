{
  config,
  lib,
  ...
}:
let
  dstDir = "${config.home.homeDirectory}/Library/LaunchAgents";
in
{
  # Home Manager's upstream launchd activation script only sleeps for one
  # second after `launchctl bootout`. mcpproxy can take longer to finish a
  # graceful shutdown, and launchd rejects an immediate replacement bootstrap
  # with error 37 (`Operation already in progress`) while the old job is still
  # exiting. Override the activation DAG entry with the upstream script plus a
  # bounded post-bootout wait that polls launchd until the job disappears.
  home.activation.setupLaunchAgents = lib.mkForce (
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      # Disable errexit to ensure we process all agents even if some fail
      set +e

      waitForAgentBootout() {
        local domain="$1"
        local agentName="$2"
        local timeout=15
        local elapsed=0

        if [[ -v DRY_RUN ]]; then
          verboseEcho "Dry run: skipping wait for agent '$domain/$agentName' to unload"
          return 0
        fi

        while /bin/launchctl print "$domain/$agentName" >/dev/null 2>&1; do
          if (( elapsed >= timeout )); then
            warnEcho "Timed out waiting for agent '$domain/$agentName' to unload after ''${timeout}s"
            return 1
          fi

          verboseEcho "Waiting for agent '$domain/$agentName' to unload..."
          sleep 1
          elapsed=$((elapsed + 1))
        done

        verboseEcho "Agent '$domain/$agentName' is unloaded"
        return 0
      }

      # Stop an agent if it's running
      bootoutAgent() {
        local domain="$1"
        local agentName="$2"
        local needs_wait=1

        verboseEcho "Stopping agent '$domain/$agentName'..."
        local bootout_output
        bootout_output=$(run /bin/launchctl bootout "$domain/$agentName" 2>&1) || {
          # Only show warning if it's not the common "No such process" error
          if [[ "$bootout_output" != *"No such process"* ]]; then
            warnEcho "Failed to stop agent '$domain/$agentName': $bootout_output"
          else
            verboseEcho "Agent '$domain/$agentName' was not running"
            needs_wait=0
          fi
        }

        if (( needs_wait == 1 )); then
          waitForAgentBootout "$domain" "$agentName"
        fi
      }

      installAndBootstrapAgent() {
        local srcPath="$1"
        local dstPath="$2"
        local domain="$3"
        local agentName="$4"

        verboseEcho "Installing agent file to $dstPath"
        if ! run install -Dm444 -T "$srcPath" "$dstPath"; then
          errorEcho "Failed to install agent file for '$agentName'"
          return 1
        fi

        verboseEcho "Starting agent '$domain/$agentName'"
        local bootstrap_output
        bootstrap_output=$(run /bin/launchctl bootstrap "$domain" "$dstPath" 2>&1) || {
          local error_code=$?

          if [[ "$bootstrap_output" == *"Bootstrap failed: 5: Input/output error"* ]]; then
            errorEcho "Failed to start agent '$domain/$agentName' with I/O error (code 5)"
            errorEcho "This typically happens when the agent wasn't unloaded before attempting to bootstrap the new agent."
          else
            errorEcho "Failed to start agent '$domain/$agentName' with error: $bootstrap_output"
          fi

          return 1
        }

        verboseEcho "Successfully started agent '$domain/$agentName'"
        return 0
      }

      processAgent() {
        local srcPath="$1"
        local dstDir="$2"
        local domain="$3"

        local agentFile="''${srcPath##*/}"
        local agentName="''${agentFile%.plist}"
        local dstPath="$dstDir/$agentFile"

        # Skip if unchanged
        if cmp -s "$srcPath" "$dstPath"; then
          verboseEcho "Agent '$agentName' is already up-to-date"
          return 0
        fi

        verboseEcho "Processing agent '$agentName'"

        # Stop/Unload agent if it's already running
        if [[ -f "$dstPath" ]]; then
          bootoutAgent "$domain" "$agentName"
        fi

        installAndBootstrapAgent "$srcPath" "$dstPath" "$domain" "$agentName"
        # Note: We continue processing even if this agent fails
        return 0
      }

      removeAgent() {
        local srcPath="$1"
        local dstDir="$2"
        local newDir="$3"
        local domain="$4"

        local agentFile="''${srcPath##*/}"
        local agentName="''${agentFile%.plist}"
        local dstPath="$dstDir/$agentFile"

        if [[ -e "$newDir/$agentFile" ]]; then
          verboseEcho "Agent '$agentName' still exists in new generation, skipping cleanup"
          return 0
        fi

        if [[ ! -e "$dstPath" ]]; then
          verboseEcho "Agent file '$dstPath' already removed"
          return 0
        fi

        if ! cmp -s "$srcPath" "$dstPath"; then
          warnEcho "Skipping deletion of '$dstPath', since its contents have diverged"
          return 0
        fi

        # Stop and remove the agent
        bootoutAgent "$domain" "$agentName"

        verboseEcho "Removing agent file '$dstPath'"
        if run rm -f $VERBOSE_ARG "$dstPath"; then
          verboseEcho "Successfully removed agent file for '$agentName'"
        else
          warnEcho "Failed to remove agent file '$dstPath'"
        fi

        return 0
      }

      setupLaunchAgents() {
        local oldDir newDir dstDir domain

        newDir="$(readlink -m "$newGenPath/LaunchAgents")"
        dstDir=${lib.escapeShellArg dstDir}
        domain="gui/$UID"

        if [[ -n "''${oldGenPath:-}" ]]; then
          oldDir="$(readlink -m "$oldGenPath/LaunchAgents")"
          if [[ ! -d "$oldDir" ]]; then
            verboseEcho "No previous LaunchAgents directory found"
            oldDir=""
          fi
        else
          oldDir=""
        fi

        verboseEcho "Setting up LaunchAgents in $dstDir"
        [[ -d "$dstDir" ]] || run mkdir -p "$dstDir"

        verboseEcho "Processing new/updated LaunchAgents..."
        find -L "$newDir" -maxdepth 1 -name '*.plist' -type f | while read -r srcPath; do
          processAgent "$srcPath" "$dstDir" "$domain"
        done

        # Skip cleanup if there's no previous generation
        if [[ -z "$oldDir" || ! -d "$oldDir" ]]; then
          verboseEcho "LaunchAgents setup complete"
          return
        fi

        verboseEcho "Cleaning up removed LaunchAgents..."
        find -L "$oldDir" -maxdepth 1 -name '*.plist' -type f | while read -r srcPath; do
          removeAgent "$srcPath" "$dstDir" "$newDir" "$domain"
        done
      }

      setupLaunchAgents

      # Restore errexit
      if [[ -o errexit ]]; then
        set -e
      fi
    ''
  );
}
