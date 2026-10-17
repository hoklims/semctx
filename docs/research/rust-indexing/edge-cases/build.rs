use std::{env, fs, path::PathBuf};

fn main() {
    let destination = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("generated.rs");
    fs::write(destination, "pub fn generated() -> u32 { 13 }\n").unwrap();
    println!("cargo::rerun-if-changed=build.rs");
}
