/**
 * Vendored opencode plugin for cavemem.
 *
 * Source: cavemem v0.2.1 + overlays/cavemem-14-hook-payload-shape.patch
 *         (extracted from packages/installers/src/opencode.ts pluginSource()
 *         after the bug #14 fix is applied).
 *
 * Stays-in-sync with patches:
 *   - bug #14: overlays/cavemem-14-hook-payload-shape.patch (payload shape:
 *              tool_response reads output?.output ?? output?.title ?? null)
 *
 * NOTE: bugs #25 (search.alpha doc) and #39 (cwd filter) do not affect
 * this plugin's shape; they ship in the same vendored cavemem package
 * (see overlays/mcp-servers.nix) and are listed here so a future bumper
 * knows the full patch context.
 *
 * Single intentional deviation from pluginSource()'s output: the patched
 * installer would emit `spawn(NODE, [CLI, 'hook', ...])` where NODE is a
 * baked-in absolute node binary path and CLI is a baked-in absolute JS
 * entry path (both supplied by the installer's runtime InstallContext).
 * Those paths cannot be statically vendored in a Nix-managed checkout
 * (store paths vary; nothing substitutes them). Since requirement 2.3
 * puts pkgs.cavemem on PATH via home.packages, we invoke the cavemem
 * launcher directly: `spawn('cavemem', ['hook', 'run', event, ...])`.
 * The launcher (a buildNpmPackage-wrapped shim) handles node invocation
 * itself. Behavior is identical to the patched installer's output.
 *
 * On cavemem version bump: re-extract this file from the bumped+patched
 * installer's pluginSource() output. See:
 *   - .kiro/specs/cavemem-integration/design.md (CavememPackage,
 *     OpencodePlugin components; Revalidation Triggers)
 *   - overlays/cavemem-*.patch (current patch set)
 *
 * If a future cavemem version drops the `cavemem hook run <event>`
 * subcommand or changes its stdin payload contract, this plugin must
 * be re-vendored against the new pluginSource() output and the
 * Revalidation Triggers in design.md re-walked.
 */

import { spawn } from 'node:child_process';

const CLI = 'cavemem';

const callArgs = new Map();

function runHook(event, payload) {
  try {
    const child = spawn(CLI, ['hook', 'run', event, '--ide', 'opencode'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  } catch (_e) {
    // never block the IDE on a hook failure
  }
}

export const cavemem = async () => ({
  'session.created': async (input) => {
    runHook('session-start', { session_id: input?.sessionID ?? 'unknown', ide: 'opencode' });
  },
  'session.idle': async (input) => {
    runHook('stop', { session_id: input?.sessionID ?? 'unknown', ide: 'opencode' });
  },
  'tool.execute.before': async (input, output) => {
    if (input?.callID) callArgs.set(input.callID, output?.args);
  },
  'tool.execute.after': async (input, output) => {
    const args = input?.callID ? callArgs.get(input.callID) : undefined;
    if (input?.callID) callArgs.delete(input.callID);
    runHook('post-tool-use', {
      session_id: input?.sessionID ?? 'unknown',
      ide: 'opencode',
      tool_name: input?.tool ?? 'unknown',
      tool_input: args ?? null,
      tool_response: output?.output ?? output?.title ?? null,
    });
  },
});
