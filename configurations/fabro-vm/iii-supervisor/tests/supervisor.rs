use std::ffi::{OsStr, OsString};
use std::net::{SocketAddr, TcpListener};
use std::os::unix::net::UnixDatagram;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use std::net::TcpStream;
#[cfg(target_os = "linux")]
use std::process::Command;

use iii_supervisor::{
    parse_args, parse_socket_link, parse_tcp_table, preflight, supervise, watchdog_interval, Config,
};

#[cfg(target_os = "linux")]
use iii_supervisor::listener_owned_by;

static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn free_addr() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    drop(listener);
    addr
}

fn test_config(program: &str, args: &[&str], listen: SocketAddr) -> Config {
    Config {
        listen,
        ready_timeout: Duration::from_secs(5),
        stop_timeout: Duration::from_secs(1),
        engine: program.into(),
        engine_args: args.iter().map(|arg| OsString::from(*arg)).collect(),
    }
}

const TCP_V4: &str = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:BFEE 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 424242 1 0000000000000000 100 0 0 10 0
   1: 00000000:BFEE 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 515151 1 0000000000000000 100 0 0 10 0
   2: 0100007F:BFEE 0100007F:1F90 01 00000000:00000000 00:00000000 00000000     0        0 616161 1 0000000000000000 20 4 30 10 -1
";

const TCP_V6: &str = "\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:BFEE 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 717171 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:BFEE 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 818181 1 0000000000000000 100 0 0 10 0
   2: 0000000000000000FFFF00000100007F:BFEE 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 919191 1 0000000000000000 100 0 0 10 0
";

#[test]
fn parses_ipv4_proc_net_tcp_rows() {
    let entries = parse_tcp_table(TCP_V4);
    assert_eq!(entries.len(), 3, "header row must be ignored");

    assert_eq!(entries[0].local, "127.0.0.1:49134".parse().unwrap());
    assert!(entries[0].listen);
    assert_eq!(entries[0].inode, 424242);

    assert_eq!(entries[1].local, "0.0.0.0:49134".parse().unwrap());
    assert!(entries[1].listen);
    assert_eq!(entries[1].inode, 515151);

    assert_eq!(entries[2].local, "127.0.0.1:49134".parse().unwrap());
    assert!(!entries[2].listen, "state 01 is ESTABLISHED, not LISTEN");
    assert_eq!(entries[2].inode, 616161);
}

#[test]
fn parses_ipv6_proc_net_tcp_rows() {
    let entries = parse_tcp_table(TCP_V6);
    assert_eq!(entries.len(), 3, "header row must be ignored");

    assert_eq!(entries[0].local, "[::1]:49134".parse().unwrap());
    assert!(entries[0].listen);
    assert_eq!(entries[0].inode, 717171);

    assert_eq!(entries[1].local, "[::]:49134".parse().unwrap());
    assert!(entries[1].listen);

    assert_eq!(
        entries[2].local,
        "[::ffff:127.0.0.1]:49134".parse().unwrap()
    );
    assert!(entries[2].listen);
}

#[test]
fn extracts_socket_inodes_from_fd_links() {
    assert_eq!(parse_socket_link(OsStr::new("socket:[12345]")), Some(12345));
    assert_eq!(parse_socket_link(OsStr::new("pipe:[12345]")), None);
    assert_eq!(parse_socket_link(OsStr::new("anon_inode:[eventfd]")), None);
    assert_eq!(parse_socket_link(OsStr::new("socket:[not-a-number]")), None);
}

#[test]
fn parses_the_documented_command_line() {
    let config = parse_args([
        "--listen",
        "127.0.0.1:49134",
        "--ready-timeout",
        "15",
        "--stop-timeout",
        "10",
        "--",
        "/nix/store/iii/bin/iii",
        "--config",
        "/nix/store/iii-config.yaml",
        "--no-update-check",
    ])
    .expect("parse documented command line");

    assert_eq!(config.listen, "127.0.0.1:49134".parse().unwrap());
    assert_eq!(config.ready_timeout, Duration::from_secs(15));
    assert_eq!(config.stop_timeout, Duration::from_secs(10));
    assert_eq!(config.engine, OsString::from("/nix/store/iii/bin/iii"));
    assert_eq!(
        config.engine_args,
        vec![
            OsString::from("--config"),
            OsString::from("/nix/store/iii-config.yaml"),
            OsString::from("--no-update-check"),
        ]
    );
}

#[test]
fn rejects_an_incomplete_command_line() {
    assert!(parse_args(["--listen", "127.0.0.1:49134"]).is_err());
    assert!(parse_args([
        "--listen",
        "127.0.0.1:49134",
        "--ready-timeout",
        "15",
        "--stop-timeout",
        "10",
        "/bin/true",
    ])
    .is_err());
    assert!(parse_args([
        "--listen",
        "not-an-address",
        "--ready-timeout",
        "15",
        "--stop-timeout",
        "10",
        "--",
        "/bin/true",
    ])
    .is_err());
    assert!(parse_args([
        "--listen",
        "127.0.0.1:49134",
        "--ready-timeout",
        "soon",
        "--stop-timeout",
        "10",
        "--",
        "/bin/true",
    ])
    .is_err());
}

#[test]
fn preflight_reports_an_occupied_port() {
    let _guard = serial();
    let listener = TcpListener::bind("127.0.0.1:0").expect("hold the port");
    let addr = listener.local_addr().expect("local addr");

    let error = preflight(addr).expect_err("port is occupied");
    assert!(error.in_use);
    assert_eq!(
        error.to_string(),
        format!("cannot bind {addr}: Address already in use")
    );

    drop(listener);
    assert!(preflight(addr).is_ok(), "port is free after release");
}

#[cfg(target_os = "linux")]
#[test]
fn binary_exits_one_before_spawning_on_a_bind_conflict() {
    let _guard = serial();
    let listener = TcpListener::bind("127.0.0.1:0").expect("hold the port");
    let addr = listener.local_addr().expect("local addr");
    let addr_text = addr.to_string();

    let output = Command::new(env!("CARGO_BIN_EXE_iii-supervisor"))
        .args([
            "--listen",
            addr_text.as_str(),
            "--ready-timeout",
            "1",
            "--stop-timeout",
            "1",
            "--",
            "/bin/true",
        ])
        .output()
        .expect("run the supervisor");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(
        stderr.contains(&format!("cannot bind {addr}: Address already in use")),
        "stderr: {stderr}"
    );
    drop(listener);
}

#[cfg(target_os = "linux")]
#[test]
fn ownership_matches_only_the_child_listener() {
    let _guard = serial();
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
    let addr = listener.local_addr().expect("local addr");
    assert!(
        listener_owned_by(std::process::id(), addr),
        "the test process owns its own listener"
    );

    let mut foreign = Command::new("/bin/sh")
        .args(["-c", "exec sleep 3"])
        .spawn()
        .expect("spawn a non-listening child");
    assert!(
        TcpStream::connect(addr).is_ok(),
        "the foreign listener still accepts TCP"
    );
    assert!(
        !listener_owned_by(foreign.id(), addr),
        "a connectable listener is not owned by a child that never bound it"
    );
    let _ = foreign.kill();
    let _ = foreign.wait();
}

#[cfg(target_os = "linux")]
#[test]
fn wildcard_listener_never_satisfies_a_loopback_gate() {
    let _guard = serial();
    let wildcard = TcpListener::bind("0.0.0.0:0").expect("bind wildcard");
    let port = wildcard.local_addr().expect("local addr").port();
    let loopback: SocketAddr = format!("127.0.0.1:{port}").parse().unwrap();
    assert!(
        !listener_owned_by(std::process::id(), loopback),
        "a 0.0.0.0 bind must not satisfy 127.0.0.1 readiness"
    );
}

#[test]
fn child_exit_propagates_the_exit_code() {
    let _guard = serial();
    let config = test_config("/bin/sh", &["-c", "exit 7"], free_addr());
    assert_eq!(supervise(&config, |_| true), 7);
}

#[test]
fn child_exit_before_readiness_propagates_the_exit_code() {
    let _guard = serial();
    let config = test_config("/bin/sh", &["-c", "exit 5"], free_addr());
    assert_eq!(supervise(&config, |_| false), 5);
}

#[test]
fn sigterm_escalates_to_sigkill_after_the_stop_timeout() {
    let _guard = serial();
    let mut config = test_config(
        "/bin/sh",
        &["-c", "trap '' TERM; while :; do sleep 0.05; done"],
        free_addr(),
    );
    config.stop_timeout = Duration::from_millis(200);

    let handle = std::thread::spawn(move || supervise(&config, |_| true));
    std::thread::sleep(Duration::from_millis(300));

    let pid = std::process::id() as libc::pid_t;
    unsafe {
        assert_eq!(libc::kill(pid, libc::SIGTERM), 0, "signal the supervisor");
    }

    let started = Instant::now();
    let code = handle.join().expect("supervisor thread");
    assert_eq!(code, 137, "the engine ignored SIGTERM and was killed");
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "escalation must stay bounded by the stop timeout"
    );
}

#[test]
fn readiness_timeout_kills_the_child_and_exits_one() {
    let _guard = serial();
    let mut config = test_config("/bin/sh", &["-c", "exec sleep 30"], free_addr());
    config.ready_timeout = Duration::from_millis(200);

    let started = Instant::now();
    assert_eq!(supervise(&config, |_| false), 1);
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "readiness timeout must not outlive the timeout plus cleanup"
    );
}

#[test]
fn notify_watchdog_and_sigterm_sequence() {
    let _guard = serial();
    let socket_path =
        std::env::temp_dir().join(format!("iii-supervisor-notify-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket_path);
    let receiver = UnixDatagram::bind(&socket_path).expect("bind notify socket");
    receiver
        .set_read_timeout(Some(Duration::from_millis(100)))
        .expect("set read timeout");

    std::env::set_var("NOTIFY_SOCKET", &socket_path);
    std::env::set_var("WATCHDOG_USEC", "200000");
    std::env::set_var("WATCHDOG_PID", std::process::id().to_string());

    let config = test_config("/bin/sh", &["-c", "exec sleep 30"], free_addr());
    let handle = std::thread::spawn(move || supervise(&config, |_| true));

    let mut ready = false;
    let mut status = false;
    let mut watchdog = false;
    let mut buffer = [0u8; 4096];
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && !(ready && status && watchdog) {
        let Ok(size) = receiver.recv(&mut buffer) else {
            continue;
        };
        for line in String::from_utf8_lossy(&buffer[..size]).lines() {
            ready |= line == "READY=1";
            status |= line.starts_with("STATUS=listening on 127.0.0.1:");
            watchdog |= line == "WATCHDOG=1";
        }
    }

    let pid = std::process::id() as libc::pid_t;
    unsafe {
        assert_eq!(libc::kill(pid, libc::SIGTERM), 0, "signal the supervisor");
    }

    let mut stopping = false;
    let stop_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < stop_deadline && !stopping {
        let Ok(size) = receiver.recv(&mut buffer) else {
            continue;
        };
        for line in String::from_utf8_lossy(&buffer[..size]).lines() {
            stopping |= line == "STOPPING=1";
        }
    }

    let code = handle.join().expect("supervisor thread");

    std::env::remove_var("NOTIFY_SOCKET");
    std::env::remove_var("WATCHDOG_USEC");
    std::env::remove_var("WATCHDOG_PID");
    let _ = std::fs::remove_file(&socket_path);

    assert!(ready, "READY=1 must be sent after readiness");
    assert!(
        status,
        "STATUS=listening on <addr> must be sent after readiness"
    );
    assert!(
        watchdog,
        "WATCHDOG=1 must be sent at half the advertised interval"
    );
    assert!(stopping, "STOPPING=1 must be sent on SIGTERM");
    assert_eq!(code, 143, "SIGTERM is forwarded to the engine");
}

#[test]
fn watchdog_interval_is_half_the_advertised_interval() {
    let _guard = serial();
    std::env::remove_var("WATCHDOG_USEC");
    std::env::remove_var("WATCHDOG_PID");
    assert_eq!(watchdog_interval(), None);

    std::env::set_var("WATCHDOG_USEC", "200000");
    std::env::set_var("WATCHDOG_PID", std::process::id().to_string());
    assert_eq!(watchdog_interval(), Some(Duration::from_millis(100)));

    std::env::set_var("WATCHDOG_PID", (std::process::id() + 1).to_string());
    assert_eq!(watchdog_interval(), None);

    std::env::remove_var("WATCHDOG_USEC");
    std::env::remove_var("WATCHDOG_PID");
}
