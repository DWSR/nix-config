---
description: Upgrade all YugabyteDB clusters in an environment and merge the associated PR
---

# Upgrade YugabyteDB Environment

Upgrade all YugabyteDB clusters in a single environment to the version specified by the current GitHub-native PR Stack, then merge the associated inventory PR.

## Usage

```
/upgrade-environment <environment>
```

Where `<environment>` is one of: `testing`, `staging`, `production`.

## Prerequisites

- A GitHub-native PR Stack from `/upgrade-yugabyte` must already exist
- The download lookup PR (PR 1 in the stack, titled "add <version> to downloaded versions") must already be merged
- Chrome DevTools MCP must be available (for Infra Central UI interaction)
- Infra Central MCP must be available (for workflow status polling and cluster lookups)
- GitHub MCP must be available (for PR merging)
- Git-MCP must be available (for current branch and repository identification)

## Tool invocation idiom

All MCP work goes through mcpproxy's four-tool agent surface
(`retrieve_tools` + `call_tool_*`). For each upstream tool referenced
below, discover its canonical name with
`retrieve_tools(query: "<server> <operation>")` — the result's `name`
field is in `server:tool` form (e.g. `github:pull_request_stack_read`,
`github:merge_pull_request`) and the `call_with` field recommends the
verb. Invoke with the matching `call_tool_*`:

- `call_tool_read` for read-only operations (e.g. Stack and PR state queries).
- `call_tool_write` for state-mutating operations (PR merges, review writes,
  comment adds).
- `call_tool_destructive` for irreversible removals (none in this
  command).

Pass parameters in the `args` field (a JSON object), not the legacy
`arguments` field. Example:
`call_tool_read(name: "github:pull_request_stack_read", args: { method: "list", owner: "<owner>", repo: "<repo>", pullNumber: <number> })`.

## Instructions

### Step 0: Detect context and validate

1. Use Git-MCP reads with the explicit absolute repository path to identify
   the current branch and remote owner/repo. Discover a GitHub PR search/read
   tool and resolve the open PR for that branch. If no PR can be resolved, ask
   for a member PR or Stack number.

2. Discover `github:pull_request_stack_read`. Use `method: "list"` with the
   member `pullNumber`, then `method: "get"` with the returned human-facing
   Stack number. Stop if the PR is not in exactly one native Stack; do not infer
   a Stack from PR base branches.

3. Read the PR titles to find the target version. Look for a PR titled like "add <version> to downloaded versions" — extract the version from the title.

4. Identify which PR in the Stack corresponds to the `$ARGUMENTS` environment:
   - `testing` → PR titled containing "set testing clusters to"
   - `staging` → PR titled containing "set staging clusters to"
   - `production` → PR titled containing "set production clusters to"

5. Confirm by checking the PR diff — it should modify files under `tools/ansible/inventories/<environment>/`.

6. Verify PR 1 (download lookup) is already merged. If not, stop and tell the user: "PR 1 (download lookup) must be merged before upgrading any environment."

7. Extract the target version and build from the environment PR content (look for `node_yugabyte_current_version` and `node_yugabyte_current_build`).

8. **If `$ARGUMENTS` is `production`**, ask for explicit confirmation: "You are about to upgrade PRODUCTION. This includes an irreversible YSQL catalog upgrade (upgrade_ysql). Are you sure you want to proceed?"

### Step 1: Identify clusters to upgrade

1. Read `tools/ansible/inventories/<environment>/yugabyte.yml` to identify all clusters. Each cluster is defined as a group named `yugabyte_cluster_<name>` in the inventory.

2. For each cluster, look up its Infra Central cluster ID using the Infra Central MCP:
   ```sql
   SELECT id, name, environment FROM globaldb_clusters
   WHERE name = '<cluster_name>' AND environment = '<environment>'
   ```

3. Present the list of clusters to the user and confirm before proceeding.

### Step 2: (Testing only) Create a test cluster

If `$ARGUMENTS` is `testing`:

1. Navigate to `https://infra-central.shopify.io/globaldb/clusters/new` via Chrome DevTools MCP.

2. Fill in the cluster registration form:
   - **Name**: `upgrade-test-<version>` (with dots replaced by dashes, e.g., `upgrade-test-2025-2-3-0`)
   - **Environment**: `testing`
   - **TTL**: Select 1 day (86400 seconds) from the TTL dropdown

3. Submit the form to register the cluster.

4. After registration, navigate to the new cluster's Actions tab.

5. Run an initial converge to deploy the cluster with the CURRENT version:
   - Click the **"Converge"** button under Cluster Operations
   - Check the three health skip checkboxes:
     - ☑ Skip checking tablet health
     - ☑ Skip checking tserver health
     - ☑ Skip checking master health
   - Click the **"Converge"** submit button to start the workflow

6. Wait for the converge workflow to complete. Poll via Infra Central MCP if the browser times out:
   ```sql
   SELECT id, title, status FROM gordon_job_runs WHERE id = <workflow_id>
   ```

7. If the converge fails, stop and report the failure.

8. Add this cluster to the list of clusters to upgrade in Step 3.

### Step 3: For each cluster, run the upgrade sequence

Iterate through each cluster identified in Step 1 (plus the test cluster from Step 2 if testing). For each cluster:

#### Step 3a: Binary upgrade (with download retry)

**3a-i: Attempt the binary upgrade**

1. Navigate to `https://infra-central.shopify.io/globaldb/clusters/<cluster_id>?tab=actions` via Chrome DevTools.

2. Click the **"Execute Playbook"** button under Admin.

3. Fill in the form:
   - **Playbook**: `shopify.yugabyte.upgrade_minor_version`
   - **Extra vars**: Add key `target_yugabyte_version` with value `<version>`
   - The `yugabyte_cluster_name` field should be auto-filled

4. Click **Execute** to start the workflow.

5. Wait for the workflow to complete. Poll via Infra Central MCP if the browser times out:
   ```sql
   SELECT id, title, status FROM gordon_job_runs WHERE id = <workflow_id>
   ```

6. If the workflow **succeeds**:
   - **If the environment is `production`**: STOP here. Report to the user: "Binary upgrade complete for all production clusters. Auto flags promotion and YSQL catalog finalization are non-reversible and require soak time. Run these steps manually after the soak period using the Infra Central Execute Playbook UI." Proceed directly to Step 4 (merge the environment PR) without running Steps 3b or 3c.
   - **For testing and staging**: proceed to Step 3b.

**3a-ii: Handle failure — check if version not downloaded**

7. If the workflow **fails**:
   - Run the `/analyze-ansible-run <workflow_id>` command to diagnose the failure.
   - Check if the root cause is that the target version binary is not yet downloaded on the hosts.

8. If the failure IS because the version is not downloaded:
   - Report to the user: "The target version is not yet downloaded on the cluster hosts. Running a converge to download it first."
   - Navigate back to the cluster's Actions tab.
   - Click the **"Converge"** button under Cluster Operations.
   - Check the three health skip checkboxes:
     - ☑ Skip checking tablet health
     - ☑ Skip checking tserver health
     - ☑ Skip checking master health
   - Click the **"Converge"** submit button.
   - Wait for the converge workflow to complete.
   - If the converge **succeeds**: go back to Step 3a-i and **retry** the binary upgrade.
   - If the converge **fails**: report the failure and stop.

9. If the failure is NOT because the version is not downloaded:
   - Present the analysis from `/analyze-ansible-run` to the user.
   - Stop and let the user decide how to proceed.

#### Step 3b: Promote auto flags (testing and staging only)

1. Click **"Execute Playbook"** under Admin on the cluster's Actions page.

2. Fill in:
   - **Playbook**: `shopify.yugabyte.promote_minor_version_auto_flags`
   - **Extra vars**: `target_yugabyte_version=<version>`

3. Click **Execute** and wait for completion.

4. If the workflow **succeeds**, proceed to Step 3c.

5. If the workflow **fails**:
   - Run `/analyze-ansible-run <workflow_id>` to analyze the failure.
   - Present the analysis to the user.
   - Ask: "The promote auto flags playbook failed. The analysis is above. This is often a non-critical verification failure (see the analysis for details). Do you want to proceed to finalization anyway?"
   - If the user **confirms**: proceed to Step 3c.
   - If the user **declines**: stop.

#### Step 3c: Finalize upgrade (testing and staging only)

1. Click **"Execute Playbook"** under Admin on the cluster's Actions page.

2. Fill in:
   - **Playbook**: `shopify.yugabyte.finalize_minor_version_upgrade`
   - **Extra vars**: `target_yugabyte_version=<version>`

3. Click **Execute** and wait for completion.

4. If the workflow **fails**: report the failure and stop.

5. If the workflow **succeeds**: report "Cluster `<name>` upgrade to `<version>` complete."

### Step 4: Merge the environment PR

After ALL clusters in the environment have been upgraded successfully:

1. Identify the PR number for the environment's inventory PR (from Step 0).

2. Invoke `github:merge_pull_request` (via `call_tool_write`) to merge it, passing `args`:
   - **owner**: the repo owner (from the PR URL)
   - **repo**: the repo name
   - **pullNumber**: the PR number
   - **merge_method**: `squash`

3. Report the merged PR link to the user.

### Step 5: Report

Present a summary including:

- **Environment upgraded**: `<environment>`
- **Target version**: `<version>-<build>`
- **Clusters upgraded**: A table with each cluster name, workflow IDs for each step (binary upgrade, promote, finalize), and final status
- **Converge workflows** (if any were needed for downloading the version)
- **PR merged**: Link to the merged inventory PR
- **Next steps**:
  - If testing: "Upgrade staging next with `/upgrade-environment staging`"
  - If staging: "Upgrade production next with `/upgrade-environment production`"
  - If production: "Binary upgrade complete. After the soak period, manually run promote auto flags and finalize upgrade via Infra Central Execute Playbook. Once complete, merge the remaining PRs in the stack (set as default version, remove old version)."

## Notes

- This command must be run from within the `globaldb-yugabyte` repository so that the `/analyze-ansible-run` command is available for failure analysis.
- The converge operation uses the dedicated "Converge" button (with health check skip checkboxes), NOT the "Execute Playbook" form. This is because the Converge button is purpose-built for this operation.
- The upgrade/promote/finalize operations use the "Execute Playbook" form under Admin because they are custom playbooks.
- Workflow status can be polled via Infra Central MCP as a fallback when Chrome DevTools browser connections time out during long-running workflows.
- The promote auto flags playbook has a known overly strict verification at line 167 that fails when auto flags are already at the target version. The finalize playbook independently verifies auto flags before proceeding, so it is safe to proceed past this failure after analysis.
