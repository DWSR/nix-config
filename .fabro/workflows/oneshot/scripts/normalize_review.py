import json, sys

VERDICTS = {"APPROVED", "REJECTED", "BLOCKED"}
FAILURE_CLASSES = {"none", "network", "rate_limit", "baseline", "code", "environment"}
CHECK_FIELDS = {"command", "status", "baseline_status", "reason"}


def main():
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        sys.exit("oneshot: typed stage output must be a JSON object")

    for field in ("verdict", "failure_class", "check_results"):
        if field not in payload:
            sys.exit("oneshot: typed stage output is missing %s" % field)
    if not isinstance(payload["verdict"], str) or payload["verdict"] not in VERDICTS:
        sys.exit("oneshot: typed stage output has an invalid verdict")
    if not isinstance(payload["failure_class"], str) or payload["failure_class"] not in FAILURE_CLASSES:
        sys.exit("oneshot: typed stage output has an invalid failure_class")
    checks = payload["check_results"]
    if not isinstance(checks, dict) or not checks or any(
        not isinstance(check, dict) or set(check) != CHECK_FIELDS
        or any(not isinstance(check[field], str) for field in CHECK_FIELDS)
        for check in checks.values()
    ):
        sys.exit("oneshot: typed stage output has invalid check_results")

    updates = payload.get("context_updates")
    if not isinstance(updates, dict):
        sys.exit("oneshot: typed stage output context_updates must be an object")
    outcome = payload.get("outcome")
    verdict = payload["verdict"]
    failure_class = payload["failure_class"]
    if outcome not in ("succeeded", "failed"):
        sys.exit("oneshot: typed stage output has an invalid outcome")
    if outcome == "succeeded" and (verdict != "APPROVED" or failure_class != "none"):
        sys.exit("oneshot: successful stage output must be APPROVED with failure_class none")
    if outcome == "failed" and (verdict == "APPROVED" or failure_class == "none"):
        sys.exit("oneshot: failed stage output has inconsistent verdict and failure_class")
    if outcome == "failed" and verdict == "REJECTED" and failure_class != "code":
        sys.exit("oneshot: rejected stage output must use failure_class code")
    if outcome == "failed" and verdict == "BLOCKED" and failure_class not in {"network", "rate_limit", "baseline", "environment"}:
        sys.exit("oneshot: blocked stage output has an invalid environmental failure_class")

    if "impl_status" in updates and updates["impl_status"] not in {"READY", "BLOCKED"}:
        sys.exit("oneshot: typed stage output has an invalid impl_status")
    if "impl_status" in updates and ((outcome == "succeeded") != (updates["impl_status"] == "READY")):
        sys.exit("oneshot: impl_status does not match stage outcome")
    if outcome == "failed":
        reason = payload.get("failure_reason")
        if not isinstance(reason, str) or not reason.strip():
            sys.exit("oneshot: failed stage output must include failure_reason")
        updates.setdefault("stage_failure", reason)
        if not isinstance(updates.get("stage_failure"), str) or not updates["stage_failure"].strip():
            sys.exit("oneshot: failed stage output must include context_updates.stage_failure")

    updates["verdict"] = verdict
    updates["failure_class"] = failure_class
    result = {"outcome": outcome, "context_updates": updates}
    if outcome == "failed":
        result["failure_reason"] = payload["failure_reason"]
    print(json.dumps(result))


if __name__ == "__main__":
    main()
