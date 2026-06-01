# opencode-prompts

Vendored caveman-lite compressions of opencode's bundled model-specific
system prompts. Patched into the `opencode-pinned` Nix derivation via
`postPatch` in `../misc.nix`.

## Source

Upstream baseline pinned to `anomalyco/opencode` tag `v1.15.13`, matching
the `src` and `tag` of `opencode-pinned`. Original prompts:

```
https://github.com/anomalyco/opencode/tree/v1.15.13/packages/opencode/src/session/prompt/
```

The selector in `packages/opencode/src/session/system.ts` maps
`model.api.id` to one of these 8 files. The selected prompt becomes the
first element of the `output.system: string[]` array assembled per chat
turn (followed by an environment block, agent body, skills block,
AGENTS.md, plan-mode reminder, max-steps reminder).

## Compression style

Caveman-lite, applied verbatim from
`../../home-manager/common/opencode/caveman-lite.md`:

- Keep articles and full sentences.
- Drop filler, hedging, and pleasantries.
- Preserve byte-for-byte: code blocks, inline code, file paths,
  `path:line` citations, function names, identifiers, command names,
  error strings, log lines, command output, tables, structured report
  sections.

Adapted from JuliusBrussee/caveman (MIT). Section headings and
behavioral rules are preserved against upstream. Only prose phrasing is
condensed. Examples are trimmed (one or two representative cases per
rule instead of five-plus).

## Refresh procedure on `opencode-pinned` version bump

When you bump `opencode-pinned` to `vNext` in `../misc.nix`:

1. For each of the 8 files, fetch the upstream copy at the new tag and
   diff against the vendored compressed copy:
   ```
   for name in anthropic beast codex default gemini gpt kimi trinity; do
     curl -fsSL \
       "https://raw.githubusercontent.com/anomalyco/opencode/vNext/packages/opencode/src/session/prompt/$name.txt" \
       > "/tmp/$name.upstream.txt"
     diff -u "/tmp/$name.upstream.txt" "prompts/$name.txt" || true
   done
   ```
2. For each substantive change upstream (new rule, removed rule,
   materially changed wording), apply the equivalent change to the
   vendored compressed copy.
3. Pure prose tightening upstream → no change needed.
4. Cosmetic upstream changes (typo fixes, formatting) → optional.

If upstream adds a new model-family `.txt` (the selector in
`system.ts` grows a new branch), add a vendored compressed copy AND
extend the `postPatch` `cp` list in `../misc.nix`.

If upstream renames a file, the `cp -f` in `postPatch` will fail loud
at `darwin-rebuild build`. That is the canary — update the vendored
file name to match.

## File map

```
prompts/anthropic.txt → packages/opencode/src/session/prompt/anthropic.txt   (claude-*)
prompts/beast.txt     → packages/opencode/src/session/prompt/beast.txt       (gpt-4, o1, o3)
prompts/codex.txt     → packages/opencode/src/session/prompt/codex.txt       (gpt-*codex*)
prompts/default.txt   → packages/opencode/src/session/prompt/default.txt     (fallback)
prompts/gemini.txt    → packages/opencode/src/session/prompt/gemini.txt      (gemini-*)
prompts/gpt.txt       → packages/opencode/src/session/prompt/gpt.txt         (gpt-* other)
prompts/kimi.txt      → packages/opencode/src/session/prompt/kimi.txt        (kimi)
prompts/trinity.txt   → packages/opencode/src/session/prompt/trinity.txt     (trinity)
```

Selector logic: `packages/opencode/src/session/system.ts` in the
upstream repo.

## Verification

After `darwin-rebuild switch`:

```
launchctl kickstart -k gui/$(id -u)/io.opencode.prewarm
opencode
```

Inside opencode, run a turn against the model family you compressed
and spot-check:

- Tool calls still fire correctly (read, edit, bash, grep, glob).
- Plan mode (`Esc` toggle) still injects the reminder.
- AGENTS.md is still concatenated at the end.
- Code references still use `file_path:line_number`.

Rollback: `git revert` the relevant commit, `darwin-rebuild switch`.
