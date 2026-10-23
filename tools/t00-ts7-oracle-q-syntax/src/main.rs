use serde_json::Value;
use std::io::{Read, Write};

mod extraction;
mod outline;
mod syntax;

fn run() -> Result<Value, String> {
    if std::env::var_os("GOPORT_BUILD_VERSION").is_some() {
        return Err("GOPORT_BUILD_VERSION must be absent".into());
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let input: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let sdk = input["sdk_directory"]
        .as_str()
        .ok_or("explicit sdk_directory required")?;
    let count = std::fs::read_dir(sdk)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("lib.") && name.ends_with(".d.ts"))
        })
        .count();
    if count != 115 {
        return Err(format!(
            "SDK requires 115 declaration libraries, found {count}"
        ));
    }
    let _program = ts_goport::core::enter_program(None);
    let observation = match input["operation"].as_str() {
        Some("syntax") => syntax::observe(&input),
        Some("outline") => outline::observe(&input),
        Some("extraction") => extraction::observe(&input),
        _ => Err("unsupported oracle operation".into()),
    }?;
    Ok(
        serde_json::json!({"compilerVersion":ts_goport::core::version(),"sourceRevision":"780dc512d64f40afebffa6a7028207649fb7ed1c","sdkLibraryCount":count,"observation":observation}),
    )
}

fn main() {
    match run() {
        Ok(value) => {
            let result = serde_json::to_writer(std::io::stdout().lock(), &value);
            if let Err(error) = result {
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
