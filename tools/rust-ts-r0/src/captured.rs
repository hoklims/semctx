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
mod tests {
    use super::*;
    #[test]
    fn captured_bytes_are_read_and_missing_live_paths_stay_absent() {
        let capture = Captured::new(BTreeMap::from([(
            "/repo/a.ts".into(),
            "export const a = 1;".into(),
        )]));
        assert_eq!(capture.read("/repo/a.ts"), Some("export const a = 1;"));
        assert_eq!(capture.read("/etc/passwd"), None);
    }
}
