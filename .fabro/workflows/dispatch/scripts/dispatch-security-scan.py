import re
import sys
import urllib.parse

SOURCES = ("dependabot", "code-scanning")  # secret scanning is never requested
SOURCE_ORDER = {"dependabot": 0, "code-scanning": 1}
PAGE_SIZE = 100
MAX_PAGES = 10
ALERT_PATHS = {
    "dependabot": "/repos/%s/dependabot/alerts",
    "code-scanning": "/repos/%s/code-scanning/alerts",
}


def alert_url(slug, source, number):
    return "https://github.com/%s/security/%s/%s" % (slug, source, number)


def alert_fields(slug, source, payload):
    number = int(payload["number"])
    url = payload.get("html_url") or alert_url(slug, source, number)
    if source == "dependabot":
        advisory = payload.get("security_advisory") or {}
        dependency = payload.get("dependency") or {}
        package = (dependency.get("package") or {}).get("name") or ""
        title = advisory.get("summary") or package or "Dependabot alert #%d" % number
        finding = {
            "source": source,
            "number": number,
            "title": str(title).strip(),
            "url": url,
        }
        if package:
            finding["package"] = package
        return finding
    rule = payload.get("rule") or {}
    instance = payload.get("most_recent_instance") or {}
    message = (instance.get("message") or {}).get("text") or ""
    title = rule.get("description") or rule.get("id") or message or "Code scanning alert #%d" % number
    return {
        "source": source,
        "number": number,
        "title": str(title).strip(),
        "url": url,
    }


def remediation_branch(source, number):
    return "security/%s-%s" % (source, int(number))


def branch_finding(ref):
    match = re.match(r"^security/([a-z-]+)-(\d+)$", ref or "")
    if not match:
        return None
    source = match.group(1)
    if source not in SOURCE_ORDER:
        return None
    return (source, int(match.group(2)))


def finding_id(source, number):
    return "%s:%s" % (source, int(number))


def package_mentioned(package, text):
    if not package or not text:
        return False
    pattern = r"(?<![A-Za-z0-9._@/-])%s(?![A-Za-z0-9._@/-])" % re.escape(package)
    return re.search(pattern, text) is not None


def next_page_path(headers):
    # Dependabot alerts use cursor pagination; the endpoint rejects `page`.
    link = (headers or {}).get("link") or (headers or {}).get("Link") or ""
    for part in link.split(","):
        if 'rel="next"' not in part:
            continue
        match = re.search(r"<([^>]+)>", part)
        if not match:
            continue
        parsed = urllib.parse.urlsplit(match.group(1))
        return parsed.path + ("?" + parsed.query if parsed.query else "")
    return None


def list_alerts(slug, source, request):
    if source not in ALERT_PATHS:
        sys.exit("dispatch scan: %s alerts could not be read: unsupported alert source" % source)
    findings = []
    path = None
    for page in range(1, MAX_PAGES + 1):
        if path is None:
            params = {"state": "open", "per_page": PAGE_SIZE}
            if source != "dependabot":
                params["page"] = page
            path = "%s?%s" % (ALERT_PATHS[source] % slug, urllib.parse.urlencode(params))
        try:
            batch, headers = request("GET", path, with_headers=True)
            findings.extend(alert_fields(slug, source, alert) for alert in batch)
        except SystemExit as exc:
            sys.exit("dispatch scan: %s alerts could not be read: %s" % (source, str(exc) or "no detail"))
        except Exception as exc:
            sys.exit("dispatch scan: %s alerts could not be read: %s" % (source, str(exc) or exc.__class__.__name__))
        if source == "dependabot":
            path = next_page_path(headers)
            if not path:
                return findings
        elif len(batch) < PAGE_SIZE:
            return findings
        else:
            path = None
    sys.exit("dispatch scan: %s alerts could not be read: more than %d open alerts over %d pages; refusing to truncate" % (
        source, PAGE_SIZE * MAX_PAGES, MAX_PAGES))


def open_pull_requests(slug, request):
    pulls = []
    for page in range(1, MAX_PAGES + 1):
        query = urllib.parse.urlencode({"state": "open", "per_page": PAGE_SIZE, "page": page})
        path = "/repos/%s/pulls?%s" % (slug, query)
        try:
            batch = request("GET", path) or []
        except SystemExit as exc:
            sys.exit("dispatch scan: open pull requests could not be read: %s" % (str(exc) or "no detail"))
        except Exception as exc:
            sys.exit("dispatch scan: open pull requests could not be read: %s" % (str(exc) or exc.__class__.__name__))
        for payload in batch:
            pulls.append({
                "number": int(payload["number"]),
                "head_ref": (payload.get("head") or {}).get("ref") or "",
                "author": (payload.get("user") or {}).get("login") or "",
                "title": payload.get("title") or "",
                "body": payload.get("body") or "",
            })
        if len(batch) < PAGE_SIZE:
            return pulls
    sys.exit("dispatch scan: open pull requests could not be read: more than %d open pull requests over %d pages; refusing to truncate" % (
        PAGE_SIZE * MAX_PAGES, MAX_PAGES))


def exclusions(findings, pulls):
    remediation_heads = set()
    for pull in pulls:
        parsed = branch_finding(pull.get("head_ref") or "")
        if parsed is not None:
            remediation_heads.add(parsed)
    dependabot_prs = [
        pull for pull in pulls
        if (pull.get("author") or "").lower() == "dependabot[bot]"
    ]
    eligible, excluded = [], []
    for finding in findings:
        reason = None
        if (finding["source"], int(finding["number"])) in remediation_heads:
            reason = "remediation_pr_open"
        elif finding["source"] == "dependabot" and finding.get("package"):
            for pull in dependabot_prs:
                text = "%s\n%s" % (pull.get("title") or "", pull.get("body") or "")
                if package_mentioned(finding["package"], text):
                    reason = "dependabot_pr_open"
                    break
        if reason:
            excluded.append({
                "source": finding["source"],
                "number": int(finding["number"]),
                "reason": reason,
            })
        else:
            eligible.append(finding)
    return eligible, excluded


def finding_sort_key(finding):
    return (SOURCE_ORDER.get(finding["source"], len(SOURCE_ORDER)), int(finding["number"]))


def select_finding(eligible):
    if not eligible:
        return None
    return sorted(eligible, key=finding_sort_key)[0]


def active_remediation_run(runs, slug):
    for run in runs or []:
        if ((run.get("workflow") or {}).get("slug") or "") != "security-remediation":
            continue
        if ((run.get("repository") or {}).get("name") or "").lower() != slug.lower():
            continue
        return run.get("id")
    return None


def scan(slug, request, runs):
    findings = []
    for source in SOURCES:
        findings.extend(list_alerts(slug, source, request))
    findings.sort(key=finding_sort_key)
    pulls = open_pull_requests(slug, request)
    eligible, excluded = exclusions(findings, pulls)
    return {
        "findings": findings,
        "remediation": {
            "active_run": active_remediation_run(runs, slug),
            "excluded": excluded,
            "eligible": [finding_id(finding["source"], finding["number"]) for finding in eligible],
            "selected": select_finding(eligible),
        },
    }
