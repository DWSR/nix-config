# Phase 0 source fidelity decision

Date: 2026-06-03

Task: opencode-nono-audit 1.1

Scope: host/operator verification for `nono profile show opencode --json`, real OpenCode session DB field derivability, and cavemem `data.db` extraction fidelity.

## Commands run

- `nono profile show opencode --json`: failed with command-not-found, exit 127.
- `sqlite3 -readonly ~/.local/share/opencode/opencode-stable.db ...`: schema and aggregate-only field inspection.
- `sqlite3 -readonly ~/.local/share/cavemem/data.db ...`: schema, version, compression, and aggregate-only content-shape inspection.

No source database was opened writable. No raw prompts, responses, command bodies, paths, URLs, or secret-bearing payloads were copied into this artifact.

## nono profile fixture

`nono` is unavailable on this host, so there is no valid `profile show --json` grant payload to capture. The assessor fixture is `nono-profile-show-opencode.unavailable.json`, which records the skip-path evidence instead of inventing a fake successful profile output.

Decision: until a real `nono profile show opencode --json` payload is captured on a host with nono 0.5.0 installed, the Compatibility Assessor must treat grant ingestion as unavailable and emit `assessment: skipped (nono unavailable)`. It must not classify usage as compatible from an assumed grant shape.

## OpenCode DB findings

Readable source: `~/.local/share/opencode/opencode-stable.db`.

Schema shape:

- `session`, `message`, and `part` store OpenCode history.
- `part.data` is JSON text.
- `data_migration` contains `session_usage_from_messages`.

Aggregate field shape from the live DB:

- Total `part` rows inspected: 363812.
- Tool-bearing rows inspected: 121925 with `data.tool`; 20 rows also expose top-level `data.name`.
- Tool state rows expose `state.input`, `state.output`, `state.status`, `state.time`, `state.title`, and sometimes `state.error`.
- Common tool input keys include `bash.command`, `bash.description`, `bash.workdir`, `read.filePath`, `read.offset`, `read.limit`, `grep.pattern`, `grep.path`, `glob.pattern`, `glob.path`, `webfetch.url`, `webfetch.format`, `edit.filePath`, `edit.oldString`, `edit.newString`, MCP `name`, `args`, and `args_json`.

Minimum-fidelity bar for R1.2/R2.1:

- High confidence: derive a capability only from structured `part.data.state.input` fields whose key names identify the capability class directly.
- Medium confidence: derive a capability from tool-specific structured fields that need interpretation, such as MCP `args` or `args_json`, only when the enclosing tool name and nested JSON key identify the class.
- Low confidence: derive only advisory hints from free-text command parsing or cavemem text; low-confidence hints must not produce blocker findings by themselves.
- Unknown: if an observation cannot be mapped from structured evidence to a sandbox capability, classify it as `unknown`, never `compatible`.

Capability class decisions:

- `external-command`: observable at high confidence for `bash.state.input.command`; command strings require redaction before serialization.
- `filesystem-path`: observable at high confidence from structured path keys such as `filePath`, `path`, and tool-specific path arrays; path-like command substrings are low-confidence hints only.
- `network-endpoint`: observable at high confidence from structured URL keys such as `webfetch.state.input.url`; URL-like command substrings are low-confidence hints only.
- `port`: unobservable as a standalone class from the current OpenCode DB shape; infer only as low-confidence text from URLs or command strings.
- `unix-socket`: unobservable from the current OpenCode DB shape.
- `env-var`: unobservable as a standalone class from the current OpenCode DB shape; infer only as low-confidence text from command strings.
- `process-signal`, `device`, and `ipc`: unobservable from the current OpenCode DB shape.

Required `unobservableClasses` fallback for the first implementation:

```json
[
  "device",
  "env-var",
  "ipc",
  "port",
  "process-signal",
  "unix-socket"
]
```

## cavemem DB findings

Readable source: `~/.local/share/cavemem/data.db`.

Schema/version shape:

- `schema_version` contains version `2`.
- `observations(id, session_id, kind, content, compressed, intensity, ts, metadata)`.
- `sessions(id, ide, cwd, started_at, ended_at, metadata)`.
- `summaries(id, session_id, scope, content, compressed, intensity, ts)`.
- `embeddings(observation_id, model, dim, vec)`.

Aggregate content shape from the live DB:

- Observations inspected: 781.
- Observation kinds: 389 `prompt`, 392 `response`.
- Current observation rows have `compressed = 0`; no compressed observation rows were present in this DB.
- Only 12 observation rows are JSON-valid, and those are JSON string primitives rather than structured tool-call objects.
- Observation metadata contains migration/import bookkeeping keys, not tool argument fields.
- Session summaries are present with `compressed = 0` and are prose summaries.

Decision: cavemem is a best-effort secondary source for corroborating prompts, responses, and operator-visible context. It is too lossy for authoritative capability extraction because the stored content is prompt/response text and summaries rather than structured tool invocations. The audit may use cavemem to add low-confidence hints or session context, but OpenCode `part.data.state.input` remains the authoritative source for commands, paths, and URLs.

## Follow-up gate

When nono 0.5.0 becomes available, replace the unavailable fixture with a captured `nono profile show opencode --json` payload and re-check the grant parser before allowing compatibility findings to classify observations as compatible, warning, or blocker from profile grants.
