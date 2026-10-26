use std::{
    collections::{BTreeMap, BTreeSet},
    time::SystemTime,
};
use ts_goport::frontend::vfs::{Entries, FileInfo, FileMode, Fs, FsError};

pub struct Files(pub BTreeMap<String, String>, pub bool);

impl Files {
    fn entry(&self, path: &str) -> Option<(&String, &String)> {
        self.0.get_key_value(path).or_else(|| {
            (!self.1)
                .then(|| {
                    self.0
                        .iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case(path))
                })
                .flatten()
        })
    }
}

impl Fs for Files {
    fn use_case_sensitive_file_names(&self) -> bool {
        self.1
    }
    fn file_exists(&self, path: &str) -> bool {
        self.entry(path).is_some()
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        self.entry(path)
            .map(|(_, text)| (text.clone(), true))
            .unwrap_or_default()
    }
    fn write_file(&self, _: &str, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn append_file(&self, _: &str, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn remove(&self, _: &str) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn chtimes(
        &self,
        _: &str,
        _: Option<SystemTime>,
        _: Option<SystemTime>,
    ) -> Result<(), FsError> {
        Err(FsError::Permission)
    }
    fn directory_exists(&self, path: &str) -> bool {
        let prefix = format!("{}/", path.trim_end_matches('/'));
        self.0.keys().any(|file| {
            file.starts_with(&prefix)
                || (!self.1
                    && file
                        .to_ascii_lowercase()
                        .starts_with(&prefix.to_ascii_lowercase()))
        })
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        let prefix = format!("{}/", path.trim_end_matches('/'));
        let mut files = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for name in self.0.keys().filter_map(|file| {
            file.strip_prefix(&prefix).or_else(|| {
                (!self.1
                    && file
                        .to_ascii_lowercase()
                        .starts_with(&prefix.to_ascii_lowercase()))
                .then(|| &file[prefix.len()..])
            })
        }) {
            match name.split_once('/') {
                Some((directory, _)) => {
                    directories.insert(directory.to_string());
                }
                None => {
                    files.insert(name.to_string());
                }
            }
        }
        Entries {
            files: files.into_iter().collect(),
            directories: directories.into_iter().collect(),
            symlinks: None,
        }
    }
    fn stat(&self, path: &str) -> Option<FileInfo> {
        let directory = self.directory_exists(path);
        if !directory && !self.file_exists(path) {
            return None;
        }
        Some(FileInfo {
            name: path.rsplit('/').next().unwrap_or_default().into(),
            size: self.entry(path).map_or(0, |(_, text)| text.len() as i64),
            mode: if directory {
                FileMode::DIR
            } else {
                FileMode(0)
            },
            mod_time: None,
        })
    }
    fn realpath(&self, path: &str) -> String {
        path.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn distinguishes_case_sensitive_and_insensitive_virtual_filesystems() {
        let contents = BTreeMap::from([("/project/Leaf.ts".into(), "export {};".into())]);
        let sensitive = Files(contents.clone(), true);
        let insensitive = Files(contents, false);
        assert!(!sensitive.file_exists("/project/leaf.ts"));
        assert!(insensitive.file_exists("/project/leaf.ts"));
        assert_eq!(
            insensitive.read_file("/PROJECT/leaf.ts"),
            ("export {};".into(), true)
        );
        assert!(insensitive.directory_exists("/PROJECT"));
        assert_eq!(
            insensitive.get_accessible_entries("/PROJECT").files,
            vec!["Leaf.ts"]
        );
    }
}
