use crate::identity;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const FIXED: &[&str] = &[
    "bun.lock",
    "tsconfig.json",
    "tsconfig.base.json",
    "scripts/analyzer-identity.ts",
    "scripts/build-plugin-runtime.ts",
    "scripts/build-cli-package.ts",
];
const GENERATED: &str = "packages/app-services/src/analyzer-identity-generated.ts";
const CAPTURE_LIMIT: usize = 67_108_864;

#[derive(Serialize)]
struct FileDigest {
    path: String,
    digest: String,
}
#[derive(Serialize)]
struct Compiler {
    version: String,
    digest: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema_version: u8,
    files: Vec<FileDigest>,
    compiler: Compiler,
}
#[derive(Serialize)]
struct CompilerInputs {
    entry: String,
    libraries: Vec<FileDigest>,
}
#[derive(Deserialize)]
struct Package {
    name: String,
    version: String,
}
#[derive(Deserialize)]
struct LibraryInventory {
    libraries: Vec<LibraryPath>,
}
#[derive(Deserialize)]
struct LibraryPath {
    path: String,
}
#[derive(Default)]
struct Capture {
    reads: Vec<Value>,
    bytes: usize,
}

fn entries(root: &Path, relative: &str) -> Result<Vec<fs::DirEntry>, String> {
    let error = |error| format!("LEGACY_IDENTITY_DIRECTORY_READ_FAILED:{relative}:{error}");
    let directory = root.join(relative).canonicalize().map_err(error)?;
    if !directory.starts_with(root) {
        return Err(format!("LEGACY_IDENTITY_OUTSIDE_ROOT:{relative}"));
    }
    let mut entries = fs::read_dir(directory)
        .map_err(error)?
        .map(|entry| entry.map_err(error))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in &entries {
        if entry.file_type().map_err(error)?.is_symlink() {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "LEGACY_IDENTITY_PATH_NOT_UTF8")?;
            confined_path(root, &format!("{relative}/{name}"))?;
        }
    }
    Ok(entries)
}
fn confined_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let actual = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("LEGACY_IDENTITY_READ_FAILED:{relative}:{error}"))?;
    if !actual.starts_with(root) {
        return Err(format!("LEGACY_IDENTITY_OUTSIDE_ROOT:{relative}"));
    }
    Ok(actual)
}
fn sources(root: &Path, directory: &str, paths: &mut BTreeSet<String>) -> Result<(), String> {
    let mut pending = vec![directory.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in entries(root, &directory)? {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "LEGACY_IDENTITY_PATH_NOT_UTF8")?;
            let path = format!("{directory}/{name}");
            let kind = entry
                .file_type()
                .map_err(|e| format!("LEGACY_IDENTITY_DIRECTORY_READ_FAILED:{path}:{e}"))?;
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file()
                && path != GENERATED
                && [".ts", ".js", ".mjs"]
                    .iter()
                    .any(|extension| name.ends_with(extension))
            {
                paths.insert(path);
            }
        }
    }
    Ok(())
}
impl Capture {
    fn read(&mut self, root: &Path, relative: &str, domain: &str) -> Result<Vec<u8>, String> {
        let error = |error| format!("LEGACY_IDENTITY_READ_FAILED:{relative}:{error}");
        let actual = confined_path(root, relative)?;
        let file = fs::File::open(&actual).map_err(error)?;
        let remaining = CAPTURE_LIMIT - self.bytes;
        let mut bytes = vec![];
        file.take((remaining + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(error)?;
        if bytes.len() > remaining {
            return Err("LEGACY_IDENTITY_CAPTURE_LIMIT".into());
        }
        self.bytes += bytes.len();
        self.reads.push(json!({"domain":domain,"path":relative,"bytes":bytes.len(),"digest":identity::digest_bytes(&bytes)}));
        Ok(bytes)
    }
    fn identity(&mut self, root: &Path, sdk: &Path) -> Result<Value, String> {
        let root = root
            .canonicalize()
            .map_err(|e| format!("LEGACY_IDENTITY_ROOT_UNAVAILABLE:{e}"))?;
        let mut paths = FIXED
            .iter()
            .map(|s| (*s).to_owned())
            .collect::<BTreeSet<_>>();
        for entry in entries(&root, "packages")? {
            if !entry
                .file_type()
                .map_err(|e| format!("LEGACY_IDENTITY_DIRECTORY_READ_FAILED:packages:{e}"))?
                .is_dir()
            {
                continue;
            }
            let directory = format!(
                "packages/{}",
                entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "LEGACY_IDENTITY_PATH_NOT_UTF8")?
            );
            paths.insert(format!("{directory}/package.json"));
            sources(&root, &format!("{directory}/src"), &mut paths)?;
        }
        paths.insert("apps/cli/package.json".into());
        sources(&root, "apps/cli/src", &mut paths)?;
        let mut paths = paths.into_iter().collect::<Vec<_>>();
        paths.sort_by_key(|p| p.encode_utf16().collect::<Vec<_>>());
        let mut files = vec![];
        for path in paths {
            let bytes = self.read(&root, &path, "implementation")?;
            if bytes.windows(2).any(|bytes| bytes == b"\r\n") {
                return Err(format!(
                    "Noncanonical CRLF analyzer input: {path}; use the LF checkout required by .gitattributes before generating."
                ));
            }
            files.push(FileDigest {
                path,
                digest: identity::digest_bytes(&bytes),
            });
        }
        let sdk = sdk
            .canonicalize()
            .map_err(|e| format!("LEGACY_IDENTITY_SDK_UNAVAILABLE:{e}"))?;
        let package_bytes = self.read(&sdk, "package.json", "compiler")?;
        let package: Package = serde_json::from_slice(&package_bytes)
            .map_err(|e| format!("LEGACY_IDENTITY_SDK_INVALID:{e}"))?;
        if package.name != "typescript" || package.version != "5.9.3" {
            return Err("LEGACY_IDENTITY_SDK_VERSION_MISMATCH".into());
        }
        let mut library_paths = vec![];
        for entry in entries(&sdk, "lib")? {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "LEGACY_IDENTITY_PATH_NOT_UTF8")?;
            if name.starts_with("lib") && name.ends_with(".d.ts") {
                library_paths.push(name);
            }
        }
        let inventory: LibraryInventory = serde_json::from_str(include_str!(
            "../../../docs/research/rust-ts-r0/cases/upstream/typescript/sdk-manifest.json"
        ))
        .map_err(|e| format!("LEGACY_IDENTITY_SDK_INVENTORY_INVALID:{e}"))?;
        let expected = inventory
            .libraries
            .into_iter()
            .map(|library| {
                library
                    .path
                    .strip_prefix("lib/")
                    .map(str::to_owned)
                    .ok_or_else(|| "LEGACY_IDENTITY_SDK_INVENTORY_INVALID:library path".to_owned())
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let actual = library_paths.iter().cloned().collect::<BTreeSet<_>>();
        let missing = expected.difference(&actual).collect::<Vec<_>>();
        let extra = actual.difference(&expected).collect::<Vec<_>>();
        if !missing.is_empty() || !extra.is_empty() {
            return Err(format!(
                "LEGACY_IDENTITY_SDK_INVENTORY_MISMATCH:missing={};extra={}",
                json!(missing),
                json!(extra)
            ));
        }
        library_paths.push("../package.json".to_owned());
        library_paths.sort_by_key(|p| p.encode_utf16().collect::<Vec<_>>());
        let entry = identity::digest_bytes(&self.read(&sdk, "lib/typescript.js", "compiler")?);
        let mut libraries = vec![];
        for path in library_paths {
            let bytes = if path == "../package.json" {
                package_bytes.clone()
            } else {
                self.read(&sdk, &format!("lib/{path}"), "compiler")?
            };
            libraries.push(FileDigest {
                path,
                digest: identity::digest_bytes(&bytes),
            });
        }
        let compiler_inputs = CompilerInputs { entry, libraries };
        let compiler_bytes = serde_json::to_vec(&compiler_inputs).map_err(|e| e.to_string())?;
        let manifest = Manifest {
            schema_version: 1,
            files,
            compiler: Compiler {
                version: package.version,
                digest: identity::digest_bytes(&compiler_bytes),
            },
        };
        let manifest_bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        let mut value = serde_json::to_value(&manifest).map_err(|e| e.to_string())?;
        value["digest"] = json!(identity::digest_bytes(&manifest_bytes));
        Ok(json!({"identity":value,"compiler_inputs":compiler_inputs}))
    }
}
pub(crate) fn observe(root: PathBuf, sdk: PathBuf) -> Value {
    let mut capture = Capture::default();
    let result = capture.identity(&root, &sdk);
    let mut value = json!({"identity_scope":"baseline_3e94997f_implementation_and_compiler_bytes","compiler_executed":false,"compiler_version_source":"pinned5.9.3 package.json, not C1 compiler version","global_admission_inferred":false,"reads":capture.reads,"identity_success":result.is_ok()});
    match result {
        Ok(observed) => {
            value["identity"] = observed["identity"].clone();
            value["compiler_inputs"] = observed["compiler_inputs"].clone();
        }
        Err(error) => value["error"] = json!(error),
    }
    value
}
