//! Process entry point for `kiro-spec`.
//!
//! All work happens in the library so tests and downstream consumers share the
//! same code path; this file only maps the returned code onto the process.

fn main() {
    std::process::exit(kiro_spec::run(std::env::args_os()));
}
