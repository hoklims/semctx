#[cfg(any(test, feature = "qualification-observer"))]
use super::*;

pub struct SourceIdentity {
    sensitive: bool,
    native: bool,
    #[cfg(any(test, feature = "qualification-observer"))]
    failures: BTreeMap<String, Stage>,
    #[cfg(any(test, feature = "qualification-observer"))]
    trace: RefCell<Vec<serde_json::Value>>,
}

#[cfg(any(test, feature = "qualification-observer"))]
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Stage {
    NativeRealpath,
    Absolute,
}

impl SourceIdentity {
    pub fn new(sensitive: bool, native: bool) -> Self {
        Self {
            sensitive,
            native,
            #[cfg(any(test, feature = "qualification-observer"))]
            failures: BTreeMap::new(),
            #[cfg(any(test, feature = "qualification-observer"))]
            trace: RefCell::new(vec![]),
        }
    }

    pub fn key(&self, path: &str) -> String {
        #[cfg(any(test, feature = "qualification-observer"))]
        let forced = self.failures.get(path).copied();
        #[cfg(not(any(test, feature = "qualification-observer")))]
        let forced: Option<()> = None;
        let (canonical, _failed_stage) = if self.native {
            #[cfg(any(test, feature = "qualification-observer"))]
            let force_native = matches!(forced, Some(Stage::NativeRealpath));
            #[cfg(not(any(test, feature = "qualification-observer")))]
            let force_native = false;
            let native = if force_native {
                Err(())
            } else {
                ts_goport::frontend::nativepath::realpath(path).map_err(|_| ())
            };
            match native {
                Err(()) => (path.to_owned(), Some("native_realpath")),
                Ok(native) => {
                    #[cfg(any(test, feature = "qualification-observer"))]
                    let force_absolute = matches!(forced, Some(Stage::Absolute));
                    #[cfg(not(any(test, feature = "qualification-observer")))]
                    let force_absolute = false;
                    let absolute = if force_absolute {
                        Err(())
                    } else {
                        std::path::absolute(native).map_err(|_| ())
                    };
                    match absolute {
                        Ok(path) => (path.to_string_lossy().replace('\\', "/"), None),
                        Err(()) => (path.to_owned(), Some("absolute")),
                    }
                }
            }
        } else {
            (path.to_owned(), None)
        };
        let normalized = ts_goport::frontend::tspath::normalize_path(&canonical);
        let key = if self.sensitive {
            normalized
        } else {
            normalized.to_lowercase()
        };
        #[cfg(any(test, feature = "qualification-observer"))]
        self.trace.borrow_mut().push(serde_json::json!({"path":path,"key":key,"failedStage":_failed_stage,"injected":forced.is_some()}));
        #[cfg(not(any(test, feature = "qualification-observer")))]
        let _ = forced;
        key
    }

    pub fn observation(&self) -> serde_json::Value {
        #[cfg(any(test, feature = "qualification-observer"))]
        return serde_json::json!({"enabled":self.native,"trace":self.trace.borrow().clone()});
        #[cfg(not(any(test, feature = "qualification-observer")))]
        serde_json::Value::Null
    }
}

#[cfg(any(test, feature = "qualification-observer"))]
pub fn run(value: serde_json::Value, sdk: &Sdk) -> serde_json::Value {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Descriptor {
        kind: String,
        request: serde_json::Value,
        #[serde(default)]
        failures: BTreeMap<String, Stage>,
    }
    let result = (|| -> Result<serde_json::Value, String> {
        let descriptor: Descriptor =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let sensitive = ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names();
        let root = match descriptor.kind.as_str() {
            "direct" => descriptor.request["cwd"].as_str(),
            "worker" => descriptor.request["repoRoot"].as_str(),
            _ => return Err("SOURCE_IDENTITY_KIND_INVALID".into()),
        }
        .ok_or("SOURCE_IDENTITY_ROOT_REQUIRED")?;
        for path in descriptor.failures.keys() {
            relative_source_path(root, path, sensitive)?;
        }
        let mut identity = SourceIdentity::new(sensitive, true);
        identity.failures = descriptor.failures;
        match descriptor.kind.as_str() {
            "direct" => {
                let request: Request = serde_json::from_value(descriptor.request)
                    .map_err(|error| error.to_string())?;
                if request.retained || request.qualified {
                    return Err("SOURCE_IDENTITY_LIVE_ONLY".into());
                }
                analyze_with_identity(request, sdk.clone(), identity)
            }
            "worker" => Ok(worker_observations::run_with_identity(
                descriptor.request,
                sdk,
                identity,
            )),
            _ => unreachable!(),
        }
    })();
    result.unwrap_or_else(|error| serde_json::json!({"executed":false,"error":error}))
}

#[cfg(test)]
#[path = "../tests/unit/source_identity.rs"]
mod tests;
