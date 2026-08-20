# Managed Pi operator guide

## Provider setup

On personal hosts, start `pi` and complete Pi-owned OpenAI authentication. The
managed default is `openai/gpt-5.6-sol` at `xhigh`.

On Shopify hosts, the launcher uses the fixed managed
`devx llm-gateway print-token --base` and
`devx llm-gateway print-token --key` resolvers to obtain the base and short-lived
token. Never persist a gateway secret or copy resolver output into Pi settings,
shell profiles, or generated files.

## Managed status

This guidance package does not install this command. The final managed launcher
will provide `pi --managed-status` only after downstream wiring is complete; it
does not start Pi. Its redacted output covers generation, Pi version, provider
mode, sandbox state, active profile, MCP endpoint and readiness, Cavemem data
directory and readiness, extension versions, LSP state, and configuration drift.

## Sandbox overrides

`PI_NONO=disabled|audit|enforced` selects the one-launch sandbox state.
`PI_NONO_PROFILE=pi-managed|pi-audit|pi-review` selects a named profile for an
enabled sandbox state. `PI_NONO_LISTEN_PORTS` accepts unique comma-separated
decimal ports from 1 through 65535, with no spaces, leading zeroes, duplicates,
or wildcards.

Use `PI_NONO=audit PI_NONO_LISTEN_PORTS=3000,8080 pi` for an audited launch with
two explicit listener grants. Use
`PI_NONO=enforced PI_NONO_PROFILE=pi-review pi` for read-only review. Do not
combine the disabled state with profile or listen-port overrides. An invalid
override stops before Pi and lists the accepted values.

## Configuration recovery

If managed launch names invalid `settings.json`, `models.json`, or
`ownership.json`, it stops before Pi. Repair only the named file or state and
preserve unrelated settings, authentication, trust, packages, providers, and
sessions. Run `pi` again; managed validation and reconciliation complete before
the TUI opens. Never delete all Pi state.

## Extension updates

To update an extension, change the Nix pin and managed generation together,
build the result, run managed validation, and then activate the generation.
There is no runtime package update path.

## Rollback

Run `PI_NONO=disabled pi` for a one-launch, reported unsandboxed fallback. This
is an explicit rollback, not a default. Disabling the module in a later Home
Manager generation removes managed artifacts while preserving mutable Pi state.

## Advisory exceptions

An advisory exception has exactly these technical fields:

- `id`: the advisory identifier.
- `rationale`: the reason the exception is accepted.
- `approver`: the approving identity.
- `expiresOn`: the expiry date in `YYYY-MM-DD` form.

An unexcepted critical or high-severity production advisory rejects the release.
Exception IDs must be unique. `piAgentAdvisoryDate` is the module-evaluation-owned
date input; a Gregorian `YYYY-MM-DD` value is mandatory when exceptions exist.
At or after `expiresOn`, evaluation fails. These are advisory-only exceptions,
not credential or provider exceptions.
