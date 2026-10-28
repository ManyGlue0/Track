#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `track --hook <event>` is the Claude Code hook: it reports to the running
    // Track and exits, before any window or single-instance check exists.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--hook") {
        let rest = args.get(3..).unwrap_or(&[]);
        std::process::exit(track_lib::hook::run_client(args.get(2).map(String::as_str).unwrap_or(""), rest));
    }
    // `track --elevated-host <pipe> <token>` is Track's own administrator
    // helper, started elevated by a running Track (see elevated.rs).
    if args.get(1).map(String::as_str) == Some("--elevated-host") {
        std::process::exit(track_lib::elevated::run_host(args.get(2..).unwrap_or(&[])));
    }
    track_lib::run()
}
