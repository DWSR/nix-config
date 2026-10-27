//! Process entry point: forward argv to the library and exit with its code.

fn main() {
    std::process::exit(kiro_spec::run(std::env::args_os()));
}
