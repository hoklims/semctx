//! Supervisor-only ordinary physical acquisition. C1 and retained maps are unchanged.
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, Metadata},
    io::Read,
    path::{Path, PathBuf},
    time::SystemTime,
};
const MAX_FILES: usize = 4096;
const MAX_FILE: u64 = 4_194_304;
const MAX_TOTAL: usize = 33_554_432;
#[derive(Clone, Copy)]
pub enum Context {
    OrdinaryWorkspace,
    RetainedMap,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
    native: String,
}
#[derive(Clone, Debug)]
pub struct PhysicalPin {
    pub relative: String,
    pub absolute: String,
    pub bytes: Option<Vec<u8>>,
    stamp: Option<Stamp>,
}
pub struct Capture {
    pub files: BTreeMap<String, String>,
    pub pins: Vec<PhysicalPin>,
    root: PathBuf,
}
fn stamp(m: &Metadata) -> Stamp {
    #[cfg(unix)]
    let native = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", m.dev(), m.ino())
    };
    #[cfg(windows)]
    let native = {
        use std::os::windows::fs::MetadataExt;
        format!("{}:{}", m.creation_time(), m.file_attributes())
    };
    #[cfg(not(any(unix, windows)))]
    let native = String::new();
    Stamp {
        len: m.len(),
        modified: m.modified().ok(),
        native,
    }
}
fn link(m: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    m.file_type().is_symlink()
}
fn relative(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('\\')
        || name.contains(':')
        || name.starts_with('/')
        || name
            .split('/')
            .any(|p| p.is_empty() || [".", "..", ".git", ".semctx"].contains(&p))
    {
        return Err("ORDINARY_PHYSICAL_QUERY_OUTSIDE_ROOT".into());
    }
    Ok(())
}
fn checked_root(root: &Path) -> Result<PathBuf, String> {
    let m = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
    if link(&m) || !m.is_dir() {
        return Err("ORDINARY_PHYSICAL_ROOT_LINK_OR_NOT_DIRECTORY".into());
    }
    root.canonicalize().map_err(|e| e.to_string())
}
fn snapshot(root: &Path, name: &str) -> Result<PhysicalPin, String> {
    relative(name)?;
    let mut target = root.to_path_buf();
    let parts = name.split('/').collect::<Vec<_>>();
    for (index, part) in parts.iter().enumerate() {
        target.push(part);
        match fs::symlink_metadata(&target) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(PhysicalPin {
                    relative: name.into(),
                    absolute: root.join(name).to_string_lossy().replace('\\', "/"),
                    bytes: None,
                    stamp: None,
                });
            }
            Err(e) => return Err(e.to_string()),
            Ok(m) => {
                if link(&m) {
                    return Err("ORDINARY_PHYSICAL_LINK_UNSUPPORTED".into());
                }
                if index + 1 < parts.len() && !m.is_dir() {
                    return Err("ORDINARY_PHYSICAL_ANCESTOR_NOT_DIRECTORY".into());
                }
                if index + 1 == parts.len() && !m.is_file() {
                    return Err("ORDINARY_PHYSICAL_SOURCE_NOT_REGULAR".into());
                }
            }
        }
    }
    let canonical = target.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root) {
        return Err("ORDINARY_PHYSICAL_SOURCE_OUTSIDE_ROOT".into());
    }
    let file = File::open(&target).map_err(|e| e.to_string())?;
    let before = stamp(&file.metadata().map_err(|e| e.to_string())?);
    if before.len > MAX_FILE {
        return Err("ORDINARY_PHYSICAL_FILE_LIMIT".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("ORDINARY_PHYSICAL_FILE_LIMIT".into());
    }
    let m = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
    if link(&m)
        || !m.is_file()
        || stamp(&m) != before
        || target.canonicalize().map_err(|e| e.to_string())? != canonical
        || bytes.len() as u64 != before.len
    {
        return Err("ORDINARY_PHYSICAL_CHANGED_DURING_READ".into());
    }
    String::from_utf8(bytes.clone())
        .map_err(|_| "ORDINARY_PHYSICAL_UTF8_UNSUPPORTED".to_string())?;
    Ok(PhysicalPin {
        relative: name.into(),
        absolute: canonical.to_string_lossy().replace('\\', "/"),
        bytes: Some(bytes),
        stamp: Some(before),
    })
}
pub fn capture(root: &Path, names: &[String]) -> Result<Capture, String> {
    capture_context(root, names, Context::OrdinaryWorkspace)
}
pub fn capture_context(root: &Path, names: &[String], context: Context) -> Result<Capture, String> {
    if !matches!(context, Context::OrdinaryWorkspace) {
        return Err("ORDINARY_PHYSICAL_RETAINED_MAP_CONTEXT_UNSUPPORTED".into());
    }
    if names.is_empty() || names.len() > MAX_FILES {
        return Err("ORDINARY_PHYSICAL_QUERY_LIMIT".into());
    }
    let root = checked_root(root)?;
    let mut files = BTreeMap::new();
    let mut pins = vec![];
    let mut seen = BTreeSet::new();
    let mut total = 0usize;
    for name in names {
        let p = snapshot(&root, name)?;
        if !seen.insert(p.absolute.clone()) {
            return Err("ORDINARY_PHYSICAL_DUPLICATE_QUERY".into());
        }
        if let Some(bytes) = &p.bytes {
            total = total
                .checked_add(bytes.len())
                .ok_or("ORDINARY_PHYSICAL_TOTAL_LIMIT")?;
            if total > MAX_TOTAL {
                return Err("ORDINARY_PHYSICAL_TOTAL_LIMIT".into());
            }
            files.insert(
                p.absolute.clone(),
                String::from_utf8(bytes.clone())
                    .map_err(|_| "ORDINARY_PHYSICAL_UTF8_UNSUPPORTED")?,
            );
        }
        pins.push(p);
    }
    let result = Capture { files, pins, root };
    result.validate()?;
    Ok(result)
}
impl Capture {
    /// Validate again after native invocation; actual missing paths remain pinned absences.
    pub fn validate(&self) -> Result<(), String> {
        self.observe_unchanged().map(|_| ())
    }
    pub fn observe_unchanged(&self) -> Result<Vec<PhysicalPin>, String> {
        if checked_root(&self.root)? != self.root {
            return Err("ORDINARY_PHYSICAL_ROOT_CHANGED".into());
        }
        let mut after = vec![];
        for old in &self.pins {
            let now = snapshot(&self.root, &old.relative)?;
            if now.absolute != old.absolute || now.bytes != old.bytes || now.stamp != old.stamp {
                return Err("ORDINARY_PHYSICAL_INPUT_CHANGED".into());
            }
            after.push(now);
        }
        Ok(after)
    }
}

#[cfg(test)]
mod comparator_tests {
    fn fresh(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ordinary-physical-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }
    #[test]
    fn old_empty_capture_must_not_hide_four_actual_files() {
        let root =
            std::env::temp_dir().join(format!("ordinary-physical-red-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("build")).unwrap();
        let names = [
            ".gitignore",
            "build/generated.ts",
            "src/consumer.ts",
            "src/main.ts",
        ];
        for name in names {
            std::fs::write(root.join(name), format!("actual source {name}\n")).unwrap();
        }
        let relative = names.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let value = super::capture(&root, &relative).unwrap();
        assert_eq!(
            value.files.len(),
            4,
            "the old qualified-discovery collector supplies files:{{}} despite four actual sources"
        );
    }
    #[test]
    fn actual_bytes_not_recipe_values_are_captured() {
        let root = fresh("bytes");
        std::fs::write(root.join("a.ts"), b"actual disk bytes").unwrap();
        let c = super::capture(&root, &["a.ts".into()]).unwrap();
        assert_eq!(c.files.values().next().unwrap(), "actual disk bytes");
        assert_eq!(c.pins[0].bytes.as_ref().unwrap(), b"actual disk bytes");
        c.validate().unwrap();
    }
    #[test]
    fn drift_after_capture_is_not_success() {
        let root = fresh("drift");
        std::fs::write(root.join("a.ts"), b"before").unwrap();
        let c = super::capture(&root, &["a.ts".into()]).unwrap();
        std::fs::write(root.join("a.ts"), b"after!").unwrap();
        assert!(c.observe_unchanged().is_err());
    }
    #[test]
    fn missing_file_stays_negative_and_new_presence_invalidates() {
        let root = fresh("absence");
        let c = super::capture(&root, &["missing.ts".into()]).unwrap();
        assert!(c.files.is_empty());
        assert!(c.pins[0].bytes.is_none());
        c.validate().unwrap();
        std::fs::write(root.join("missing.ts"), b"appeared").unwrap();
        assert!(c.validate().is_err());
    }
    #[test]
    fn lexical_outside_and_retained_context_are_unsupported() {
        let root = fresh("context");
        std::fs::write(root.join("a.ts"), b"ordinary").unwrap();
        assert!(super::capture(&root, &["../outside.ts".into()]).is_err());
        assert!(
            super::capture_context(&root, &["a.ts".into()], super::Context::RetainedMap).is_err()
        );
    }
    #[test]
    fn invalid_utf8_is_structured_unsupported() {
        let root = fresh("utf8");
        std::fs::write(root.join("bad.ts"), [0xff]).unwrap();
        assert!(
            super::capture(&root, &["bad.ts".into()])
                .err()
                .unwrap()
                .contains("UTF8_UNSUPPORTED")
        );
    }
    #[test]
    fn oversize_file_is_bounded_refusal() {
        let root = fresh("size");
        let f = std::fs::File::create(root.join("large.ts")).unwrap();
        f.set_len(4_194_305).unwrap();
        assert!(
            super::capture(&root, &["large.ts".into()])
                .err()
                .unwrap()
                .contains("FILE_LIMIT")
        );
    }
    #[test]
    fn linked_ancestor_and_linked_root_are_refused() {
        let root = fresh("links");
        let outside = fresh("linktarget");
        std::fs::write(outside.join("a.ts"), b"external bytes").unwrap();
        let link = root.join("linked");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(&outside, &link).is_err() {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(
                status.status.success(),
                "cannot establish actual reparse-point negative control"
            );
        }
        assert!(super::capture(&root, &["linked/a.ts".into()]).is_err());
        assert!(super::capture(&link, &["a.ts".into()]).is_err());
    }
}
