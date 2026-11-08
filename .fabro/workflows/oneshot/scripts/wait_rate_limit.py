import json
import math
import os
import re
import sys
import time

STATE_PATH = os.environ.get("ONESHOT_RATE_LIMIT_STATE", ".git/oneshot-rate-limit-waits.json")
DEFAULT_WAIT_SECONDS = 300
MAX_WAIT_SECONDS = 3600
MAX_VISIT_WAIT_SECONDS = 300
HINT_PATTERN = re.compile(
    r"[\"']?(resets_in_seconds|retry_after)[\"']?\s*[:=]\s*[\"']?(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


class WaitCapExceeded(Exception):
    pass


def reset_hint_seconds(failure_reason):
    match = HINT_PATTERN.search(failure_reason)
    if not match:
        return None
    try:
        value = float(match.group(2))
    except ValueError:
        return None
    if not math.isfinite(value) or value <= 0:
        return None
    return math.ceil(value)


def wait(stage, failure_reason, state_path=STATE_PATH, sleeper=time.sleep):
    state = {}
    try:
        with open(state_path) as stream:
            state = json.load(stream)
    except FileNotFoundError:
        pass
    if not isinstance(state, dict):
        raise ValueError("rate-limit wait state must be a JSON object")

    waited = state.get(stage, 0)
    if type(waited) is not int or waited < 0:
        raise ValueError("rate-limit wait state for %s is invalid" % stage)
    if waited >= MAX_WAIT_SECONDS:
        raise WaitCapExceeded(
            "provider limit exceeds wait cap of %d seconds for %s" % (MAX_WAIT_SECONDS, stage)
        )

    hint = reset_hint_seconds(failure_reason)
    requested = DEFAULT_WAIT_SECONDS if hint is None else hint
    delay = min(requested, MAX_VISIT_WAIT_SECONDS, MAX_WAIT_SECONDS - waited)
    sleeper(delay)
    state[stage] = waited + delay
    os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
    with open(state_path, "w") as stream:
        json.dump(state, stream, sort_keys=True)
    return delay


def main(argv=None, stdin=None, state_path=STATE_PATH, sleeper=time.sleep):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in ("implement", "simplify", "review"):
        print("usage: wait_rate_limit.py implement|simplify|review", file=sys.stderr)
        return 2
    try:
        delay = wait(args[0], (stdin or sys.stdin).read(), state_path, sleeper)
    except WaitCapExceeded as error:
        reason = str(error)
        print(json.dumps({
            "outcome": "failed",
            "failure_reason": reason,
            "context_updates": {"stage_failure": reason, "failure_class": "rate_limit"},
        }))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print("cannot calculate provider rate-limit wait: %s" % error, file=sys.stderr)
        return 1
    print("oneshot rate limit: waited %d seconds for %s" % (delay, args[0]), file=sys.stderr)
    print('{"outcome":"succeeded"}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
