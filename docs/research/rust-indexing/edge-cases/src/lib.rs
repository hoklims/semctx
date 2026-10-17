use semctx_edge_macros::define_procedural;

macro_rules! define_declarative {
    () => {
        pub fn declarative() -> u32 {
            7
        }
    };
}

define_declarative!();
define_procedural!();
include!(concat!(env!("OUT_DIR"), "/generated.rs"));

#[cfg(not(feature = "alternate"))]
pub fn configured() -> u32 {
    1
}

#[cfg(feature = "alternate")]
pub fn configured() -> u32 {
    2
}

#[cfg(unix)]
pub fn platform() -> u32 {
    3
}

#[cfg(windows)]
pub fn platform() -> u32 {
    4
}

pub fn concrete() -> u32 {
    5
}

pub fn call_function_value(callback: fn() -> u32) -> u32 {
    callback()
}

pub fn evaluate() -> u32 {
    let callback: fn() -> u32 = concrete;
    declarative()
        + procedural()
        + generated()
        + call_function_value(callback)
        + configured()
        + platform()
}

#[cfg(feature = "invalid")]
pub mod invalid;
