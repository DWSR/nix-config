//! Readiness-gated supervisor for the pinned iii engine.
//!
//! iii 0.26.0 logs a bind conflict and stays alive instead of exiting, so
//! systemd cannot treat "process spawned" as "engine is serving". This crate
//! is the unit's main process: it binds the listen address once to prove it is
//! free, spawns the engine as its direct child, and only reports `READY=1`
//! after the child owns a listening socket on that exact address and port.
//! While the child runs it sends watchdog keep-alives at half the systemd
//! interval; on SIGTERM/SIGINT it forwards the signal, escalates after the stop
//! timeout, reaps the child, and exits with the child's status.
//!
//! Readiness is Linux-only because it reads `/proc/<pid>/fd` and
//! `/proc/net/tcp{,6}`. The crate compiles on Darwin, where the readiness
//! predicate is injected by tests.
#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::fmt;
#[cfg(target_os = "linux")]
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;
use std::time::{Duration, Instant};

use sd_notify::NotifyState;

/// How often the readiness gate and the supervision loop poll.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Parsed supervisor command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// Address the engine must own before the unit becomes ready.
    pub listen: SocketAddr,
    /// How long to wait for the engine to own `listen` before failing.
    pub ready_timeout: Duration,
    /// How long the engine gets to exit after SIGTERM before SIGKILL.
    pub stop_timeout: Duration,
    /// Engine executable.
    pub engine: OsString,
    /// Engine arguments, including `--config` and `--no-update-check`.
    pub engine_args: Vec<OsString>,
}

/// Parses `--listen <ip:port> --ready-timeout <secs> --stop-timeout <secs> -- <engine> <args...>`.
pub fn parse_args<I, S>(args: I) -> Result<Config, String>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let mut args = args.into_iter().map(Into::into);
    let mut listen = None;
    let mut ready_timeout = None;
    let mut stop_timeout = None;
    let mut engine = None;
    let mut engine_args = Vec::new();

    while let Some(arg) = args.next() {
        let flag = arg.to_string_lossy().into_owned();
        match flag.as_str() {
            "--listen" => listen = Some(parse_listen(next_value(&mut args, "--listen")?)?),
            "--ready-timeout" => {
                ready_timeout = Some(parse_seconds(
                    next_value(&mut args, "--ready-timeout")?,
                    "--ready-timeout",
                )?);
            }
            "--stop-timeout" => {
                stop_timeout = Some(parse_seconds(
                    next_value(&mut args, "--stop-timeout")?,
                    "--stop-timeout",
                )?);
            }
            "--" => {
                engine = Some(
                    args.next()
                        .ok_or_else(|| "missing engine command after --".to_string())?,
                );
                engine_args = args.collect();
                break;
            }
            _ => return Err(format!("unexpected argument: {flag}")),
        }
    }

    Ok(Config {
        listen: listen.ok_or_else(|| "missing --listen".to_string())?,
        ready_timeout: ready_timeout.ok_or_else(|| "missing --ready-timeout".to_string())?,
        stop_timeout: stop_timeout.ok_or_else(|| "missing --stop-timeout".to_string())?,
        engine: engine.ok_or_else(|| "missing -- separator and engine command".to_string())?,
        engine_args,
    })
}

fn next_value<I>(args: &mut I, flag: &str) -> Result<OsString, String>
where
    I: Iterator<Item = OsString>,
{
    args.next()
        .ok_or_else(|| format!("missing value for {flag}"))
}

fn parse_listen(value: OsString) -> Result<SocketAddr, String> {
    let text = value.to_string_lossy();
    text.parse::<SocketAddr>()
        .map_err(|_| format!("invalid --listen address: {text} (expected <ip>:<port>)"))
}

fn parse_seconds(value: OsString, flag: &str) -> Result<Duration, String> {
    let text = value.to_string_lossy();
    text.parse::<u64>()
        .map(Duration::from_secs)
        .map_err(|_| format!("invalid {flag} value: {text} (expected whole seconds)"))
}

/// A failed preflight bind.
#[derive(Debug)]
pub struct BindError {
    pub addr: SocketAddr,
    pub in_use: bool,
    pub source: io::Error,
}

impl fmt::Display for BindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.in_use {
            write!(f, "cannot bind {}: Address already in use", self.addr)
        } else {
            write!(f, "cannot bind {}: {}", self.addr, self.source)
        }
    }
}

impl std::error::Error for BindError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.source)
    }
}

/// Binds and releases `addr` so a foreign listener fails the start before the
/// engine is spawned.
pub fn preflight(addr: SocketAddr) -> Result<(), BindError> {
    match TcpListener::bind(addr) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(source) => Err(BindError {
            addr,
            in_use: source.kind() == io::ErrorKind::AddrInUse,
            source,
        }),
    }
}

/// Why readiness was not reached.
#[derive(Debug)]
pub enum ReadinessError {
    /// The engine exited before owning the listen address.
    ChildExited(ExitStatus),
    /// The engine could not be waited on.
    Wait(io::Error),
    /// The engine did not own the listen address within the timeout.
    Timeout(Duration),
}

impl fmt::Display for ReadinessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadinessError::ChildExited(status) => {
                write!(f, "engine exited before readiness: {status}")
            }
            ReadinessError::Wait(error) => {
                write!(f, "cannot wait for the engine before readiness: {error}")
            }
            ReadinessError::Timeout(timeout) => write!(
                f,
                "readiness timeout: engine did not own the listen address within {}s",
                timeout.as_secs_f64()
            ),
        }
    }
}

/// Waits until `owns(child_pid)` reports the engine owns the listen address.
///
/// The predicate is injected so tests can bypass `/proc` (and so Darwin tests
/// can exercise the supervision loop without a Linux procfs).
pub fn await_readiness<F>(
    child: &mut Child,
    timeout: Duration,
    owns: F,
) -> Result<(), ReadinessError>
where
    F: Fn(u32) -> bool,
{
    let started = Instant::now();
    let pid = child.id();

    loop {
        if owns(pid) {
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(status)) => return Err(ReadinessError::ChildExited(status)),
            Ok(None) => {}
            Err(error) => return Err(ReadinessError::Wait(error)),
        }
        if started.elapsed() >= timeout {
            return Err(ReadinessError::Timeout(timeout));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// The interval at which to send `WATCHDOG=1`: half of what systemd advertises.
///
/// Returns `None` when the unit has no watchdog enabled.
pub fn watchdog_interval() -> Option<Duration> {
    sd_notify::watchdog_enabled().map(|interval| interval / 2)
}

/// Sends notify states, logging (but ignoring) a failed send so the
/// supervision loop keeps running.
fn notify(states: &[NotifyState<'_>]) {
    if let Err(error) = sd_notify::notify(states) {
        eprintln!("iii-supervisor: systemd notify failed: {error}");
    }
}

static TERMINATE: AtomicBool = AtomicBool::new(false);
static INSTALL_HANDLERS: Once = Once::new();

extern "C" fn request_termination(_signal: libc::c_int) {
    TERMINATE.store(true, Ordering::SeqCst);
}

fn install_signal_handlers() {
    let handler = request_termination as extern "C" fn(libc::c_int) as libc::sighandler_t;
    INSTALL_HANDLERS.call_once(|| unsafe {
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGINT, handler);
    });
}

fn signal_child(child: &Child, signal: libc::c_int) {
    unsafe {
        libc::kill(child.id() as libc::pid_t, signal);
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

/// Runs the supervised engine and returns the process exit code.
pub fn supervise<F>(config: &Config, owns: F) -> i32
where
    F: Fn(u32) -> bool,
{
    if let Err(error) = preflight(config.listen) {
        eprintln!("iii-supervisor: {error}");
        return 1;
    }

    let mut child = match Command::new(&config.engine)
        .args(&config.engine_args)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "iii-supervisor: cannot start {}: {error}",
                config.engine.to_string_lossy()
            );
            return 1;
        }
    };

    install_signal_handlers();

    match await_readiness(&mut child, config.ready_timeout, &owns) {
        Ok(()) => {}
        Err(ReadinessError::ChildExited(status)) => {
            eprintln!(
                "iii-supervisor: engine exited before readiness: {}",
                describe_status(status)
            );
            return exit_code(status);
        }
        Err(ReadinessError::Timeout(timeout)) => {
            eprintln!(
                "iii-supervisor: readiness timeout: engine did not own {} within {}s",
                config.listen,
                timeout.as_secs_f64()
            );
            let _ = child.kill();
            let _ = child.wait();
            return 1;
        }
        Err(ReadinessError::Wait(error)) => {
            eprintln!("iii-supervisor: {error}");
            let _ = child.kill();
            let _ = child.wait();
            return 1;
        }
    }

    notify(&[NotifyState::Ready]);
    let status = format!("listening on {}", config.listen);
    notify(&[NotifyState::Status(&status)]);
    eprintln!("iii-supervisor: ready: engine owns {}", config.listen);

    run_loop(&mut child, config.stop_timeout, watchdog_interval())
}

fn describe_status(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => format!("status {code}"),
        None => format!("signal {}", status.signal().unwrap_or(0)),
    }
}

fn run_loop(child: &mut Child, stop_timeout: Duration, watchdog: Option<Duration>) -> i32 {
    let mut next_watchdog = Instant::now() + watchdog.unwrap_or(Duration::ZERO);

    loop {
        if TERMINATE.swap(false, Ordering::SeqCst) {
            return shutdown(child, stop_timeout);
        }

        match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!("iii-supervisor: engine exited: {}", describe_status(status));
                return exit_code(status);
            }
            Ok(None) => {}
            Err(error) => {
                eprintln!("iii-supervisor: cannot wait for the engine: {error}");
                return 1;
            }
        }

        if let Some(interval) = watchdog {
            let now = Instant::now();
            if now >= next_watchdog {
                notify(&[NotifyState::Watchdog]);
                next_watchdog = now + interval;
            }
            std::thread::sleep(POLL_INTERVAL.min(next_watchdog.saturating_duration_since(now)));
        } else {
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

fn shutdown(child: &mut Child, stop_timeout: Duration) -> i32 {
    notify(&[NotifyState::Stopping]);
    notify(&[NotifyState::Status("stopping")]);

    signal_child(child, libc::SIGTERM);

    let deadline = Instant::now() + stop_timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                eprintln!(
                    "iii-supervisor: engine stopped: {}",
                    describe_status(status)
                );
                return exit_code(status);
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                eprintln!(
                    "iii-supervisor: engine ignored SIGTERM for {}s; sending SIGKILL",
                    stop_timeout.as_secs_f64()
                );
                let _ = child.kill();
                let status = child.wait().ok();
                return status.map(exit_code).unwrap_or(1);
            }
            Err(error) => {
                eprintln!("iii-supervisor: cannot wait for the engine: {error}");
                return 1;
            }
        }
    }
}

/// Production entry point: on Linux the readiness gate reads procfs; other
/// platforms report that listener ownership is unsupported.
pub fn run(config: &Config) -> i32 {
    #[cfg(target_os = "linux")]
    {
        return supervise(config, |pid| listener_owned_by(pid, config.listen));
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = config;
        eprintln!(
            "iii-supervisor: listener ownership requires Linux /proc; unsupported on this platform"
        );
        1
    }
}

/// One `LISTEN`-capable row from `/proc/net/tcp` or `/proc/net/tcp6`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpEntry {
    pub local: SocketAddr,
    pub listen: bool,
    pub inode: u64,
}

/// Parses a `/proc/net/tcp{,6}` table, ignoring headers and malformed rows.
pub fn parse_tcp_table(text: &str) -> Vec<TcpEntry> {
    text.lines().filter_map(parse_tcp_line).collect()
}

fn parse_tcp_line(line: &str) -> Option<TcpEntry> {
    let mut fields = line.split_whitespace();
    fields.next()?;
    let local = fields.next()?;
    fields.next()?;
    let state = fields.next()?;
    for _ in 0..5 {
        fields.next()?;
    }
    let inode = fields.next()?.parse::<u64>().ok()?;

    let (address, port) = local.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let ip = parse_proc_ip(address)?;

    Some(TcpEntry {
        local: SocketAddr::new(ip, port),
        listen: state == "0A",
        inode,
    })
}

fn parse_proc_ip(hex: &str) -> Option<IpAddr> {
    match hex.len() {
        8 => {
            let raw = u32::from_str_radix(hex, 16).ok()?;
            Some(IpAddr::V4(Ipv4Addr::from(raw.to_le_bytes())))
        }
        32 => {
            let mut bytes = [0u8; 16];
            for (index, chunk) in hex.as_bytes().chunks(8).enumerate() {
                let word = u32::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
                bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
            }
            Some(IpAddr::V6(Ipv6Addr::from(bytes)))
        }
        _ => None,
    }
}

/// Extracts the inode from a `/proc/<pid>/fd` symlink target such as
/// `socket:[12345]`.
pub fn parse_socket_link(target: &OsStr) -> Option<u64> {
    target
        .to_str()?
        .strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn same_endpoint(left: SocketAddr, right: SocketAddr) -> bool {
    if left.port() != right.port() {
        return false;
    }
    match (left.ip(), right.ip()) {
        (IpAddr::V4(a), IpAddr::V4(b)) => a == b,
        (IpAddr::V4(a), IpAddr::V6(b)) => b.to_ipv4_mapped() == Some(a),
        (IpAddr::V6(a), IpAddr::V4(b)) => a.to_ipv4_mapped() == Some(b),
        (IpAddr::V6(a), IpAddr::V6(b)) => a == b,
    }
}

#[cfg(target_os = "linux")]
fn socket_inodes(pid: u32) -> HashSet<u64> {
    let mut inodes = HashSet::new();
    let Ok(entries) = fs::read_dir(format!("/proc/{pid}/fd")) else {
        return inodes;
    };
    for entry in entries.flatten() {
        if let Ok(target) = fs::read_link(entry.path()) {
            if let Some(inode) = parse_socket_link(target.as_os_str()) {
                inodes.insert(inode);
            }
        }
    }
    inodes
}

#[cfg(target_os = "linux")]
fn listen_entries() -> Vec<TcpEntry> {
    let mut entries = Vec::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(text) = fs::read_to_string(path) {
            entries.extend(parse_tcp_table(&text));
        }
    }
    entries
}

/// True only when `pid` owns a `LISTEN` socket on exactly `listen`.
///
/// A wildcard bind (`0.0.0.0` or `[::]`) and a listener owned by any other
/// process never match.
#[cfg(target_os = "linux")]
pub fn listener_owned_by(pid: u32, listen: SocketAddr) -> bool {
    let inodes = socket_inodes(pid);
    if inodes.is_empty() {
        return false;
    }
    listen_entries().into_iter().any(|entry| {
        entry.listen && inodes.contains(&entry.inode) && same_endpoint(entry.local, listen)
    })
}
