use std::io::Write;
fn run(path: &str) -> Result<serde_json::Value, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let input = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    t00_ts7_oracle_emit_helpers::observe(&input)
}
fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.len() != 1 {
        eprintln!("usage: t00-ts7-oracle-emit-helpers REQUEST.json");
        std::process::exit(2);
    }
    let result = std::thread::Builder::new()
        .stack_size(16 * 1024 * 1024)
        .spawn(move || run(&arguments[0]));
    let result = result
        .map_err(|error| error.to_string())
        .and_then(|thread| {
            thread
                .join()
                .map_err(|_| "upstream oracle worker panicked".to_string())?
        });
    match result {
        Ok(value) => {
            if let Err(error) = serde_json::to_writer(std::io::stdout().lock(), &value) {
                let _ = writeln!(std::io::stderr(), "{error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "{error}");
            std::process::exit(1);
        }
    }
}
