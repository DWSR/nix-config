# Research: personal-tailscale-service

## Gap Analysis

### Current State

- `configurations/personal/default.nix` installs the Mac App Store Tailscale app (`homebrew.masApps."Tailscale" = 1475387142`) and wires the personal Home Manager module at `configurations/personal/home-manager/default.nix`.
- `configurations/personal/home-manager/default.nix` imports `../../../home-manager/common`, host-specific modules, and several MCP/local service declarations. It has local HTTP services such as Beeper MCP at `http://localhost:23373/v0/mcp`, but no Tailscale Serve declaration.
- `home-manager/common/default.nix` is the import hub for reusable Home Manager modules and already imports option modules such as `git-clone-isolation.nix` and `sqlite-backup.nix`.
- `home-manager/common/sqlite-backup.nix` provides the closest rich module pattern: `types.submodule`, list/attr options, assertions, generated artifacts, and activation hooks under `home.activation.* = lib.hm.dag.entryAfter [ "writeBoundary" ]`.
- `tests/git-clone-isolation/hm-render.test.js` and `flake.nix` provide the render-test pattern: Node `node:test`, `nix eval --json --impure --expr`, copied writable source in a flake check, and host render assertions for `Brandons-MacBook-Pro`.

### External Tailscale Findings

- Tailscale documents `tailscale serve [flags] <target>` for sharing a local service within a tailnet.
- Relevant flags for this scope: `--bg`, `--https=<port>`, `--http=<port>`, `--tcp=<port>`, `--tls-terminated-tcp=<port>`, `--set-path=<path>`, and `--yes`.
- Serve targets may be a port number, partial localhost URL, or full URL such as `tcp://localhost:3000/foo` or `https+insecure://localhost:3000/foo`.
- File and directory targets are unsupported for the Mac App Store app due to macOS sandbox limitations; the docs say those modes require the open-source macOS variant.
- With `--bg`, Serve persists in the background and resumes after reboot or Tailscale restart.

### Requirement-to-Asset Map

| Requirement | Existing assets | Gap |
|-------------|-----------------|-----|
| 1 Declarative entries | HM option patterns in `home-manager/common/sqlite-backup.nix`; import hub in `home-manager/common/default.nix` | Missing Tailscale Serve HM module, option schema, validation, and rendered internal state. |
| 2 Personal host readiness | Personal host HM import stack in `configurations/personal/home-manager/default.nix`; Tailscale app install in `configurations/personal/default.nix` | Missing reusable module import; no personal entries are selected for this spec. |
| 3 Activation convergence | Activation hooks in `home-manager/common/default.nix` and `home-manager/common/sqlite-backup.nix` | Missing activation script that calls the macOS app CLI with `TAILSCALE_BE_CLI=1`, `--bg`, and noninteractive failure handling. |
| 4 Rendered verification | `tests/git-clone-isolation/hm-render.test.js`; `flake.nix` check wiring | Missing Tailscale Serve test directory and flake check. |

### Implementation Options

#### Option A: Extend personal host only

- Add activation commands directly in `configurations/personal/home-manager/default.nix`.
- Trade-offs: quickest, but no reusable option surface and weak render-test seams. Does not satisfy the reusable module scope from `brief.md`.

#### Option B: New reusable Home Manager module

- Add `home-manager/common/tailscale-serve.nix`, import it from `home-manager/common/default.nix`, and consume it from the personal Home Manager config.
- Trade-offs: clean ownership, testable option surface, aligns with existing module patterns. Requires schema design and activation rendering.

#### Option C: Hybrid module plus future launchd reapply hook

- Start with Option B and add a launchd agent that reapplies Serve state at login or interval.
- Trade-offs: improves reapply timing if activation is insufficient, but adds lifecycle complexity not required by current requirements.

### Complexity and Risk

- Effort: **M**. Existing Nix/HM patterns cover most plumbing, but Serve command modeling and activation semantics need careful validation.
- Risk: **Medium**. The feature touches local network exposure and external Tailscale CLI behavior; public exposure is explicitly excluded.

### Design Recommendations

- Prefer Option B for this spec.
- Keep the module disabled by default and dormant when `entries = [ ]`.
- Model only local reverse-proxy/TCP targets in the first schema; reject Funnel, file, directory, static text, and non-local targets at evaluation time.
- Use a configurable default CLI path of `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- Render activation commands through a script or activation block that sets `TAILSCALE_BE_CLI=1`, checks CLI existence, and applies entries with `serve --bg --yes` where compatible.
- Add internal read-only rendered state if needed to make tests assert command intent without invoking Tailscale.
- Mirror the `git-clone-isolation` render-test structure with a `tests/personal-tailscale-service/` suite and a dedicated flake check.

### Clarification

- Pre-task clarification selected module-only scope. This spec does not declare initial personal service entries; future entry selection is downstream work.

## Design Synthesis

### Generalization

- Model a generic local proxy entry rather than a service-specific Beeper, MCP, or web-app entry. The schema supports future local port and localhost URL declarations without adding Funnel, Services virtual IP, file, directory, or static text modes.

### Build vs. Adopt

- Adopt Tailscale Serve CLI semantics instead of building a daemon or launchd service. Home Manager only renders and applies declarations.
- Build a small Home Manager module because no existing repo module owns Tailscale Serve declarations.

### Simplification

- No launchd reapply hook in the first design because `tailscale serve --bg` persists Serve state and activation reapplication satisfies current requirements.
- No authoritative cleanup in the first design because `serve reset` would clear unmanaged state outside the spec boundary.

### Design Decisions

#### Decision: Reusable Home Manager module
- **Context**: Requirements need a declarative module and reusable validation before personal entries are selected.
- **Alternatives Considered**: Inline personal activation commands; reusable module; module plus launchd hook.
- **Selected Approach**: Add `home-manager/common/tailscale-serve.nix` and make it available to the personal host through the existing common import.
- **Rationale**: Matches existing module and render-test patterns while deferring host-specific service data.
- **Trade-offs**: Slightly more schema work than inline commands; better tests and boundaries.

#### Decision: Additive activation convergence
- **Context**: The spec excludes broad cleanup of unmanaged Serve state.
- **Alternatives Considered**: `tailscale serve reset` then reapply; `serve set-config`; apply declared entries only.
- **Selected Approach**: Apply declared entries only with `serve --bg --yes`.
- **Rationale**: Avoids deleting unmanaged or manually configured Serve state.
- **Trade-offs**: Removing an entry from Nix stops future reapplication but does not automatically disable the old Serve endpoint.

### Risks & Mitigations
- Tailscale CLI syntax drift — keep command rendering centralized and covered by render tests.
- Accidental public exposure — do not expose Funnel or public target options in the schema.
- Sensitive local service exposure — module-only scope exposes no services; future entries require explicit host declarations.
