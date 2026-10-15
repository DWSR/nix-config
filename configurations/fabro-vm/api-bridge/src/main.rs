//! fabro-api-bridge: exposes the loopback-only Fabro API to workflow
//! sandboxes on the podman bridge without putting a Fabro credential in
//! any sandbox environment.
//!
//! The bridge binds one address on the podman bridge (`10.88.0.1:32276`
//! by default; the host is reachable from containers as
//! `host.docker.internal`). Every request is authorized by *container
//! identity*: the source address is resolved to the caller's sandbox
//! container through the podman API, the container's `petri.run` label
//! names the calling run, and that run's metadata decides whether the
//! request may proceed:
//!
//!   * the caller run's workflow slug must be in `ALLOWED_WORKFLOW_SLUGS`
//!     and the run must be `running`;
//!   * only `POST /api/v1/runs` and `POST /api/v1/runs/{id}/start` are
//!     forwarded; everything else is refused;
//!   * on create, a missing `parent_id` is filled in with the calling run
//!     (a conflicting parent is refused), the target repository must match
//!     the calling run's repository, and the workflow version must be one
//!     of the pinned dispatch targets (`ALLOWED_VERSION_VARIABLES`);
//!   * on start, only children of the calling run may be started, and a
//!     child that lands in pre-execution approval is approved transparently
//!     before the response is returned.
//!
//! The Fabro dev token is read from the process environment (systemd
//! EnvironmentFile) and only ever travels on the loopback upstream call.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::process::exit;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_UPSTREAM_BYTES: usize = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);
const VERSIONS_CACHE_TTL: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

struct Config {
    listen: String,
    /// TCP host:port of the Fabro server, e.g. `127.0.0.1:32276`.
    api_hostport: String,
    /// Path prefix of the Fabro API, e.g. `/api/v1`.
    api_prefix: String,
    podman_socket: String,
    dev_token: String,
    allowed_slugs: Vec<String>,
    allowed_version_vars: Vec<String>,
}

impl Config {
    fn from_env() -> Result<Config, String> {
        let dev_token =
            env::var("FABRO_DEV_TOKEN").map_err(|_| "FABRO_DEV_TOKEN is not set".to_string())?;
        if dev_token.trim().is_empty() {
            return Err("FABRO_DEV_TOKEN is empty".to_string());
        }
        let base =
            env::var("FABRO_API_BASE").unwrap_or_else(|_| "http://127.0.0.1:32276/api/v1".into());
        let rest = base
            .strip_prefix("http://")
            .ok_or_else(|| format!("FABRO_API_BASE must be an http:// URL, got {base:?}"))?;
        let (api_hostport, api_prefix) = match rest.split_once('/') {
            Some((host, prefix)) => (host.to_string(), format!("/{}", prefix.trim_end_matches('/'))),
            None => (rest.to_string(), String::new()),
        };
        if api_hostport.is_empty() {
            return Err(format!("FABRO_API_BASE has no host: {base:?}"));
        }

        let split_list = |value: String| -> Vec<String> {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        };

        let allowed_slugs = split_list(
            env::var("ALLOWED_WORKFLOW_SLUGS").unwrap_or_else(|_| "dispatch".into()),
        );
        if allowed_slugs.is_empty() {
            return Err("ALLOWED_WORKFLOW_SLUGS resolves to an empty list".to_string());
        }
        let allowed_version_vars = split_list(
            env::var("ALLOWED_VERSION_VARIABLES")
                .unwrap_or_else(|_| "kiro_spec_workflow_version,oneshot_workflow_version".into()),
        );
        if allowed_version_vars.is_empty() {
            return Err(
                "ALLOWED_VERSION_VARIABLES resolves to an empty list; refusing to run without \
                 a workflow-version allowlist"
                    .to_string(),
            );
        }

        Ok(Config {
            listen: env::var("BRIDGE_LISTEN").unwrap_or_else(|_| "10.88.0.1:32276".into()),
            api_hostport,
            api_prefix,
            podman_socket: env::var("PODMAN_SOCKET")
                .unwrap_or_else(|_| "/run/podman/podman.sock".into()),
            dev_token,
            allowed_slugs,
            allowed_version_vars,
        })
    }

    fn api_path(&self, path: &str) -> String {
        format!("{}{}", self.api_prefix, path)
    }
}

struct VersionCache {
    fetched: Option<Instant>,
    values: HashSet<String>,
}

impl VersionCache {
    fn new() -> VersionCache {
        VersionCache {
            fetched: None,
            values: HashSet::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

struct IncomingRequest {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<IncomingRequest, String> {
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|e| format!("cannot set read timeout: {e}"))?;

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > MAX_HEADER_BYTES {
            return Err("request header too large".to_string());
        }
        let read = stream
            .read(&mut chunk)
            .map_err(|e| format!("reading request: {e}"))?;
        if read == 0 {
            return Err("connection closed before request headers".to_string());
        }
        buf.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or("missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing request method")?.to_string();
    let target = parts.next().ok_or("missing request target")?.to_string();
    let path = target.split('?').next().unwrap_or("").to_string();

    let mut content_length: usize = 0;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value
                    .trim()
                    .parse()
                    .map_err(|_| "invalid content-length".to_string())?;
            }
        }
    }
    if content_length > MAX_BODY_BYTES {
        return Err("request body too large".to_string());
    }

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let read = stream
            .read(&mut chunk)
            .map_err(|e| format!("reading request body: {e}"))?;
        if read == 0 {
            return Err("connection closed before request body".to_string());
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(IncomingRequest { method, path, body })
}

fn respond(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        reason_for(status),
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn respond_json(stream: &mut TcpStream, status: u16, value: &Value) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    respond(stream, status, "application/json", &body);
}

fn reason_for(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Unknown",
    }
}

enum Upstream<'a> {
    Tcp(&'a str),
    Unix(&'a str),
}

#[derive(Debug)]
struct UpstreamResponse {
    status: u16,
    content_type: String,
    body: Vec<u8>,
}

fn upstream_request(
    upstream: &Upstream,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<UpstreamResponse, String> {
    let host: String = match upstream {
        Upstream::Tcp(hostport) => (*hostport).to_string(),
        Upstream::Unix(_) => "localhost".to_string(),
    };

    let mut stream: Box<dyn ReadWrite> = match upstream {
        Upstream::Tcp(hostport) => {
            let stream =
                TcpStream::connect(hostport).map_err(|e| format!("connect {hostport}: {e}"))?;
            stream
                .set_read_timeout(Some(UPSTREAM_TIMEOUT))
                .map_err(|e| format!("set read timeout: {e}"))?;
            stream
                .set_write_timeout(Some(UPSTREAM_TIMEOUT))
                .map_err(|e| format!("set write timeout: {e}"))?;
            Box::new(stream)
        }
        Upstream::Unix(path) => {
            let stream =
                UnixStream::connect(path).map_err(|e| format!("connect {path}: {e}"))?;
            stream
                .set_read_timeout(Some(UPSTREAM_TIMEOUT))
                .map_err(|e| format!("set read timeout: {e}"))?;
            stream
                .set_write_timeout(Some(UPSTREAM_TIMEOUT))
                .map_err(|e| format!("set write timeout: {e}"))?;
            Box::new(stream)
        }
    };

    let mut request = format!(
        "{method} {target} HTTP/1.1\r\nhost: {host}\r\nconnection: close\r\ncontent-length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("writing upstream request: {e}"))?;
    stream
        .write_all(body)
        .map_err(|e| format!("writing upstream body: {e}"))?;
    stream
        .flush()
        .map_err(|e| format!("flushing upstream request: {e}"))?;

    let mut raw = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|e| format!("reading upstream response: {e}"))?;
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
        if raw.len() > MAX_UPSTREAM_BYTES {
            return Err("upstream response too large".to_string());
        }
    }
    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> Result<UpstreamResponse, String> {
    let header_end =
        find_subslice(raw, b"\r\n\r\n").ok_or("malformed upstream response: no header end")? + 4;
    let head = String::from_utf8_lossy(&raw[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or("missing upstream status line")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .ok_or("missing upstream status code")?
        .parse()
        .map_err(|_| format!("invalid upstream status: {status_line:?}"))?;

    let mut content_type = "application/json".to_string();
    let mut chunked = false;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-type") {
                content_type = value.trim().to_string();
            }
            if name.eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }

    let raw_body = &raw[header_end..];
    let body = if chunked {
        decode_chunked(raw_body)?
    } else {
        raw_body.to_vec()
    };
    Ok(UpstreamResponse {
        status,
        content_type,
        body,
    })
}

fn decode_chunked(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = find_subslice(data, b"\r\n").ok_or("malformed chunked body")?;
        let size_field = std::str::from_utf8(&data[..line_end])
            .map_err(|_| "malformed chunk size".to_string())?;
        let size_text = size_field.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_text, 16)
            .map_err(|_| format!("invalid chunk size: {size_text:?}"))?;
        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size + 2 {
            return Err("truncated chunked body".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Fabro API client
// ---------------------------------------------------------------------------

fn api_request(
    cfg: &Config,
    method: &str,
    path: &str,
    body: Option<(&[u8], &str)>,
) -> Result<UpstreamResponse, String> {
    let mut headers = vec![
        (
            "authorization".to_string(),
            format!("Bearer {}", cfg.dev_token),
        ),
        ("accept".to_string(), "application/json".to_string()),
    ];
    let body_bytes = body.map(|(bytes, _)| bytes).unwrap_or(&[]);
    if let Some((_, content_type)) = body {
        headers.push(("content-type".to_string(), content_type.to_string()));
    }
    upstream_request(
        &Upstream::Tcp(&cfg.api_hostport),
        method,
        &cfg.api_path(path),
        &headers,
        body_bytes,
    )
}

fn api_get_json(cfg: &Config, path: &str) -> Result<Value, String> {
    let response = api_request(cfg, "GET", path, None)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("GET {path}: HTTP {}", response.status));
    }
    serde_json::from_slice(&response.body).map_err(|e| format!("GET {path}: bad JSON: {e}"))
}

fn variable_entries(value: &Value) -> Vec<&Value> {
    if let Some(array) = value.as_array() {
        return array.iter().collect();
    }
    for key in ["data", "variables"] {
        if let Some(array) = value.get(key).and_then(|v| v.as_array()) {
            return array.iter().collect();
        }
    }
    Vec::new()
}

fn allowed_versions(cfg: &Config, cache: &Mutex<VersionCache>) -> Result<HashSet<String>, String> {
    let mut guard = cache.lock().map_err(|_| "version cache poisoned")?;
    if let Some(fetched) = guard.fetched {
        if fetched.elapsed() < VERSIONS_CACHE_TTL {
            return Ok(guard.values.clone());
        }
    }
    let response = api_request(cfg, "GET", "/variables", None)?;
    if !(200..300).contains(&response.status) {
        return Err(format!("GET /variables: HTTP {}", response.status));
    }
    let parsed: Value =
        serde_json::from_slice(&response.body).map_err(|e| format!("GET /variables: {e}"))?;
    let mut values = HashSet::new();
    for entry in variable_entries(&parsed) {
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value = entry.get("value").and_then(|v| v.as_str()).unwrap_or("");
        if cfg.allowed_version_vars.iter().any(|allowed| allowed == name) && !value.is_empty() {
            values.insert(value.to_string());
        }
    }
    if values.is_empty() {
        return Err(format!(
            "none of {:?} resolved to a workflow-version id",
            cfg.allowed_version_vars
        ));
    }
    guard.fetched = Some(Instant::now());
    guard.values = values.clone();
    Ok(values)
}

// ---------------------------------------------------------------------------
// Sandbox identity and policy
// ---------------------------------------------------------------------------

fn run_id_for_ip(cfg: &Config, ip: IpAddr) -> Option<String> {
    let response = upstream_request(
        &Upstream::Unix(&cfg.podman_socket),
        "GET",
        "/v1.41/containers/json?all=true",
        &[("accept".to_string(), "application/json".to_string())],
        &[],
    )
    .ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let containers: Value = serde_json::from_slice(&response.body).ok()?;
    run_id_from_containers(&containers, &ip.to_string())
}

fn run_id_from_containers(containers: &Value, ip: &str) -> Option<String> {
    for container in containers.as_array()? {
        let networks = container
            .pointer("/NetworkSettings/Networks")
            .and_then(|v| v.as_object());
        let ip_matches = networks
            .map(|map| {
                map.values().any(|network| {
                    network.pointer("/IPAddress").and_then(|v| v.as_str()) == Some(ip)
                })
            })
            .unwrap_or(false);
        if !ip_matches {
            continue;
        }
        if let Some(run_id) = container
            .pointer("/Labels/petri.run")
            .and_then(|v| v.as_str())
        {
            return Some(run_id.to_string());
        }
        if let Some(names) = container.get("Names").and_then(|v| v.as_array()) {
            for name in names {
                if let Some(run_id) = name.as_str().and_then(parse_petri_name) {
                    return Some(run_id);
                }
            }
        }
    }
    None
}

fn parse_petri_name(name: &str) -> Option<String> {
    let rest = name.trim_start_matches('/').strip_prefix("petri-")?;
    if rest.len() < 26 {
        return None;
    }
    let run_id = &rest[..26];
    if !run_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(run_id.to_string())
}

fn caller_allowed(cfg: &Config, caller: &Value) -> Result<(), String> {
    let slug = caller
        .pointer("/workflow/slug")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !cfg.allowed_slugs.iter().any(|allowed| allowed == slug) {
        return Err(format!(
            "workflow {slug:?} is not an allowed dispatch caller (allowed: {:?})",
            cfg.allowed_slugs
        ));
    }
    let status = caller
        .pointer("/lifecycle/status/kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if status != "running" {
        return Err(format!("caller run status is {status:?}, expected \"running\""));
    }
    Ok(())
}

enum Route {
    Create,
    Start(String),
}

fn route(method: &str, path: &str) -> Option<Route> {
    if method != "POST" {
        return None;
    }
    if path == "/api/v1/runs" {
        return Some(Route::Create);
    }
    let rest = path.strip_prefix("/api/v1/runs/")?;
    let id = rest.strip_suffix("/start")?;
    if id.is_empty() || id.contains('/') {
        return None;
    }
    Some(Route::Start(id.to_string()))
}

fn prepare_create(
    caller: &Value,
    versions: &HashSet<String>,
    body: &mut Value,
) -> Result<(), String> {
    let caller_id = caller
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if caller_id.is_empty() {
        return Err("calling run has no id; refusing to dispatch".to_string());
    }
    if !body.is_object() {
        return Err("request body must be a JSON object".to_string());
    }

    match body.get("parent_id") {
        None | Some(Value::Null) => {}
        Some(Value::String(parent)) if parent == caller_id => {}
        Some(_) => {
            return Err(format!(
                "parent_id must be omitted or equal to the calling run {caller_id}"
            ))
        }
    }

    let kind = body
        .pointer("/target/kind")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if kind != "git" {
        return Err("target.kind must be \"git\"".to_string());
    }
    let repo = body
        .pointer("/target/repo")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let caller_repo = caller
        .pointer("/repository/name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if caller_repo.is_empty() {
        return Err("calling run has no repository; refusing to dispatch".to_string());
    }
    if !repo.eq_ignore_ascii_case(caller_repo) {
        return Err(format!(
            "target.repo {repo:?} must match the calling run's repository {caller_repo:?}"
        ));
    }

    let version_id = body
        .get("workflow_version_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !versions.contains(version_id) {
        return Err("workflow_version_id is not an allowed dispatch target".to_string());
    }

    body.as_object_mut()
        .ok_or("request body must be a JSON object")?
        .insert("parent_id".to_string(), Value::String(caller_id.to_string()));
    Ok(())
}

fn handle_start(
    cfg: &Config,
    caller: &Value,
    child_id: &str,
) -> Result<UpstreamResponse, (u16, String)> {
    let caller_id = caller.get("id").and_then(|v| v.as_str()).unwrap_or("");

    let child_response = api_request(cfg, "GET", &format!("/runs/{child_id}"), None)
        .map_err(|e| (502, format!("cannot inspect run {child_id}: {e}")))?;
    if child_response.status == 404 {
        return Err((404, format!("run {child_id} does not exist")));
    }
    if !(200..300).contains(&child_response.status) {
        return Err((
            502,
            format!("inspecting run {child_id} failed: HTTP {}", child_response.status),
        ));
    }
    let child: Value = serde_json::from_slice(&child_response.body)
        .map_err(|e| (502, format!("run {child_id} metadata is not JSON: {e}")))?;
    let parent = child.get("parent_id").and_then(|v| v.as_str()).unwrap_or("");
    if parent != caller_id {
        return Err((
            403,
            format!("run {child_id} is not a child of the calling run {caller_id}"),
        ));
    }

    let started = api_request(
        cfg,
        "POST",
        &format!("/runs/{child_id}/start"),
        Some((b"{}", "application/json")),
    )
    .map_err(|e| (502, format!("start request for {child_id} failed: {e}")))?;
    if !(200..300).contains(&started.status) {
        return Ok(started);
    }

    let mut run = api_get_json(cfg, &format!("/runs/{child_id}"))
        .map_err(|e| (502, format!("reading run {child_id} after start: {e}")))?;
    let pending = run
        .pointer("/lifecycle/status/kind")
        .and_then(|v| v.as_str())
        == Some("pending");
    if pending {
        let approved = api_request(cfg, "POST", &format!("/runs/{child_id}/approve"), None)
            .map_err(|e| (502, format!("approving run {child_id} failed: {e}")))?;
        if !(200..300).contains(&approved.status) {
            return Err((
                502,
                format!("approving run {child_id} failed: HTTP {}", approved.status),
            ));
        }
        run = api_get_json(cfg, &format!("/runs/{child_id}"))
            .map_err(|e| (502, format!("reading run {child_id} after approve: {e}")))?;
    }

    let body = serde_json::to_vec(&run)
        .map_err(|e| (500, format!("serializing run {child_id}: {e}")))?;
    Ok(UpstreamResponse {
        status: 200,
        content_type: "application/json".to_string(),
        body,
    })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

fn fail(stream: &mut TcpStream, status: u16, message: &str) {
    eprintln!("fabro-api-bridge: deny {status}: {message}");
    respond_json(stream, status, &json!({ "error": message }));
}

fn handle_connection(cfg: Arc<Config>, cache: Arc<Mutex<VersionCache>>, mut stream: TcpStream) {
    let peer_ip = stream.peer_addr().ok().map(|addr| addr.ip());
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => return fail(&mut stream, 400, &format!("bad request: {error}")),
    };

    if request.method == "GET" && request.path == "/healthz" {
        return respond_json(&mut stream, 200, &json!({ "status": "ok" }));
    }

    let Some(peer_ip) = peer_ip else {
        return fail(&mut stream, 403, "cannot determine source address");
    };
    let Some(run_id) = run_id_for_ip(&cfg, peer_ip) else {
        return fail(
            &mut stream,
            403,
            &format!("source address {peer_ip} does not belong to a workflow sandbox"),
        );
    };

    let caller = match api_get_json(&cfg, &format!("/runs/{run_id}")) {
        Ok(run) => run,
        Err(error) => {
            return fail(
                &mut stream,
                502,
                &format!("cannot resolve caller run {run_id}: {error}"),
            )
        }
    };
    if let Err(reason) = caller_allowed(&cfg, &caller) {
        return fail(
            &mut stream,
            403,
            &format!("run {run_id} is not authorized: {reason}"),
        );
    }

    match route(&request.method, &request.path) {
        Some(Route::Create) => {
            let mut body: Value = match serde_json::from_slice(&request.body) {
                Ok(body) => body,
                Err(error) => {
                    return fail(&mut stream, 400, &format!("invalid JSON body: {error}"))
                }
            };
            let versions = match allowed_versions(&cfg, &cache) {
                Ok(versions) => versions,
                Err(error) => return fail(&mut stream, 503, &error),
            };
            if let Err(reason) = prepare_create(&caller, &versions, &mut body) {
                return fail(
                    &mut stream,
                    403,
                    &format!("run {run_id} create refused: {reason}"),
                );
            }
            let encoded = match serde_json::to_vec(&body) {
                Ok(encoded) => encoded,
                Err(error) => {
                    return fail(&mut stream, 500, &format!("serializing request: {error}"))
                }
            };
            match api_request(
                &cfg,
                "POST",
                "/runs",
                Some((&encoded, "application/json")),
            ) {
                Ok(response) => {
                    eprintln!(
                        "fabro-api-bridge: allow run={run_id} POST /api/v1/runs -> {}",
                        response.status
                    );
                    respond(&mut stream, response.status, &response.content_type, &response.body);
                }
                Err(error) => fail(
                    &mut stream,
                    502,
                    &format!("upstream create failed: {error}"),
                ),
            }
        }
        Some(Route::Start(child_id)) => match handle_start(&cfg, &caller, &child_id) {
            Ok(response) => {
                eprintln!(
                    "fabro-api-bridge: allow run={run_id} POST /api/v1/runs/{child_id}/start -> {}",
                    response.status
                );
                respond(&mut stream, response.status, &response.content_type, &response.body);
            }
            Err((status, message)) => fail(&mut stream, status, &message),
        },
        None => fail(
            &mut stream,
            403,
            &format!("endpoint {} {} is not allowed", request.method, request.path),
        ),
    }
}

fn main() {
    let cfg = match Config::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(error) => {
            eprintln!("fabro-api-bridge: configuration error: {error}");
            exit(1);
        }
    };

    let listener = loop {
        match TcpListener::bind(&cfg.listen) {
            Ok(listener) => break listener,
            Err(error) => {
                eprintln!(
                    "fabro-api-bridge: bind {} failed: {error}; retrying in 2s",
                    cfg.listen
                );
                thread::sleep(Duration::from_secs(2));
            }
        }
    };
    eprintln!(
        "fabro-api-bridge: listening on {} (allowed slugs: {:?})",
        cfg.listen, cfg.allowed_slugs
    );

    let cache = Arc::new(Mutex::new(VersionCache::new()));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let cfg = Arc::clone(&cfg);
                let cache = Arc::clone(&cache);
                thread::spawn(move || handle_connection(cfg, cache, stream));
            }
            Err(error) => eprintln!("fabro-api-bridge: accept failed: {error}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(api_hostport: String) -> Config {
        Config {
            listen: "127.0.0.1:0".to_string(),
            api_hostport,
            api_prefix: "/api/v1".to_string(),
            podman_socket: "/nonexistent".to_string(),
            dev_token: "fabro_dev_test".to_string(),
            allowed_slugs: vec!["dispatch".to_string()],
            allowed_version_vars: vec!["oneshot_workflow_version".to_string()],
        }
    }

    fn test_cache() -> Mutex<VersionCache> {
        Mutex::new(VersionCache::new())
    }

    #[test]
    fn container_lookup_prefers_petri_run_label() {
        let containers = json!([
            {
                "Names": ["/petri-00000000000000000000000000-l0"],
                "Labels": {"petri.run": "01M507E860H2VN80HQBC0W18ZV"},
                "NetworkSettings": {"Networks": {"podman": {"IPAddress": "10.88.0.10"}}}
            },
            {
                "Names": ["/petri-01AAAAAAAAAAAAAAAAAAAAAAAA-l0"],
                "Labels": {},
                "NetworkSettings": {"Networks": {"podman": {"IPAddress": "10.88.0.11"}}}
            }
        ]);
        assert_eq!(
            run_id_from_containers(&containers, "10.88.0.10").as_deref(),
            Some("01M507E860H2VN80HQBC0W18ZV")
        );
        assert_eq!(
            run_id_from_containers(&containers, "10.88.0.11").as_deref(),
            Some("01AAAAAAAAAAAAAAAAAAAAAAAA")
        );
        assert_eq!(run_id_from_containers(&containers, "10.88.0.99"), None);
    }

    #[test]
    fn petri_name_parsing() {
        assert_eq!(
            parse_petri_name("/petri-01M507E860H2VN80HQBC0W18ZV-l0").as_deref(),
            Some("01M507E860H2VN80HQBC0W18ZV")
        );
        assert_eq!(parse_petri_name("/petri-short-l0"), None);
        assert_eq!(parse_petri_name("/other-01M507E860H2VN80HQBC0W18ZV-l0"), None);
    }

    #[test]
    fn routing_table() {
        assert!(matches!(route("POST", "/api/v1/runs"), Some(Route::Create)));
        assert!(matches!(
            route("POST", "/api/v1/runs/01M507E860H2VN80HQBC0W18ZV/start"),
            Some(Route::Start(id)) if id == "01M507E860H2VN80HQBC0W18ZV"
        ));
        assert!(route("GET", "/api/v1/runs").is_none());
        assert!(route("POST", "/api/v1/runs/foo/approve").is_none());
        assert!(route("POST", "/api/v1/runs/foo/start/extra").is_none());
        assert!(route("POST", "/api/v1/environments").is_none());
    }

    #[test]
    fn caller_policy_checks_slug_and_status() {
        let cfg = test_config("127.0.0.1:1".to_string());
        let running_dispatch = json!({
            "id": "01M507E860H2VN80HQBC0W18ZV",
            "workflow": {"slug": "dispatch"},
            "lifecycle": {"status": {"kind": "running"}}
        });
        assert!(caller_allowed(&cfg, &running_dispatch).is_ok());

        let mut other = running_dispatch.clone();
        other["workflow"]["slug"] = json!("oneshot");
        assert!(caller_allowed(&cfg, &other).is_err());

        let mut finished = running_dispatch.clone();
        finished["lifecycle"]["status"]["kind"] = json!("succeeded");
        assert!(caller_allowed(&cfg, &finished).is_err());
    }

    fn caller_run() -> Value {
        json!({
            "id": "01M507E860H2VN80HQBC0W18ZV",
            "workflow": {"slug": "dispatch"},
            "lifecycle": {"status": {"kind": "running"}},
            "repository": {"name": "DWSR/nix-config"}
        })
    }

    fn versions() -> HashSet<String> {
        HashSet::from(["7f2f".to_string()])
    }

    #[test]
    fn create_injects_parent_and_checks_repository_and_version() {
        let mut body = json!({
            "workflow_version_id": "7f2f",
            "target": {"kind": "git", "repo": "DWSR/nix-config", "branch": "main"},
            "args": {"inputs": {"issue": "54"}}
        });
        assert!(prepare_create(&caller_run(), &versions(), &mut body).is_ok());
        assert_eq!(body["parent_id"], json!("01M507E860H2VN80HQBC0W18ZV"));

        let mut conflicting = json!({
            "workflow_version_id": "7f2f",
            "parent_id": "01OTHER",
            "target": {"kind": "git", "repo": "DWSR/nix-config", "branch": "main"}
        });
        assert!(prepare_create(&caller_run(), &versions(), &mut conflicting).is_err());

        let mut wrong_repo = json!({
            "workflow_version_id": "7f2f",
            "target": {"kind": "git", "repo": "DWSR/other", "branch": "main"}
        });
        assert!(prepare_create(&caller_run(), &versions(), &mut wrong_repo).is_err());

        let mut wrong_version = json!({
            "workflow_version_id": "deadbeef",
            "target": {"kind": "git", "repo": "DWSR/nix-config", "branch": "main"}
        });
        assert!(prepare_create(&caller_run(), &versions(), &mut wrong_version).is_err());

        let mut not_git = json!({
            "workflow_version_id": "7f2f",
            "target": {"kind": "none"}
        });
        assert!(prepare_create(&caller_run(), &versions(), &mut not_git).is_err());
    }

    #[test]
    fn chunked_bodies_decode() {
        let data = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(data).unwrap(), b"Wikipedia");
    }

    #[test]
    fn upstream_responses_parse() {
        let raw = b"HTTP/1.1 201 Created\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}";
        let parsed = parse_response(raw).unwrap();
        assert_eq!(parsed.status, 201);
        assert_eq!(parsed.body, b"{}");

        let chunked = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n2\r\nhi\r\n0\r\n\r\n";
        let parsed = parse_response(chunked).unwrap();
        assert_eq!(parsed.body, b"hi");
    }

    #[test]
    fn version_entries_tolerate_shapes() {
        let bare = json!([{"name": "a", "value": "1"}]);
        assert_eq!(variable_entries(&bare).len(), 1);
        let wrapped = json!({"data": [{"name": "a", "value": "1"}]});
        assert_eq!(variable_entries(&wrapped).len(), 1);
        let other = json!({"variables": []});
        assert_eq!(variable_entries(&other).len(), 0);
    }

    #[test]
    fn version_allowlist_fetches_and_filters_by_configured_names() {
        let api = MockApi::start(|_method, path, _| {
            assert_eq!(path, "/api/v1/variables");
            (
                200,
                json!({"data": [
                    {"name": "oneshot_workflow_version", "value": "1111"},
                    {"name": "kiro_spec_workflow_version", "value": "2222"},
                    {"name": "unrelated", "value": "3333"}
                ]}),
            )
        });
        let cfg = test_config(api.addr.clone());
        let cache = test_cache();
        let versions = allowed_versions(&cfg, &cache).unwrap();
        assert!(versions.contains("1111"));
        assert!(!versions.contains("2222"));
        assert!(!versions.contains("3333"));

        // Second call is served from the cache (no new upstream request).
        let requests_after_first = api.requests.lock().unwrap().len();
        let _ = allowed_versions(&cfg, &cache).unwrap();
        assert_eq!(api.requests.lock().unwrap().len(), requests_after_first);
    }

    // -- mock Fabro API ------------------------------------------------------

    struct MockApi {
        addr: String,
        requests: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl MockApi {
        /// Spawns a TCP server; `answer` maps (method, path, body) to
        /// (status, JSON body).
        fn start(
            answer: impl Fn(&str, &str, &str) -> (u16, Value) + Send + Sync + 'static,
        ) -> MockApi {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap().to_string();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let collected = Arc::clone(&requests);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let (method, path, body) = match read_request(&mut stream) {
                        Ok(request) => (request.method, request.path, request.body),
                        Err(_) => continue,
                    };
                    let body_text = String::from_utf8_lossy(&body).into_owned();
                    collected
                        .lock()
                        .unwrap()
                        .push((format!("{method} {path}"), body_text.clone()));
                    let (status, value) = answer(&method, &path, &body_text);
                    respond_json(&mut stream, status, &value);
                }
            });
            MockApi { addr, requests }
        }
    }

    #[test]
    fn start_flow_approves_pending_child() {
        let approved = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let approved_in_mock = Arc::clone(&approved);
        let api = MockApi::start(move |method, path, _| match (method, path) {
            ("GET", "/api/v1/runs/01CHILD") => {
                let status = if approved_in_mock.load(std::sync::atomic::Ordering::SeqCst) {
                    "runnable"
                } else {
                    "pending"
                };
                (
                    200,
                    json!({"id": "01CHILD", "parent_id": "01CALLER", "lifecycle": {"status": {"kind": status}}}),
                )
            }
            ("POST", "/api/v1/runs/01CHILD/start") => (200, json!({})),
            ("POST", "/api/v1/runs/01CHILD/approve") => {
                approved_in_mock.store(true, std::sync::atomic::Ordering::SeqCst);
                (200, json!({}))
            }
            _ => (404, json!({"error": "unexpected"})),
        });
        let cfg = test_config(api.addr.clone());
        let caller = json!({"id": "01CALLER"});

        let response = handle_start(&cfg, &caller, "01CHILD").unwrap();
        assert_eq!(response.status, 200);
        let final_run: Value = serde_json::from_slice(&response.body).unwrap();
        assert_eq!(final_run["lifecycle"]["status"]["kind"], json!("runnable"));

        let requests = api.requests.lock().unwrap().clone();
        let paths: Vec<String> = requests.iter().map(|(p, _)| p.clone()).collect();
        assert!(paths.contains(&"GET /api/v1/runs/01CHILD".to_string()));
        assert!(paths.contains(&"POST /api/v1/runs/01CHILD/start".to_string()));
        assert!(paths.contains(&"POST /api/v1/runs/01CHILD/approve".to_string()));
    }

    #[test]
    fn start_flow_refuses_foreign_child() {
        let api = MockApi::start(|_method, _path, _| {
            (
                200,
                json!({"id": "01CHILD", "parent_id": "01SOMEONE_ELSE"}),
            )
        });
        let cfg = test_config(api.addr.clone());
        let caller = json!({"id": "01CALLER"});
        let error = handle_start(&cfg, &caller, "01CHILD").unwrap_err();
        assert_eq!(error.0, 403);
    }

    #[test]
    fn request_round_trip_over_tcp() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let parsed = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream).unwrap();
            (request.method, request.path, request.body)
        });

        let body = br#"{"hello":"world"}"#;
        let mut stream = TcpStream::connect(addr).unwrap();
        let request = format!(
            "POST /api/v1/runs HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n",
            body.len()
        );
        stream.write_all(request.as_bytes()).unwrap();
        stream.write_all(body).unwrap();
        stream.flush().unwrap();

        let (method, path, parsed_body) = parsed.join().unwrap();
        assert_eq!(method, "POST");
        assert_eq!(path, "/api/v1/runs");
        assert_eq!(parsed_body, body);
    }
}
