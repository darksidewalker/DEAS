//! CPU-only protocol/lifecycle fixture. Never performs AI inference.
use std::{
    io::{Read, Write},
    time::Duration,
};
fn main() {
    let mode = std::env::var("DEAS_FIXTURE_MODE").unwrap();
    #[cfg(unix)]
    unsafe {
        if mode == "hang" || mode == "stallstdin" {
            signal(15, 1);
        }
    }
    if mode == "stallstdin" {
        loop {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    if let Ok(path) = std::env::var("DEAS_FIXTURE_READY") {
        std::fs::write(path, std::process::id().to_string()).unwrap();
    }
    if mode == "hang" || mode == "wait" {
        loop {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    if mode == "fail" {
        std::process::exit(1);
    }
    if mode == "noise" {
        for _ in 0..100 {
            print!("{}", "x".repeat(1024));
        }
        return;
    }
    if mode == "error" {
        println!("{{\"version\":1,\"event\":\"error\"}}");
        std::process::exit(1);
    }
    let version = if mode == "badversion" { 2 } else { 1 };
    println!("{{\"version\":{version},\"event\":\"running\"}}");
    if mode == "double" {
        println!("{{\"version\":1,\"event\":\"running\"}}");
    }
    std::io::stdout().flush().unwrap();
    if let Ok(path) = std::env::var("DEAS_FIXTURE_TOUCH") {
        std::fs::write(path, b"changed").unwrap();
    }
    if let Ok(path) = std::env::var("DEAS_FIXTURE_OUTPUT") {
        if mode == "oversize" {
            std::fs::File::create(path)
                .unwrap()
                .set_len(256 * 1024 * 1024 + 1)
                .unwrap();
        } else if mode == "empty" {
            std::fs::write(path, b"").unwrap();
        } else {
            std::fs::write(path, b"NON-AI fixture output").unwrap();
        }
    }
    let width = if mode == "wrong" { 64 } else { 32 };
    println!(
        "{{\"version\":1,\"event\":\"success\",\"metadata\":{{\"frames\":4,\"width\":{width},\"height\":32}}}}"
    );
}
#[cfg(unix)]
unsafe extern "C" {
    fn signal(sig: i32, handler: usize) -> usize;
}
