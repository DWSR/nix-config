"""Name the dispatch stage and failure that ended a dispatch run.

Every command stage calls ``begin(stage_label)`` before doing any work. The
helper records the active stage and replaces ``sys.exit`` and the uncaught
exception hook so a failing stage also records the underlying error. The
``fail`` node then reads both files and prints one line naming the stage, the
error, and the on-disk dispatch artifacts a human can inspect.
"""

import json
import sys
import traceback


STAGE_PATH = ".git/dispatch-failed-stage"
FAILURE_PATH = ".git/dispatch-failure.json"
ARTIFACTS = ".git/dispatch-queue.json, .git/dispatch-plan.json, .git/dispatch-result.json, .git/dispatch-archive.json"

_STAGE = ""
_ORIGINAL_EXIT = sys.exit


def _normalize(value):
    return " ".join(str(value or "").split())


def _write(path, payload):
    try:
        with open(path, "w") as handle:
            json.dump(payload, handle, indent=1, sort_keys=True)
    except OSError:
        pass


def record(stage, error):
    """Record the active stage and the error that ended it."""
    _write(FAILURE_PATH, {"stage": _normalize(stage), "error": _normalize(error)})


def report(error):
    """Record ``error`` against the stage started by :func:`begin`."""
    record(_STAGE, error)


def begin(stage):
    """Mark ``stage`` as active and record any later exit or exception."""
    global _STAGE
    _STAGE = _normalize(stage)
    try:
        with open(STAGE_PATH, "w") as handle:
            handle.write(_STAGE)
    except OSError:
        pass
    record(_STAGE, "")

    def exit_hook(code=0):
        if code not in (0, None, ""):
            recorded_stage, recorded_error = _read_recorded()
            if not (recorded_stage == _STAGE and recorded_error):
                record(_STAGE, code if isinstance(code, str) else "exit status %s" % code)
        _ORIGINAL_EXIT(code)

    def exception_hook(kind, exc, tb):
        record(_STAGE, "%s: %s" % (kind.__name__, exc))
        traceback.print_exception(kind, exc, tb, file=sys.stderr)

    sys.exit = exit_hook
    sys.excepthook = exception_hook


def _read_stage():
    try:
        with open(STAGE_PATH) as handle:
            return _normalize(handle.read())
    except OSError:
        return ""


def _read_recorded():
    try:
        with open(FAILURE_PATH) as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return "", ""
    if not isinstance(payload, dict):
        return "", ""
    return _normalize(payload.get("stage")), _normalize(payload.get("error"))


def failure_message(stage, detail):
    stage = _normalize(stage)
    detail = _normalize(detail)
    if stage and detail:
        return "%s failed: %s" % (stage, detail)
    if stage:
        return "%s failed; inspect the failing stage output in the run events and %s" % (stage, ARTIFACTS)
    if detail:
        return (
            "the failing dispatch stage did not report itself (for example sandbox setup): %s"
            % detail
        )
    return (
        "the failing dispatch stage did not report itself (for example sandbox setup); "
        "inspect the failing stage output in the run events and %s" % ARTIFACTS
    )


def fail(argv):
    recorded_stage, recorded_error = _read_recorded()
    stage = " ".join(argv).strip() or _read_stage() or recorded_stage
    recorded = recorded_error if stage == recorded_stage else ""
    detail = sys.stdin.read() if not sys.stdin.isatty() else ""
    print("dispatch: %s" % failure_message(stage, detail or recorded), file=sys.stderr)
    sys.exit(1)


COMMANDS = {"fail": fail}


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    handler = COMMANDS.get(command)
    if handler is None:
        sys.exit("usage: dispatch_stage.py <%s> [stage]" % "|".join(sorted(COMMANDS)))
    handler(sys.argv[2:])


if __name__ == "__main__":
    main()
