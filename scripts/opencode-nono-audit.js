/*
 * scripts/opencode-nono-audit.js — entry point for the
 * opencode-nono-audit CLI (opencode-nono-audit spec, Task 1.2,
 * Requirement 1.1).
 *
 * This is the SCAFFOLD stub. It supports the two short-circuit flags
 * required by the observable completion (`--help`, `--version`) and a
 * `require.main === module` script-vs-module guard so the file is
 * cleanly `require()`-able by the node:test suite without triggering
 * CLI side effects. Subsequent tasks fill in the audit / assess /
 * review business logic; there is intentionally none here yet.
 *
 * The `.nix` wrapper (scripts/opencode-nono-audit.nix) execs this
 * file via the repo nodejs, exporting NODE_PATH against the vendored
 * `opencode-cost-diagnosis-deps` tree and OPENCODE_NONO_COST_REPORT_LIB
 * pointing at the sibling cost-report library. Those env vars are not
 * consumed by this stub yet — the later audit task does
 * `require(process.env.OPENCODE_NONO_COST_REPORT_LIB)` for SqliteReader.
 */
'use strict';

const VERSION = '0.0.0';

const USAGE = `opencode-nono-audit — read-only OpenCode tool-usage audit

Usage:
  opencode-nono-audit [options]

Options:
  -h, --help       Print this usage text and exit.
  -v, --version    Print the version and exit.
`;

/**
 * CLI entry point.
 *
 * @param {string[]} argv - Arguments after `node script.js` (i.e.
 *   `process.argv.slice(2)`).
 * @returns {number} Process exit code.
 */
function main(argv) {
  const args = Array.isArray(argv) ? argv : [];

  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // No business logic yet (scaffold). Print usage to stderr and signal
  // "not implemented" so an accidental bare invocation is obvious
  // rather than silently succeeding.
  process.stderr.write(USAGE);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, VERSION, USAGE };
