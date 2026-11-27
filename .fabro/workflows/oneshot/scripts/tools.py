import datetime, hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request

READY_LABEL = "fabro-ready"
RUNNING_LABEL = "fabro-running"
FAILED_LABEL = "fabro-failed"
TYPE_LABEL = "type/oneshot"
TRIAGE_LABEL = "fabro-failure-triage"
TRIAGE_TITLE_PREFIX = "[fabro-failure-triage]"
TRIAGE_BODY_MARKER = "<!-- fabro-failure-triage:"
FABRO_API_DEFAULT = "http://host.docker.internal:32276/api/v1"
ACTIVE_RUN_STATUSES = ("pending", "runnable", "initializing", "running", "blocked")
DIFF_LIMIT = 1000
MAX_SIMPLIFY_ROUNDS = 2
BASELINE_BUDGET = 480
BASELINE_TEST_TIMEOUT = 45
BASELINE_VALIDATE_TIMEOUT = 25
BASELINE_NIX_TIMEOUT = 180
BASELINE_NIX_SYSTEMS = ("x86_64-linux", "aarch64-linux")
STATE_PATH = ".git/oneshot-state.json"
ISSUE_PATH = ".git/oneshot-issue.md"
META_STATE_NAME = "oneshot-state.json"
META_ISSUE_NAME = "oneshot-issue.md"
PUBLISH_PATH = ".git/oneshot-publish.json"
FAILURE_PATH = ".git/oneshot-failure.md"
FAILURE_REASON_PATH = ".git/oneshot-failure-reason"
STAGE_FAILURE_PATH = ".git/oneshot-stage-failure.json"
REVIEW_PATH = ".git/oneshot-review.json"
RATE_LIMIT_WAIT_PATH = ".git/oneshot-rate-limit-wait.json"
RATE_LIMIT_WAIT_CAP = 3600
RATE_LIMIT_WAIT_CHUNK = 900
RATE_LIMIT_WAIT_BACKOFF = 300
REPORT_LIMIT = 60000
DETAIL_LIMIT = 1500
FAILURE_STAGES = (
    "prepare", "diagnose", "baseline", "implement", "check",
    "simplify", "review", "rework", "publish",
)
STAGE_RESULT_STAGES = ("implement", "simplify", "review")
VERDICTS = ("APPROVED", "REJECTED", "BLOCKED")
FAILURE_CLASSES = ("none", "network", "rate_limit", "baseline", "code", "environment")
CHECK_STATUSES = ("passed", "failed", "unknown", "skipped")
BASELINE_STATUSES = ("passed", "failed", "unknown", "not_recorded")
STAGE_RESULT_FIELDS = {
    "implement": ("impl_summary", "impl_files_changed", "impl_tests_run", "impl_concerns"),
    "simplify": ("impl_summary", "impl_files_changed", "impl_tests_run", "impl_concerns"),
    "review": ("review_summary", "review_mechanical", "review_findings", "review_remediation"),
}


def run(cmd, check=True, env=None):
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        sys.exit("command failed: %s\n%s" % (" ".join(cmd), r.stderr.strip()))
    return r.stdout.strip()


def run_probe(label, cmd, timeout):
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "%s probe timed out after %d seconds" % (label, timeout)
    except OSError as e:
        return "%s probe could not run: %s" % (label, e)
    if result.returncode == 0:
        return ""
    detail = (result.stderr or result.stdout).strip()
    detail = re.sub(r"(https?://)[^/@\s]+@", r"\1[redacted]@", detail)
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        detail = detail.replace(token, "[redacted]")
    return "%s probe failed: %s" % (label, detail[:600] or "exit status %d" % result.returncode)


def github_rate_limit_blocker():
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return ""
    base = os.environ.get("ONESHOT_API_BASE", "https://api.github.com").rstrip("/")
    req = urllib.request.Request(base + "/rate_limit", headers={
        "Authorization": "Bearer %s" % token,
        "Accept": "application/vnd.github+json",
        "User-Agent": "fabro-oneshot-workflow",
    })
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            limits = json.loads(response.read()).get("resources", {}).get("core", {})
    except urllib.error.HTTPError as e:
        return "GitHub rate-limit probe failed: HTTP %d" % e.code
    except (OSError, ValueError) as e:
        return "GitHub rate-limit probe failed: %s" % type(e).__name__
    if limits.get("remaining") == 0:
        return "GitHub API core rate limit exhausted (reset at %s)" % limits.get("reset", "unknown")
    return ""


def github_reachability_blocker():
    return run_probe("GitHub reachability", ["git", "ls-remote", "origin", "HEAD"], 15)


def diagnose_environment_blocker(issue_text):
    blocker = github_reachability_blocker()
    if not blocker:
        blocker = run_probe("Nix flake input reachability", ["nix", "flake", "metadata", "--json", "--no-write-lock-file", "."], 45)
    if not blocker:
        blocker = github_rate_limit_blocker()
    if not blocker and re.search(r"\bworkflow\b|\.fabro(?:/|\b)|\bfabro\b", issue_text, re.I):
        blocker = run_probe("Fabro workflow validation", ["fabro", "validate", ".fabro/workflows/oneshot/workflow.fabro"], 35)
    return blocker


def save_environment_blocker(issue_number, blocker, preflight_only=False):
    if os.path.exists(STATE_PATH):
        state = load_state()
        if state.get("issue") != issue_number:
            return "run state describes issue %s, not #%d" % (state.get("issue"), issue_number)
    else:
        state = {"issue": issue_number}
    if blocker:
        if preflight_only and not state.get("baseline_sha"):
            state["preflight_only"] = True
        state["environment_blocker"] = blocker
    else:
        state.pop("environment_blocker", None)
        state.pop("preflight_only", None)
    save_state(state)
    return blocker


def diagnose(argv):
    issue_number = parse_issue_number(argv[0] if argv else "")
    issue_text = open(ISSUE_PATH).read()
    blocker = diagnose_environment_blocker(issue_text)
    if blocker:
        original_blocker = blocker
        blocker = save_environment_blocker(issue_number, blocker, preflight_only=True) or original_blocker
        print("oneshot diagnose: blocked: %s" % blocker, file=sys.stderr)
        updates = {
            "environment_blocker": blocker,
            "stage_failure": "diagnose: environment preflight: " + blocker,
        }
    else:
        print("oneshot diagnose: network, Nix inputs, and provider preflight are healthy", file=sys.stderr)
        updates = {}
    updates["preflight_status"] = "BLOCKED" if blocker else "READY"
    print(json.dumps({"outcome": "succeeded", "context_updates": updates}))


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_state():
    if not os.path.exists(STATE_PATH):
        sys.exit("state file %s is missing; the prepare stage must run first" % STATE_PATH)
    with open(STATE_PATH) as f:
        return json.load(f)


def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=1, sort_keys=True)


def gh(method, path, body=None, expect=(200, 201, 204)):
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        sys.exit("GITHUB_TOKEN is not set; declare [run.integrations.github.permissions] on this workflow")
    base = os.environ.get("ONESHOT_API_BASE", "https://api.github.com").rstrip("/")
    req = urllib.request.Request(base + path, method=method, headers={
        "Authorization": "Bearer %s" % token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
        "User-Agent": "fabro-oneshot-workflow",
    })
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        if e.code in expect:
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, raw
        sys.exit("GitHub API %s %s failed: HTTP %s\n%s" % (method, path, e.code, raw[:1000]))


def origin_repo():
    url = subprocess.run(["git", "config", "--get", "remote.origin.url"], capture_output=True, text=True).stdout.strip()
    m = re.match(r"(?:https://github\.com/|git@github\.com:)([^/]+)/([^/]+?)(?:\.git)?/?$", url)
    if not m:
        sys.exit("cannot derive owner/repo from origin url %r" % url)
    return m.group(1), m.group(2)


def detect_trunk():
    head = run(["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], check=False)
    if head.startswith("origin/"):
        return head.split("/", 1)[1]
    out = run(["git", "remote", "show", "origin"], check=False)
    m = re.search(r"HEAD branch:\s*(\S+)", out)
    return m.group(1) if m else "main"


def parse_issue_number(value):
    m = re.search(r"/issues/(\d+)", value or "")
    if m:
        return int(m.group(1))
    if re.match(r"^#?\d+$", (value or "").strip()):
        return int(value.strip().lstrip("#"))
    sys.exit("input 'issue' must be a GitHub issue number (123), #123, or an issue URL; got %r" % value)


def write_issue_file(issue, owner, repo, labels):
    with open(ISSUE_PATH, "w") as f:
        f.write("# GitHub issue #%d: %s\n\n" % (issue["number"], (issue.get("title") or "").strip()))
        f.write("- URL: %s\n" % issue.get("html_url", ""))
        f.write("- State: %s\n" % issue.get("state"))
        f.write("- Labels: %s\n" % (", ".join(sorted(labels)) or "(none)"))
        f.write("- Repository: %s/%s\n\n" % (owner, repo))
        f.write("## Body\n\n%s\n" % (issue.get("body") or "(empty)"))


def issue_mode(title, body, labels):
    # The failure-triage workflow files investigation issues with a dedicated
    # label, title prefix, and body marker; any one of them selects the triage
    # implementation rules.
    if TRIAGE_LABEL in (labels or ()):
        return "triage"
    if re.match(r"^\s*%s" % re.escape(TRIAGE_TITLE_PREFIX), title or "", re.I):
        return "triage"
    if TRIAGE_BODY_MARKER in (body or ""):
        return "triage"
    return "standard"


def issue_fingerprint(title, body):
    canonical = json.dumps({"title": title, "body": body or ""}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def meta_branch(issue_number):
    return "oneshot-meta/issue-%d" % issue_number


def load_meta(issue_number):
    ref = "refs/heads/%s" % meta_branch(issue_number)
    out = run(["git", "ls-remote", "--heads", "origin", ref], check=False)
    sha = None
    for line in out.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and parts[1] == ref:
            sha = parts[0]
    if sha is None:
        return None, None
    run(["git", "fetch", "--quiet", "origin", ref])
    raw = run(["git", "show", "FETCH_HEAD:fingerprint.json"], check=False)
    try:
        meta = json.loads(raw)
    except ValueError:
        meta = None
    if not isinstance(meta, dict) or not isinstance(meta.get("fingerprint"), str) or not meta["fingerprint"]:
        sys.exit("fingerprint branch %s is unreadable; delete it (and branch oneshot/issue-%d if it exists) and re-dispatch" % (
            meta_branch(issue_number), issue_number))
    return meta, sha


def meta_files(issue_number, fingerprint, state, issue_text):
    files = {
        "fingerprint.json": json.dumps({
            "fingerprint": fingerprint,
            "issue": issue_number,
            "recorded_at": state.get("created_at") or now_iso(),
        }, indent=2, sort_keys=True) + "\n",
        META_STATE_NAME: json.dumps(state, indent=1, sort_keys=True) + "\n",
    }
    if issue_text is not None:
        files[META_ISSUE_NAME] = issue_text
    return files


def write_meta_commit(issue_number, files, meta_sha, message):
    index = os.path.join(".git", "oneshot-meta-index")
    blob_path = os.path.join(".git", "oneshot-meta-blob")
    if os.path.exists(index):
        os.remove(index)
    env = dict(os.environ, GIT_INDEX_FILE=index)
    try:
        for name, text in sorted(files.items()):
            with open(blob_path, "w") as f:
                f.write(text)
            blob = run(["git", "hash-object", "-w", blob_path])
            run(["git", "update-index", "--add", "--cacheinfo", "100644", blob, name], env=env)
        tree = run(["git", "write-tree"], env=env)
    finally:
        for path in (index, blob_path):
            if os.path.exists(path):
                os.remove(path)

    ident = []
    if not run(["git", "config", "user.email"], check=False):
        ident = ["-c", "user.name=Fabro", "-c", "user.email=noreply@fabro.sh"]
    tip = run(["git"] + ident + ["commit-tree", tree, "-m", message])
    ref = "refs/heads/%s" % meta_branch(issue_number)
    run(["git", "push", "--quiet", "--force-with-lease=%s:%s" % (ref, meta_sha or ""),
         "origin", "%s:%s" % (tip, ref)])
    return tip


def record_fingerprint(issue_number, fingerprint, state, issue_text, meta_sha):
    tip = write_meta_commit(
        issue_number,
        meta_files(issue_number, fingerprint, state, issue_text),
        meta_sha,
        "oneshot(#%d): record issue fingerprint" % issue_number,
    )
    print("oneshot prepare: recorded issue fingerprint %s and run state at %s (%s)" % (
        fingerprint[:12], meta_branch(issue_number), tip[:12]), file=sys.stderr)


def persist_meta_state(state, issue_text=None):
    # Best-effort refresh so a fresh sandbox can restore the run from the meta
    # branch after the local .git state is lost.
    issue_number = state.get("issue")
    fingerprint = state.get("fingerprint")
    if not issue_number or not fingerprint:
        return ""
    ref = "refs/heads/%s" % meta_branch(issue_number)
    try:
        out = run(["git", "ls-remote", "--heads", "origin", ref], check=False)
        meta_sha = ""
        for line in out.splitlines():
            parts = line.split("\t", 1)
            if len(parts) == 2 and parts[1] == ref:
                meta_sha = parts[0]
        if not meta_sha:
            return ""
        if issue_text is None and os.path.exists(ISSUE_PATH):
            with open(ISSUE_PATH) as f:
                issue_text = f.read()
        return write_meta_commit(
            issue_number,
            meta_files(issue_number, fingerprint, state, issue_text),
            meta_sha,
            "oneshot(#%d): persist run state" % issue_number,
        )
    except (SystemExit, OSError) as error:
        print("oneshot: could not persist run state to %s: %s" % (
            meta_branch(issue_number), error), file=sys.stderr)
        return ""


def restore_run_files(issue_number):
    # A fresh sandbox loses .git/oneshot-*; the meta branch keeps the state and
    # issue snapshot alongside the fingerprint so prepare can resume.
    if os.path.exists(STATE_PATH) and os.path.exists(ISSUE_PATH):
        return []
    ref = "refs/heads/%s" % meta_branch(issue_number)
    out = run(["git", "ls-remote", "--heads", "origin", ref], check=False)
    if not any(
            len(line.split("\t", 1)) == 2 and line.split("\t", 1)[1] == ref
            for line in out.splitlines()):
        return []
    run(["git", "fetch", "--quiet", "origin", ref])
    restored = []
    if not os.path.exists(STATE_PATH):
        raw = run(["git", "show", "FETCH_HEAD:%s" % META_STATE_NAME], check=False)
        if raw:
            try:
                state = json.loads(raw)
            except ValueError:
                state = None
            if not isinstance(state, dict) or state.get("issue") != issue_number:
                sys.exit("run state at %s is unreadable; start a new run instead of resuming this one" % (
                    meta_branch(issue_number)))
            with open(STATE_PATH, "w") as f:
                json.dump(state, f, indent=1, sort_keys=True)
            restored.append(STATE_PATH)
    if not os.path.exists(ISSUE_PATH):
        raw = run(["git", "show", "FETCH_HEAD:%s" % META_ISSUE_NAME], check=False)
        if raw:
            with open(ISSUE_PATH, "w") as f:
                f.write(raw + "\n")
            restored.append(ISSUE_PATH)
    if restored:
        print("oneshot prepare: restored %s from %s" % (
            ", ".join(restored), meta_branch(issue_number)), file=sys.stderr)
    return restored


def ensure_helper_script():
    # Copy the tracked helper into .git idempotently so a fresh sandbox can
    # still run the installed script after the checkpoint is restored.
    source = globals().get("__file__") or os.path.join(
        ".fabro", "workflows", "oneshot", "scripts", "tools.py")
    target = os.path.join(".git", "oneshot-scripts", "tools.py")
    if os.path.realpath(source) == os.path.realpath(target):
        return False
    if not os.path.exists(source):
        return False
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(source, target)
    return True


def label_request(method, path, body=None):
    try:
        gh(method, path, body, expect=(200, 201, 204, 404))
        return True
    except SystemExit as e:
        print("oneshot: label update %s %s failed: %s" % (method, path, e), file=sys.stderr)
        return False


def remove_labels(owner, repo, issue_number, labels):
    for label in labels:
        label_request("DELETE", "/repos/%s/%s/issues/%d/labels/%s" % (
            owner, repo, issue_number, urllib.parse.quote(label, safe="")))


def pull_request_closes_issue(body, issue_number):
    text = body or ""
    number = int(issue_number)
    keyword = r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)"
    reference = re.compile(
        r"(?i)\b%s\b[ \t]*:?[ \t]+(?:https://github\.com/[^\s/]+/[^\s/]+/issues/%d\b"
        r"|(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#%d\b)" % (keyword, number, number))
    return reference.search(text) is not None


def find_open_pull_request(owner, repo, issue_number):
    slug = "%s/%s" % (owner, repo)
    branch = "oneshot/issue-%d" % issue_number
    page = 1
    while page <= 5:
        query = urllib.parse.urlencode({"state": "open", "per_page": 100, "page": page})
        _, pulls = gh("GET", "/repos/%s/pulls?%s" % (slug, query))
        pulls = pulls or []
        for pr in pulls:
            head = pr.get("head") or {}
            head_repo = ((head.get("repo") or {}).get("full_name") or "").lower()
            if (head.get("ref") or "") == branch and (not head_repo or head_repo == slug.lower()):
                return pr, "branch"
            if pull_request_closes_issue(pr.get("body"), issue_number):
                return pr, "closes"
        if len(pulls) < 100:
            break
        page += 1
    return None, ""


def live_oneshot_runs(owner, repo, issue_number):
    base = (os.environ.get("ONESHOT_FABRO_API_BASE") or os.environ.get("FABRO_API_BASE")
            or FABRO_API_DEFAULT).rstrip("/")
    query = urllib.parse.urlencode(
        [("page[limit]", "100")] + [("status", status) for status in ACTIVE_RUN_STATUSES])
    request = urllib.request.Request(base + "/runs?" + query, headers={
        "Accept": "application/json",
        "User-Agent": "fabro-oneshot-workflow",
    })
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read() or b"{}") or {}
    except (OSError, ValueError) as e:
        print("oneshot prepare: could not check the Fabro API for duplicate runs (%s); continuing" % e,
              file=sys.stderr)
        return None
    slug = ("%s/%s" % (owner, repo)).lower()
    pattern = re.compile(r"issue\s*#?%d\b" % issue_number, re.I)
    matches = []
    for run in payload.get("data") or []:
        if ((run.get("workflow") or {}).get("slug") or "") != "oneshot":
            continue
        if (((run.get("repository") or {}).get("name") or "").lower()) != slug:
            continue
        labels = run.get("labels") or {}
        labeled = str(labels.get("issue") or labels.get("issue_number") or "").strip() if isinstance(labels, dict) else ""
        if labeled == str(issue_number) or pattern.search(run.get("goal") or ""):
            matches.append(run)
    return matches


def skip_prepare(issue_number, reason, detail=""):
    message = "oneshot prepare: skipping issue #%d (%s)" % (issue_number, reason)
    if detail:
        message += ": " + detail
    print(message, file=sys.stderr)
    print(json.dumps({"outcome": "succeeded", "context_updates": {
        "issue_number": str(issue_number),
        "skipped": "true",
        "skip_reason": reason,
    }}))


def mark_failed(issue_number, owner, repo):
    remove_labels(owner, repo, issue_number, [RUNNING_LABEL, READY_LABEL])
    label_request("POST", "/repos/%s/%s/issues/%d/labels" % (owner, repo, issue_number),
                  {"labels": [FAILED_LABEL]})


def load_json_file(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def read_stdin_text():
    stream = sys.stdin
    if stream is None:
        return ""
    try:
        if stream.isatty():
            return ""
        return stream.read().strip()
    except (OSError, ValueError):
        return ""


def parse_rate_limit_hint(reason):
    # Providers disagree on the field name and format: LiteLLM reports
    # resets_in_seconds, HTTP clients report Retry-After, and both may appear
    # as JSON, a header, or prose inside a stage failure. Prefer the longest
    # hint when several are present so a wait never stops early.
    hints = []
    for pattern in (
            r"resets?_in_seconds['\"]?\s*[:=]\s*['\"]?(-?\d+)",
            r"retry[-_ ]?after['\"]?\s*[:=]\s*['\"]?(-?\d+)"):
        for match in re.finditer(pattern, reason or "", re.I):
            value = int(match.group(1))
            if value > 0:
                hints.append(value)
    return max(hints) if hints else None


def load_rate_limit_wait():
    return load_json_file(RATE_LIMIT_WAIT_PATH)


def save_rate_limit_wait(state):
    try:
        with open(RATE_LIMIT_WAIT_PATH, "w") as f:
            json.dump(state, f, indent=1, sort_keys=True)
    except OSError as error:
        print("oneshot wait: could not save %s: %s" % (RATE_LIMIT_WAIT_PATH, error),
              file=sys.stderr)


def clear_rate_limit_wait(stage):
    state = load_rate_limit_wait()
    if stage not in state:
        return
    state.pop(stage, None)
    save_rate_limit_wait(state)


def plan_rate_limit_wait(reason, stage, state, now):
    # A visit sleeps at most one chunk so the command never approaches the
    # graph stall timeout (60m). The deadline survives visits, so a reset
    # reported as resets_in_seconds=2856 is covered across several chunks
    # even when the stage keeps failing in between.
    entry = state.get(stage) if isinstance(state.get(stage), dict) else {}
    waited = int(entry.get("waited") or 0)
    deadline = entry.get("deadline")
    try:
        deadline = float(deadline)
    except (TypeError, ValueError):
        deadline = None
    hint = parse_rate_limit_hint(reason)
    if hint is not None:
        candidate = now + hint
        # Keep the earliest live deadline. A provider that repeats the same
        # static hint must not push the reset out on every visit; a genuinely
        # extended reset is picked up from the next failure after this one
        # completes.
        if deadline is None or deadline <= now or candidate < deadline:
            deadline = candidate
    if deadline is None or deadline <= now:
        deadline = now + RATE_LIMIT_WAIT_BACKOFF
    remaining = max(0.0, deadline - now)
    budget = max(0, RATE_LIMIT_WAIT_CAP - waited)
    if remaining > budget:
        return {
            "failure": (
                "provider limit exceeds wait cap: %d seconds remain but only "
                "%d of the %d second oneshot wait budget is left" % (
                    remaining, budget, RATE_LIMIT_WAIT_CAP)),
            "sleep": 0,
            "state": state,
            "waited": waited,
        }
    sleep_for = min(remaining, RATE_LIMIT_WAIT_CHUNK)
    waited += int(round(sleep_for))
    # Keep the record after the deadline passes so a stage that is still rate
    # limited hits the explicit cap failure instead of a generic node-visit
    # limit. normalize clears it once the stage succeeds or fails otherwise.
    state[stage] = {"deadline": deadline, "waited": waited}
    return {"failure": "", "sleep": sleep_for, "state": state, "waited": waited}


def wait_rate_limit(argv, stdin=None, sleep=None):
    stage = argv[0] if argv else ""
    if stage not in STAGE_RESULT_STAGES:
        sys.exit("usage: tools.py wait <%s>" % "|".join(STAGE_RESULT_STAGES))
    if stdin is None:
        reason = read_stdin_text()
    else:
        reason = (stdin.read() or "").strip()
    plan = plan_rate_limit_wait(
        reason, stage, load_rate_limit_wait(), time.time())
    if plan["failure"]:
        print("oneshot wait: %s" % plan["failure"], file=sys.stderr)
        print(json.dumps({
            "outcome": "failed",
            "failure_reason": plan["failure"],
            "context_updates": {
                "stage_failure": plan["failure"],
                "rate_limit_wait_seconds": str(plan["waited"]),
            },
        }))
        return
    if plan["sleep"] > 0:
        (sleep or time.sleep)(plan["sleep"])
    save_rate_limit_wait(plan["state"])
    print("oneshot wait: %s waited %d seconds in total" % (
        stage, plan["waited"]), file=sys.stderr)
    print(json.dumps({"outcome": "succeeded", "context_updates": {
        "rate_limit_wait_seconds": str(plan["waited"]),
    }}))


def stage_result_error(stage, result):
    # The typed stages are validated by Fabro before they run, but a second
    # check here keeps routing deterministic if a context value is stale,
    # truncated, or double-encoded.
    if not isinstance(result, dict):
        return "expected a JSON object"
    if result.get("verdict") not in VERDICTS:
        return "invalid verdict %r; expected one of %s" % (
            result.get("verdict"), ", ".join(VERDICTS))
    if result.get("failure_class") not in FAILURE_CLASSES:
        return "invalid failure_class %r; expected one of %s" % (
            result.get("failure_class"), ", ".join(FAILURE_CLASSES))
    checks = result.get("check_results")
    if not isinstance(checks, dict):
        return "check_results must be an object"
    for name, check in checks.items():
        if not isinstance(check, dict):
            return "check_results[%r] must be an object" % name
        missing = [key for key in ("command", "status", "baseline_status", "reason")
                   if key not in check]
        if missing:
            return "check_results[%r] is missing %s" % (name, ", ".join(missing))
        if check["status"] not in CHECK_STATUSES:
            return "check_results[%r] has invalid status %r" % (name, check["status"])
        if check["baseline_status"] not in BASELINE_STATUSES:
            return "check_results[%r] has invalid baseline_status %r" % (
                name, check["baseline_status"])
        for key in ("command", "reason"):
            if not isinstance(check[key], str):
                return "check_results[%r].%s must be a string" % (name, key)
    for field in STAGE_RESULT_FIELDS[stage] + ("stage_failure",):
        if field in result and not isinstance(result[field], str):
            return "%s must be a string" % field
    return ""


def with_triage_findings(result, detail):
    # A blocked triage issue still needs its investigation published, so keep
    # the implementer's findings in the salvage reason even when the typed
    # result only carried them in impl_concerns.
    findings = str(result.get("impl_concerns") or "").strip()
    if not findings or findings in detail:
        return detail
    return ("%s\n\n%s" % (detail, findings)) if detail else findings


def normalize_stage_result(stage, result):
    updates = {
        "verdict": result["verdict"],
        "failure_class": result["failure_class"],
        # Fabro rewrites the literal context value "none" to an empty string,
        # so routing cannot test `failure_class=none` directly. Mirror the
        # success case into a value Fabro leaves untouched.
        "failure_class_ok": "true" if result["failure_class"] == "none" else "false",
    }
    for field in STAGE_RESULT_FIELDS[stage]:
        updates[field] = str(result.get(field) or "")
    if stage in ("implement", "simplify"):
        updates["impl_status"] = "READY" if result["verdict"] == "APPROVED" else "BLOCKED"
    detail = str(result.get("stage_failure") or "").strip()
    if not detail and (result["verdict"] != "APPROVED" or result["failure_class"] != "none"):
        detail = "%s: verdict %s with failure_class %s" % (
            stage, result["verdict"], result["failure_class"])
    # An empty value clears a previous round's failure so a later stage's
    # terminal failure cannot quote a stale reason.
    updates["stage_failure"] = detail
    if stage == "implement" and updates["impl_status"] == "BLOCKED":
        if load_json_file(STATE_PATH).get("issue_mode") == "triage":
            updates["stage_failure"] = with_triage_findings(result, detail)
    # The wait nodes read this flat key through stdin_source. Keep the provider
    # error (including resets_in_seconds/retry_after) for rate-limit routes, and
    # clear it otherwise so a later wait cannot quote a stale hint.
    if result["failure_class"] == "rate_limit":
        updates["failure_reason"] = updates["stage_failure"]
    else:
        updates["failure_reason"] = ""
        clear_rate_limit_wait(stage)
    return updates


def write_review_record(updates):
    record = {
        "stage": "review",
        "verdict": updates["verdict"],
        "stage_failure": updates["stage_failure"],
        "review_findings": updates["review_findings"],
        "review_remediation": updates["review_remediation"],
    }
    try:
        with open(REVIEW_PATH, "w") as f:
            json.dump(record, f, indent=1, sort_keys=True)
            f.write("\n")
    except OSError as error:
        print("normalize: could not write %s: %s" % (REVIEW_PATH, error), file=sys.stderr)


def normalize(argv):
    stage = argv[0] if argv else ""
    if stage not in STAGE_RESULT_STAGES:
        sys.exit("usage: tools.py normalize <%s>" % "|".join(STAGE_RESULT_STAGES))
    raw = read_stdin_text()
    if not raw:
        sys.exit("normalize: %s result was empty; the agent did not emit the typed result" % stage)
    try:
        result = json.loads(raw)
        # Context values are strings, so a custom-schema object can arrive
        # JSON-encoded twice.
        if isinstance(result, str):
            result = json.loads(result)
    except ValueError as error:
        sys.exit("normalize: %s result is not valid JSON: %s" % (stage, error))
    error = stage_result_error(stage, result)
    if error:
        sys.exit("normalize: %s result rejected: %s" % (stage, error))
    updates = normalize_stage_result(stage, result)
    if stage == "review":
        write_review_record(updates)
    print(json.dumps({"outcome": "succeeded", "context_updates": updates}))


def record_stage_failure(stage, detail):
    # Every scripted stage leaves its concrete error behind so the terminal
    # `fail` stage can report it even when the stage exits without printing a
    # routing JSON document.
    detail = str(detail or "").strip() or "the stage exited with a failure status"
    try:
        with open(STAGE_FAILURE_PATH, "w") as f:
            json.dump({"stage": stage, "detail": detail, "recorded_at": now_iso()},
                      f, indent=1, sort_keys=True)
            f.write("\n")
    except OSError as error:
        print("oneshot: could not record the failing stage: %s" % error, file=sys.stderr)


def load_state_for_issue(issue_number):
    if not os.path.exists(STATE_PATH):
        return {}
    try:
        with open(STATE_PATH) as f:
            state = json.load(f)
    except (OSError, ValueError):
        return {}
    if not isinstance(state, dict) or state.get("issue") != issue_number:
        return {}
    return state


def failure_stage(message, marker, review):
    # Prefer the freshest concrete signal: a scripted stage marker, then the
    # message prefix, and only then the review record, which can be stale from
    # an earlier round when a later stage fails.
    if marker.get("stage") in FAILURE_STAGES:
        return marker.get("stage")
    match = re.match(r"\s*([A-Za-z_]+)\s*:", message or "")
    if match and match.group(1).lower() in FAILURE_STAGES:
        return match.group(1).lower()
    if review.get("stage") in FAILURE_STAGES:
        return review.get("stage")
    return "unknown"


def baseline_report(state):
    results = state.get("baseline_results")
    if not isinstance(results, list) or not results:
        return "No baseline checks were recorded for this run."
    counts = {status: sum(1 for item in results if isinstance(item, dict) and item.get("status") == status)
              for status in ("passed", "failed", "unknown")}
    lines = ["%d passed, %d failed, %d unknown." % (
        counts["passed"], counts["failed"], counts["unknown"])]
    for item in results:
        if not isinstance(item, dict) or item.get("status") == "passed":
            continue
        reason = str(item.get("reason") or "").strip()
        if len(reason) > DETAIL_LIMIT:
            reason = reason[:DETAIL_LIMIT] + "..."
        lines.append("- `%s` — %s%s" % (
            str(item.get("command") or "unknown check"),
            item.get("status") or "unknown",
            (": " + reason) if reason else "",
        ))
    return "\n".join(lines)


def environment_report(state):
    blocker = str(state.get("environment_blocker") or "").strip()
    if blocker:
        return "Blocked: " + blocker
    if state.get("baseline_sha"):
        return "Healthy: network, Nix inputs, and provider preflight passed."
    return "Unknown: the preflight did not complete."


def pull_request_report(pr):
    if not pr or not pr.get("number"):
        return "No open pull request."
    return "#%s (%s)" % (pr.get("number"), "draft" if pr.get("draft") else "ready for review")


def build_failure_report(issue_number, state, stage_failure, marker, review, pr):
    # A scripted stage records the concrete error itself; its marker is current,
    # while `stage_failure` can still hold an older agent-stage value.
    marker_detail = str(marker.get("detail") or "").strip()
    detail = marker_detail or (stage_failure or "").strip()
    if not detail:
        detail = ("The failing stage did not report a reason; the run events and "
                  ".git/oneshot-state.json hold the remaining evidence.")
    stage = failure_stage(detail, marker, review)
    findings = str(review.get("review_findings") or "").strip()
    remediation = str(review.get("review_remediation") or "").strip()
    if stage != "review":
        review_text = "No review findings were recorded for this run."
    elif findings or remediation:
        review_text = "\n\n".join(part for part in (
            ("Findings:\n" + findings) if findings else "",
            ("Remediation:\n" + remediation) if remediation else "",
        ) if part)
    else:
        review_text = ("The reviewer did not write a structured record; the concrete "
                       "failure above contains its findings.")
    lines = [
        "# Oneshot failure: issue #%d" % issue_number,
        "",
        "- **Stage:** %s" % stage,
        "- **Issue:** %s" % (state.get("issue_url") or "#%d" % issue_number),
        "- **Baseline commit:** %s" % ((state.get("baseline_sha") or "")[:12] or "unknown"),
        "- **Pull request:** %s" % pull_request_report(pr),
        "",
        "## Concrete failure",
        "",
        detail,
        "",
        "## Review findings and remediation",
        "",
        review_text,
        "",
        "## Baseline status",
        "",
        baseline_report(state),
        "",
        "## Environment status",
        "",
        environment_report(state),
        "",
    ]
    report = "\n".join(lines)
    if len(report) > REPORT_LIMIT:
        report = report[:REPORT_LIMIT] + "\n\n... (truncated; see the run events)\n"
    return report, stage, detail


def write_failure_report(report, detail):
    try:
        with open(FAILURE_PATH, "w") as f:
            f.write(report)
        with open(FAILURE_REASON_PATH, "w") as f:
            f.write(detail.strip() + "\n")
    except OSError as error:
        print("oneshot failure summary: could not write %s: %s" % (FAILURE_PATH, error),
              file=sys.stderr)


def post_failure_report(owner, repo, issue_number, report, pr):
    targets = [("issue", issue_number)]
    if pr and pr.get("number"):
        targets.append(("pull request", pr["number"]))
    for label, number in targets:
        try:
            gh("POST", "/repos/%s/%s/issues/%d/comments" % (owner, repo, number), {"body": report})
            print("oneshot failure summary: posted the comment on %s #%s" % (label, number),
                  file=sys.stderr)
        except (SystemExit, OSError) as error:
            print("oneshot failure summary: could not comment on %s #%s: %s" % (
                label, number, error), file=sys.stderr)


def report_failure(issue_number, state, stage_failure, pr, owner, repo, use_marker=True):
    marker = load_json_file(STAGE_FAILURE_PATH) if use_marker else {}
    review = load_json_file(REVIEW_PATH)
    report, stage, detail = build_failure_report(
        issue_number, state, stage_failure, marker, review, pr)
    write_failure_report(report, detail)
    print("oneshot failure summary: wrote %s (stage: %s)" % (FAILURE_PATH, stage),
          file=sys.stderr)
    if owner and repo:
        post_failure_report(owner, repo, issue_number, report, pr)
    return detail


def push_failure_checkpoint(state):
    # Preserve the failed run's diff on the remote oneshot branch so the
    # checkpoint can be recovered even when the sandbox is gone.
    issue_number = state.get("issue")
    baseline = state.get("baseline_sha")
    if not issue_number or not baseline:
        return ""
    if not run(["git", "rev-parse", "--git-dir"], check=False):
        return ""
    run(["git", "add", "-A"], check=False)
    tree = run(["git", "write-tree"], check=False)
    if not tree:
        return ""
    if subprocess.run(["git", "diff", "--quiet", baseline, tree]).returncode == 0:
        return ""

    branch = "oneshot/issue-%d" % issue_number
    ref = "refs/heads/%s" % branch
    remote_sha = ""
    out = run(["git", "ls-remote", "--heads", "origin", ref], check=False)
    for line in out.splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and parts[1] == ref:
            remote_sha = parts[0]
    parent = baseline
    if remote_sha:
        run(["git", "fetch", "--quiet", "origin", ref], check=False)
        parent = run(["git", "rev-parse", "FETCH_HEAD"], check=False) or baseline

    ident = []
    if not run(["git", "config", "user.email"], check=False):
        ident = ["-c", "user.name=Fabro", "-c", "user.email=noreply@fabro.sh"]
    commit = run(["git"] + ident + ["commit-tree", tree, "-p", parent,
                  "-m", "oneshot(#%d): checkpoint a failed run" % issue_number], check=False)
    if not commit:
        return ""
    run(["git", "push", "--quiet", "--force-with-lease=%s:%s" % (ref, remote_sha),
         "origin", "%s:%s" % (commit, ref)], check=False)
    return branch


def fail(argv):
    issue_number = parse_issue_number(argv[0] if argv else "")
    stage_failure = read_stdin_text()
    state = load_state_for_issue(issue_number)
    owner = repo = ""
    pr = None
    try:
        owner, repo = origin_repo()
    except (SystemExit, OSError) as error:
        print("oneshot fail: could not resolve the repository: %s" % error, file=sys.stderr)
    if owner and repo:
        try:
            pr, _ = find_open_pull_request(owner, repo, issue_number)
        except (SystemExit, OSError) as error:
            print("oneshot fail: could not check for an open pull request: %s" % error,
                  file=sys.stderr)
        try:
            branch = push_failure_checkpoint(state)
            if branch:
                print("oneshot fail: pushed checkpoint branch %s" % branch, file=sys.stderr)
        except (SystemExit, OSError) as error:
            print("oneshot fail: could not push the checkpoint branch: %s" % error,
                  file=sys.stderr)
    detail = report_failure(issue_number, state, stage_failure, pr, owner, repo)
    try:
        os.remove(STAGE_FAILURE_PATH)
    except OSError:
        pass
    if owner and repo:
        try:
            mark_failed(issue_number, owner, repo)
            print("oneshot fail: issue #%d labelled %s for triage" % (
                issue_number, FAILED_LABEL), file=sys.stderr)
        except (SystemExit, OSError) as error:
            print("oneshot fail: could not update the issue labels: %s" % error, file=sys.stderr)
    print(detail)


def prepare(argv):
    issue_number = parse_issue_number(argv[0] if argv else "")
    ensure_helper_script()
    blocker = github_reachability_blocker()
    if blocker:
        original_blocker = blocker
        blocker = save_environment_blocker(issue_number, blocker, preflight_only=True) or original_blocker
        print("oneshot prepare: environment blocked: %s" % blocker, file=sys.stderr)
        print(json.dumps({"outcome": "succeeded", "context_updates": {
            "preflight_status": "BLOCKED",
            "environment_blocker": blocker,
            "stage_failure": "prepare: environment preflight: " + blocker,
        }}))
        return
    owner, repo = origin_repo()
    run(["git", "fetch", "--prune", "--quiet", "origin"])
    restore_run_files(issue_number)
    issue = gh("GET", "/repos/%s/%s/issues/%d" % (owner, repo, issue_number))[1]
    if issue.get("pull_request"):
        sys.exit("#%d is a pull request, not an issue" % issue_number)
    labels = set(l.get("name", "") for l in (issue.get("labels") or []))
    if issue.get("state") != "open":
        remove_labels(owner, repo, issue_number, [READY_LABEL, RUNNING_LABEL])
        skip_prepare(issue_number, "closed", "state is %s" % issue.get("state"))
        return
    title = (issue.get("title") or "").strip()
    if not title:
        sys.exit("issue #%d has an empty title" % issue_number)
    mode = issue_mode(title, issue.get("body"), labels)

    pull, pull_reason = find_open_pull_request(owner, repo, issue_number)
    if pull is not None:
        remove_labels(owner, repo, issue_number, [READY_LABEL, RUNNING_LABEL])
        detail = "open PR #%s %s" % (
            pull.get("number"),
            "tracks the oneshot branch" if pull_reason == "branch" else "closes the issue")
        skip_prepare(issue_number, "pull_request", detail)
        return

    state = None
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH) as f:
                state = json.load(f)
        except ValueError:
            state = None
    if state is not None and state.get("issue") != issue_number:
        sys.exit("state file %s describes issue %s, not #%d; start a fresh run" % (STATE_PATH, state.get("issue"), issue_number))
    if state is not None and state.get("preflight_only") is True:
        state = None

    if state is None:
        live = live_oneshot_runs(owner, repo, issue_number)
        if live is not None and len(live) > 1:
            skip_prepare(issue_number, "superseded", "%d live oneshot runs" % len(live))
            return

    fingerprint = issue_fingerprint(title, issue.get("body"))
    meta, meta_sha = load_meta(issue_number)

    if state is not None:
        if meta is None:
            sys.exit("run state for issue #%d exists but no fingerprint is recorded at %s; cannot verify it matches the current issue (start a new run instead of resuming this one)" % (
                issue_number, meta_branch(issue_number)))
        if meta.get("fingerprint") != fingerprint:
            sys.exit("issue #%d changed after this oneshot run started (fingerprint %s recorded %s, current %s); start a new run instead of resuming this one" % (
                issue_number, str(meta.get("fingerprint", ""))[:12], meta.get("recorded_at", "unknown"), fingerprint[:12]))
        if state.get("fingerprint") and state["fingerprint"] != meta.get("fingerprint"):
            sys.exit("run state for issue #%d does not match the fingerprint recorded at %s; start a new run instead of resuming this one" % (
                issue_number, meta_branch(issue_number)))
    else:
        branch = "oneshot/issue-%d" % issue_number
        if run(["git", "ls-remote", "--heads", "origin", "refs/heads/%s" % branch], check=False):
            if meta is None:
                sys.exit("branch %s exists for issue #%d but no fingerprint is recorded at %s; cannot verify the branch matches the current issue (delete the branch and its pull request to regenerate)" % (
                    branch, issue_number, meta_branch(issue_number)))
            if meta.get("fingerprint") != fingerprint:
                sys.exit("issue #%d changed after branch %s was published (fingerprint %s recorded %s, current %s); delete the branch and its pull request to regenerate" % (
                    issue_number, branch, str(meta.get("fingerprint", ""))[:12], meta.get("recorded_at", "unknown"), fingerprint[:12]))

    persist_meta = False
    if state is None or state.get("preflight_only") is True:
        missing = [l for l in (READY_LABEL, TYPE_LABEL) if l not in labels]
        if missing:
            sys.exit("issue #%d is not labelled %s (labels: %s); only correctly labelled oneshots may run" % (
                issue_number, " + ".join(missing), ", ".join(sorted(labels)) or "(none)"))
        state = {
            "issue": issue_number,
            "issue_title": title,
            "issue_url": issue.get("html_url", ""),
            "repo": "%s/%s" % (owner, repo),
            "trunk": detect_trunk(),
            "baseline_sha": run(["git", "rev-parse", "HEAD"]),
            "issue_mode": mode,
            "simplify_round": 0,
            "created_at": now_iso(),
            "fingerprint": fingerprint,
        }
        persist_meta = meta is None or meta.get("fingerprint") != fingerprint
        label_request("DELETE", "/repos/%s/%s/issues/%d/labels/%s" % (
            owner, repo, issue_number, urllib.parse.quote(FAILED_LABEL, safe="")))
        gh("POST", "/repos/%s/%s/issues/%d/labels" % (owner, repo, issue_number), {"labels": [RUNNING_LABEL]})
        gh("DELETE", "/repos/%s/%s/issues/%d/labels/%s" % (owner, repo, issue_number, urllib.parse.quote(READY_LABEL, safe="")))
    else:
        label_request("DELETE", "/repos/%s/%s/issues/%d/labels/%s" % (
            owner, repo, issue_number, urllib.parse.quote(FAILED_LABEL, safe="")))
        gh("POST", "/repos/%s/%s/issues/%d/labels" % (owner, repo, issue_number), {"labels": [RUNNING_LABEL]})

    state.pop("preflight_only", None)
    state.pop("environment_blocker", None)
    state["issue_title"] = title
    state["issue_url"] = issue.get("html_url", "")
    state["issue_mode"] = mode
    write_issue_file(issue, owner, repo, labels)
    save_state(state)
    if persist_meta:
        with open(ISSUE_PATH) as f:
            issue_text = f.read()
        record_fingerprint(issue_number, fingerprint, state, issue_text, meta_sha)

    print("oneshot prepare: issue=#%d trunk=%s baseline=%s fingerprint=%s" % (
        issue_number, state["trunk"], state["baseline_sha"][:12], fingerprint[:12]), file=sys.stderr)
    print(json.dumps({"context_updates": {
        "issue_number": str(issue_number),
        "issue_title": title,
        "trunk": state["trunk"],
        "baseline_sha": state["baseline_sha"],
        "issue_mode": mode,
    }}))


def baseline_command(command, cwd, deadline, timeout):
    label = shlex.join(command)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {"command": label, "status": "unknown", "reason": "baseline time budget exhausted"}
    env = dict(os.environ)
    env.pop("GIT_DIR", None)
    env.pop("GIT_WORK_TREE", None)
    try:
        result = subprocess.run(
            command, cwd=cwd, capture_output=True, text=True, env=env,
            timeout=min(timeout, remaining),
        )
    except OSError as e:
        return {"command": label, "status": "unknown", "reason": str(e)}
    except subprocess.TimeoutExpired:
        return {"command": label, "status": "unknown", "reason": "timed out"}

    output = (result.stderr + "\n" + result.stdout).strip()
    if result.returncode == 0:
        status, reason = "passed", "exit 0"
    elif re.search(r"could not resolve|temporary failure in name resolution|network is unreachable|connection timed out|unable to access .*could not resolve", output, re.I):
        status, reason = "unknown", "network unavailable: " + output[-1000:]
    elif command[0] == "nix" and "error:" in output.lower():
        status, reason = "unknown", "Nix flake could not be evaluated in this sandbox: " + output[-1000:]
    else:
        status = "failed"
        reason = "exit %d%s" % (result.returncode, (": " + output[-1000:]) if output else "")
    return {"command": label, "status": status, "reason": reason}


def baseline(argv):
    state = load_state()
    baseline_sha = state.get("baseline_sha")
    if not baseline_sha:
        sys.exit("state file %s has no baseline_sha; start a fresh run" % STATE_PATH)
    run(["git", "cat-file", "-e", "%s^{commit}" % baseline_sha])

    parent = run(["git", "rev-parse", "--verify", baseline_sha + "^"], check=False)
    if parent:
        diff_check = ["git", "diff", "--check", parent, baseline_sha]
    else:
        empty_tree = run(["git", "hash-object", "-t", "tree", "/dev/null"])
        diff_check = ["git", "diff", "--check", empty_tree, baseline_sha]

    workflow_paths = run([
        "git", "ls-tree", "-r", "--name-only", baseline_sha, "--", ".fabro/workflows"
    ]).splitlines()
    validations = [
        ["fabro", "validate", "--quiet", "--no-upgrade-check", path]
        for path in workflow_paths if path.endswith("/workflow.fabro")
    ]
    checks = [
        (["python3", "tests/dependency-cooldown/cooldown.test.py"], BASELINE_TEST_TIMEOUT),
        (["python3", "tests/fabro-workflows/model-fallbacks.test.py"], BASELINE_TEST_TIMEOUT),
        (diff_check, 15),
    ]
    checks.extend((command, BASELINE_VALIDATE_TIMEOUT) for command in validations)

    nix_reason = None
    if not shutil.which("nix"):
        nix_reason = "nix is not installed"
    else:
        env = dict(os.environ)
        env.pop("GIT_DIR", None)
        env.pop("GIT_WORK_TREE", None)
        try:
            evaluator = subprocess.run(
                ["nix", "eval", "--impure", "--raw", "--expr", 'builtins.currentSystem'],
                capture_output=True, text=True, env=env, timeout=15,
            )
            system = evaluator.stdout.strip()
            if evaluator.returncode or system not in BASELINE_NIX_SYSTEMS:
                detail = evaluator.stderr.strip() or system or "unsupported system"
                nix_reason = "Nix flake cannot be evaluated here: " + detail[-1000:]
        except (OSError, subprocess.TimeoutExpired) as e:
            nix_reason = "Nix evaluator unavailable: " + str(e)
    checks.append((
        ["nix", "flake", "check", "--no-build"] if nix_reason is None else None,
        BASELINE_NIX_TIMEOUT,
    ))

    deadline = time.monotonic() + BASELINE_BUDGET
    results = []
    worktree_error = ""
    remove_error = ""
    with tempfile.TemporaryDirectory(prefix="oneshot-baseline-") as temp:
        checkout = os.path.join(temp, "checkout")
        try:
            add = subprocess.run(
                ["git", "worktree", "add", "--quiet", "--detach", checkout, baseline_sha],
                capture_output=True, text=True, timeout=20,
            )
            worktree_error = add.stderr.strip() if add.returncode else ""
        except (OSError, subprocess.TimeoutExpired) as e:
            worktree_error = str(e)

        for command, timeout in checks:
            if command is None:
                results.append({
                    "command": "nix flake check --no-build",
                    "status": "unknown",
                    "reason": nix_reason or "Nix evaluation unavailable",
                })
            elif worktree_error:
                results.append({
                    "command": shlex.join(command),
                    "status": "unknown",
                    "reason": "could not create baseline worktree: " + worktree_error[-1000:],
                })
            elif command[0] in ("fabro", "nix") and not shutil.which(command[0]):
                results.append({
                    "command": shlex.join(command),
                    "status": "unknown",
                    "reason": command[0] + " is not installed",
                })
            else:
                results.append(baseline_command(command, checkout, deadline, timeout))

        if not worktree_error:
            try:
                remove = subprocess.run(
                    ["git", "worktree", "remove", "--force", checkout],
                    capture_output=True, text=True, timeout=15,
                )
                remove_error = remove.stderr.strip() if remove.returncode else ""
            except (OSError, subprocess.TimeoutExpired) as e:
                remove_error = str(e)
        if worktree_error or remove_error:
            reason = worktree_error or remove_error
            results.append({
                "command": "git worktree cleanup <baseline-worktree>",
                "status": "unknown",
                "reason": "could not clean up baseline worktree: " + reason[-1000:],
            })

    state["baseline_results"] = results
    save_state(state)
    persist_meta_state(state)
    counts = {status: sum(item["status"] == status for item in results)
              for status in ("passed", "failed", "unknown")}
    print("oneshot baseline: %d passed, %d failed, %d unknown" % (
        counts["passed"], counts["failed"], counts["unknown"]), file=sys.stderr)
    print(json.dumps({"outcome": "succeeded", "context_updates": {"baseline_status": "RECORDED"}}))


def check(argv):
    state = load_state()
    baseline = state.get("baseline_sha")
    if not baseline:
        sys.exit("state file %s has no baseline_sha; start a fresh run" % STATE_PATH)
    run(["git", "add", "-A"])
    out = run(["git", "diff", "--cached", "--numstat", baseline])
    added = deleted = files = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        files += 1
        if parts[0] == "-" or parts[1] == "-":
            continue
        added += int(parts[0])
        deleted += int(parts[1])
    lines = added + deleted
    if files == 0:
        sys.exit("no changes vs baseline %s; the implementation stage produced nothing to publish" % baseline[:12])

    state["last_diff_lines"] = lines
    state["last_diff_files"] = files

    if lines < DIFF_LIMIT:
        save_state(state)
        persist_meta_state(state)
        print("oneshot check: %d lines across %d files; under the %d-line limit" % (lines, files, DIFF_LIMIT), file=sys.stderr)
        print(json.dumps({"context_updates": {
            "over_limit": "false",
            "diff_lines": str(lines),
            "diff_files": str(files),
        }}))
        return

    round_ = int(state.get("simplify_round") or 0) + 1
    state["simplify_round"] = round_
    can_simplify = round_ <= MAX_SIMPLIFY_ROUNDS
    save_state(state)
    persist_meta_state(state)
    print("oneshot check: %d lines across %d files; over the %d-line limit (simplify round %d of %d)" % (
        lines, files, DIFF_LIMIT, round_, MAX_SIMPLIFY_ROUNDS), file=sys.stderr)
    updates = {
        "over_limit": "true",
        "can_simplify": "true" if can_simplify else "false",
        "diff_lines": str(lines),
        "diff_files": str(files),
        "simplify_round": str(round_),
    }
    if not can_simplify:
        updates["stage_failure"] = (
            "check: issue #%s still needs %d changed lines across %d files after %d simplification rounds "
            "(limit %d; a modified line counts as one addition plus one deletion): the issue is too large "
            "for a oneshot, split it and re-add the %s label" % (
                state.get("issue"), lines, files, MAX_SIMPLIFY_ROUNDS, DIFF_LIMIT, READY_LABEL))
    print(json.dumps({"context_updates": updates}))


def load_publish_meta(issue_number, state):
    title = "fix(oneshot): implement issue #%d" % issue_number
    summary = "Implements the change requested in issue #%d." % issue_number
    if os.path.exists(PUBLISH_PATH):
        try:
            with open(PUBLISH_PATH) as f:
                data = json.load(f)
            if isinstance(data, dict):
                proposed = " ".join(str(data.get("title") or "").split())
                if (len(proposed) <= 72 and re.match(
                        r"^[a-z][a-z0-9-]*(?:\([a-z0-9._/-]+\))?!?: .{1,}$", proposed)):
                    title = proposed
                proposed_summary = str(data.get("summary") or "").strip()
                if proposed_summary:
                    summary = proposed_summary
        except ValueError:
            pass
    return title, summary


def publish(argv):
    draft = False
    failure_reason = ""
    i = 0
    while i < len(argv):
        if argv[i] == "--draft":
            draft = True
        elif argv[i] == "--failure-reason" and i + 1 < len(argv):
            i += 1
            failure_reason = argv[i]
        else:
            sys.exit("usage: tools.py publish [--draft] [--failure-reason TEXT]")
        i += 1
    if draft and not failure_reason:
        failure_reason = sys.stdin.read().strip()
    if draft and not failure_reason:
        sys.exit("draft salvage requires a concrete failure reason from stage_failure")

    state = load_state()
    owner, repo = origin_repo()
    slug = "%s/%s" % (owner, repo)
    issue_number = state["issue"]
    trunk = state.get("trunk") or detect_trunk()
    branch = "oneshot/issue-%d" % issue_number
    title, summary = load_publish_meta(issue_number, state)
    baseline = state.get("baseline_sha")
    if not baseline:
        sys.exit("state file %s has no baseline_sha; cannot verify the change to publish" % STATE_PATH)

    run(["git", "add", "-A"])
    tree = run(["git", "write-tree"])
    diff_status = subprocess.run(["git", "diff", "--quiet", baseline, tree]).returncode
    if diff_status == 0:
        reason = "working tree has no changes relative to baseline %s; refusing to publish an empty commit" % baseline[:12]
        if failure_reason:
            reason = "%s; salvage reason: %s" % (reason, failure_reason)
        sys.exit(reason)
    if diff_status != 1:
        sys.exit("failed to compare the working tree with baseline %s" % baseline[:12])

    run(["git", "fetch", "--quiet", "origin", "refs/heads/%s" % trunk])
    base = run(["git", "rev-parse", "FETCH_HEAD"])
    trunk_diff = subprocess.run(["git", "diff", "--quiet", base, tree]).returncode
    if trunk_diff == 0:
        reason = "working tree has no changes relative to current trunk %s; refusing to publish an empty commit" % base[:12]
        if failure_reason:
            reason = "%s; salvage reason: %s" % (reason, failure_reason)
        sys.exit(reason)
    if trunk_diff != 1:
        sys.exit("failed to compare the working tree with current trunk %s" % base[:12])
    ident = []
    if not run(["git", "config", "user.name"], check=False) or not run(["git", "config", "user.email"], check=False):
        ident = ["-c", "user.name=Fabro", "-c", "user.email=noreply@fabro.sh"]
    commit = run(["git"] + ident + ["commit-tree", tree, "-p", base, "-m", title, "-m", summary])
    subprocess.run(["git", "fetch", "--quiet", "origin",
                    "refs/heads/%s:refs/remotes/origin/%s" % (branch, branch)], capture_output=True, text=True)
    run(["git", "push", "--quiet", "--force-with-lease", "origin",
         "%s:refs/heads/%s" % (commit, branch)])

    body = summary
    if failure_reason:
        body += "\n\n## Salvage reason\n\n%s" % failure_reason
    body += "\n\nCloses #%d\n" % issue_number

    def find_open_pr():
        query = urllib.parse.urlencode({"state": "open", "head": "%s:%s" % (owner, branch), "per_page": 100})
        _, prs = gh("GET", "/repos/%s/pulls?%s" % (slug, query))
        prs = prs or []
        if len(prs) > 1:
            sys.exit("multiple open pull requests for head %s: %s" % (branch, [p["number"] for p in prs]))
        return prs[0] if prs else None

    def set_draft(pr):
        if bool(pr.get("draft")) == draft:
            return pr
        if not pr.get("node_id"):
            sys.exit("open PR #%s is missing node_id; cannot change its draft state" % pr.get("number"))
        mutation = "convertPullRequestToDraft" if draft else "convertPullRequestToReadyForReview"
        query = 'mutation { %s(input: {pullRequestId: "%s"}) { pullRequest { isDraft } } }' % (
            mutation, pr["node_id"])
        response = gh("POST", "/graphql", {"query": query})[1]
        updated = response.get("data", {}).get(mutation, {}).get("pullRequest")
        if updated is None:
            sys.exit("GitHub did not return the updated draft state for PR #%s" % pr.get("number"))
        pr["draft"] = updated.get("isDraft", draft)
        return pr

    pr = find_open_pr()
    created_new = False
    if pr is None:
        status, created = gh("POST", "/repos/%s/pulls" % slug, {
            "title": title,
            "head": branch,
            "base": trunk,
            "draft": draft,
            "body": body,
        }, expect=(201, 422))
        if status == 422:
            pr = find_open_pr()
            if pr is None:
                sys.exit("pull request create for head %s returned 422 and no open PR exists" % branch)
        else:
            pr = created
            created_new = True
        print("oneshot publish: created PR #%s %s -> %s" % (pr.get("number"), branch, trunk), file=sys.stderr)
    else:
        print("oneshot publish: reusing PR #%s for %s" % (pr.get("number"), branch), file=sys.stderr)

    if not created_new:
        _, updated = gh("PATCH", "/repos/%s/pulls/%s" % (slug, pr["number"]), {
            "title": title,
            "body": body,
        })
        pr = set_draft(updated or pr)

    if draft:
        report_failure(issue_number, state, failure_reason, pr, owner, repo, use_marker=False)

    print(json.dumps({"context_updates": {
        "pr_number": str(pr.get("number")),
        "pr_url": pr.get("html_url", ""),
    }}))


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: tools.py <prepare|diagnose|baseline|check|normalize|wait|fail|publish> [args]")
    cmd, rest = sys.argv[1], sys.argv[2:]
    handlers = {
        "prepare": prepare,
        "diagnose": diagnose,
        "baseline": baseline,
        "check": check,
        "normalize": normalize,
        "wait": wait_rate_limit,
        "fail": fail,
        "publish": publish,
    }
    handler = handlers.get(cmd)
    if handler is None:
        sys.exit("unknown command %r" % cmd)
    try:
        handler(rest)
    except SystemExit as error:
        code = error.code
        if cmd != "fail":
            if isinstance(code, str) and code.strip():
                record_stage_failure(cmd, code)
            elif isinstance(code, int) and code != 0:
                record_stage_failure(cmd, "exit status %d" % code)
        raise
    except Exception as error:
        if cmd != "fail":
            record_stage_failure(cmd, "%s: %s" % (type(error).__name__, error))
        raise
    else:
        # A successful stage must not leave an older failure behind for a later
        # terminal failure to quote.
        if cmd != "fail" and os.path.exists(STAGE_FAILURE_PATH):
            try:
                os.remove(STAGE_FAILURE_PATH)
            except OSError:
                pass


if __name__ == "__main__":
    main()
