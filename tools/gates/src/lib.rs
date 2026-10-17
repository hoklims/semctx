pub mod plan;
pub mod process;
pub mod receipt;
pub mod rust_workspace;

pub type Result<T> = std::result::Result<T, String>;

pub fn digest(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
