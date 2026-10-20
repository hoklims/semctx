use std::collections::BTreeMap;

pub struct Captured {
    files: BTreeMap<String, String>,
}

impl Captured {
    pub fn new(files: BTreeMap<String, String>) -> Self {
        Self { files }
    }
    pub fn read(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(String::as_str)
    }
}

#[cfg(test)]
#[path = "../tests/unit/captured.rs"]
mod tests;
