#!/usr/bin/env node
/*
 * opencode-cost-report.js — diagnostic CLI entry point for the
 * opencode session cost-attribution report.
 *
 * Task 1.3 of .kiro/specs/opencode-cost-diagnosis. Foundation stub
 * only: parses `--help` and exits, nothing more. The real CLI surface
 * (read-only SQLite access to opencode's session DB, tiktoken-based
 * proportional attribution, Markdown + JSON report emission, the
 * `--last` / `--session` / `--cwd` / `--include-content` / `--format`
 * / `--output` flag set) is implemented by tasks 2.x–5.x — those
 * tasks will replace this stub's body. The stub deliberately does
 * NOT `require('better-sqlite3')` or `require('tiktoken')` yet; the
 * NODE_PATH wiring proven by this task is exercised by subsequent
 * tasks that organically need those imports.
 *
 * Invoked from `scripts/opencode-cost-report.nix`, which is a
 * `writeShellApplication` that sets NODE_PATH to the vendored deps
 * tree produced by `pkgs.opencode-cost-diagnosis-deps`
 * (overlays/mcp-servers.nix) and execs `node` against this file.
 *
 * Design references:
 *   - design.md Technology Stack lines 187-188 (writeShellApplication
 *     wrapper around a Node entry point)
 *   - design.md File Structure Plan lines 200-211 (this file +
 *     `scripts/opencode-cost-report.nix`)
 *   - requirements.md Requirement 1, AC 1.4 and 1.5 (no imperative
 *     install / declarative installer on PATH)
 */

const args = process.argv.slice(2);

const usage = [
  "opencode-cost-report — per-component cost-attribution report for opencode sessions",
  "",
  "USAGE:",
  "  opencode-cost-report --help",
  "",
  "STATUS:",
  "  Stub (Task 1.3 of the opencode-cost-diagnosis spec). The full CLI",
  "  surface — --last, --session, --cwd, --include-content, --format,",
  "  --output — is implemented by tasks 2.x-5.x of the same spec.",
  "",
].join("\n");

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(usage);
  process.exit(0);
}

// No args, or unknown args: print usage to stderr and exit non-zero.
// Full argv hygiene (the dedicated Argument Parser) lands in Task 5.1.
process.stderr.write(usage);
process.exit(1);
