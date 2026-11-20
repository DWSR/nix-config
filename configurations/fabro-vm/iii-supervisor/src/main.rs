use std::ffi::OsString;
use std::process::exit;

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match iii_supervisor::parse_args(args) {
        Ok(config) => exit(iii_supervisor::run(&config)),
        Err(message) => {
            eprintln!("iii-supervisor: {message}");
            eprintln!(
                "usage: iii-supervisor --listen <ip:port> --ready-timeout <secs> --stop-timeout <secs> -- <engine> <args...>"
            );
            exit(2);
        }
    }
}
