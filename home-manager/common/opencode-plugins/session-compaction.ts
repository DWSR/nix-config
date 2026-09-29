// Session-compaction plugin entry.
//
// Architectural invariant — see
// `.kiro/specs/session-compaction/design.md` §Components /
// SessionCompactionPlugin / Plugin File Export Constraint and
// `tasks.md` task 3.7: any file under `~/.config/opencode/plugins/`
// is loaded by opencode's user-plugin loader as a candidate plugin
// module, and the loader walks every named export of the module
// and invokes each function-shaped value with the `PluginInput`.
// Therefore this file MUST expose **exactly one** function-shaped
// named export — `SessionCompactionPlugin`. Every seam
// (SessionTokenTracker, ThresholdEvaluator, CompactionInvoker,
// SessionCompactionLogger, PluginSelfCheck, the config loader,
// the ignore set, and the hook handler
// bodies) lives in the sibling impl module
// `../session-compaction-internal/session-compaction-impl.ts`.
//
// The impl module is deployed by `session-compaction.nix` at
// `~/.config/opencode/session-compaction-internal/session-compaction-impl.ts`
// — outside the plugins scan path — so opencode never iterates
// its exports. The relative import below resolves through the
// home-manager-files Nix store layout because both files share
// the same derivation.

import type { Plugin } from "@opencode-ai/plugin"
import {
  createHooks,
  type PluginClient,
} from "../session-compaction-internal/session-compaction-impl.ts"

export const SessionCompactionPlugin: Plugin = async (ctx) => {
  // Bridge opencode's runtime client type to the impl module's
  // minimal `PluginClient` interface. The double cast through
  // `unknown` avoids `any` while expressing that the runtime SDK
  // shape and our local interface are structurally compatible but
  // nominally unrelated — `@opencode-ai/plugin` does not re-export
  // its SDK Client type.
  const client = ctx.client as unknown as PluginClient
  return createHooks(client)
}
