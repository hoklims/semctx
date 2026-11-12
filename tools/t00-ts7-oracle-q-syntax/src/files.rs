use std::{
    collections::{BTreeMap, BTreeSet},
    time::SystemTime,
};
use ts_goport::frontend::vfs::{Entries, FileInfo, FileMode, Fs, FsError};

pub struct Files(pub BTreeMap<String, String>);

impl Fs for Files {
    fn use_case_sensitive_file_names(&self) -> bool {
        true
    }
    fn file_exists(&self, path: &str) -> bool {
        self.0.contains_key(path)
    }
    fn read_file(&self, path: &str) -> (String, bool) {
        self.0
            .get(path)
            .map(|text| (text.clone(), true))
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
        self.0.keys().any(|file| file.starts_with(&prefix))
    }
    fn get_accessible_entries(&self, path: &str) -> Entries {
        let prefix = format!("{}/", path.trim_end_matches('/'));
        let mut files = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for name in self.0.keys().filter_map(|file| file.strip_prefix(&prefix)) {
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
            size: self.0.get(path).map_or(0, |text| text.len() as i64),
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
