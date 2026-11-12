use serde_json::Value;

pub fn inspect(
    path: &str,
    root: Option<&str>,
    specifier: &str,
    mut read: impl FnMut(&str) -> Option<String>,
    mut within: impl FnMut(&str, &str) -> bool,
) -> bool {
    let parts = specifier.split('/').collect::<Vec<_>>();
    let package = parts[..if specifier.starts_with('@') {
        parts.len().min(2)
    } else {
        1
    }]
        .join("/");
    let mut directory = ts_goport::frontend::tspath::get_directory_path(path);
    loop {
        if root.is_some_and(|root| !within(root, &directory)) {
            return false;
        }
        if let Some(text) = read(&format!("{directory}/package.json")) {
            let Ok(manifest) = serde_json::from_str::<Value>(&text) else {
                return false;
            };
            if manifest.is_null() || manifest["name"].as_str() == Some(&package) {
                return false;
            }
            for field in [
                "dependencies",
                "devDependencies",
                "peerDependencies",
                "optionalDependencies",
            ] {
                let dependency = match &manifest[field] {
                    Value::Array(values) => package
                        .parse::<usize>()
                        .ok()
                        .filter(|index| index.to_string() == package)
                        .and_then(|index| values.get(index)),
                    Value::Object(values) => values.get(&package),
                    _ => None,
                };
                if let Some(version) = dependency.and_then(Value::as_str) {
                    return !["workspace:", "file:", "link:"]
                        .iter()
                        .any(|prefix| version.starts_with(prefix));
                }
            }
        }
        let parent = ts_goport::frontend::tspath::get_directory_path(&directory);
        if parent == directory {
            return false;
        }
        directory = parent;
    }
}

#[cfg(any(test, feature = "qualification-observer"))]
pub fn observe(input: &Value) -> Result<Value, String> {
    let path = input["path"].as_str().ok_or("path required")?;
    let root = match &input["repository_root"] {
        Value::Null => None,
        Value::String(root) => Some(root.as_str()),
        _ => return Err("repository_root must be a string or absent".into()),
    };
    let specifier = input["specifier"].as_str().ok_or("specifier required")?;
    let mut reads = vec![];
    let external = inspect(
        path,
        root,
        specifier,
        |path| {
            let result = std::fs::read_to_string(path);
            reads.push(serde_json::json!({"path":path.replace("//", "/"),"found":result.is_ok(),"error_kind":result.as_ref().err().map(|e|format!("{:?}",e.kind()))}));
            result.ok()
        },
        |root, directory| std::path::Path::new(directory).starts_with(root),
    );
    Ok(
        serde_json::json!({"external":external,"reads":reads,"system":"native","global_admission_inferred":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::inspect;
    #[test]
    fn manifest_failure_stops_before_parent_and_read_failure_continues() {
        let check = |source: Option<&str>| {
            inspect(
                "/repo/src/main.js",
                Some("/repo"),
                "external/sub",
                |path| {
                    if path == "/repo/src/package.json" {
                        source.map(str::to_owned)
                    } else {
                        Some(r#"{"dependencies":{"external":"1"}}"#.into())
                    }
                },
                |root, dir| std::path::Path::new(dir).starts_with(root),
            )
        };
        assert!(check(None));
        assert!(!check(Some("{")));
        assert!(!check(Some("null")));
        assert!(inspect(
            "/repo/main.js",
            Some("/repo"),
            "0",
            |_| Some(r#"{"dependencies":["1"]}"#.into()),
            |_, _| true
        ));
        assert!(!inspect(
            "/repo/main.js",
            Some("/repo"),
            "00",
            |_| Some(r#"{"dependencies":["1"]}"#.into()),
            |_, _| true
        ));
        assert!(!check(Some(r#"{"name":"external"}"#)));
        assert!(!check(Some(
            r#"{"dependencies":{"external":"workspace:*"}}"#
        )));
    }
}

#[cfg(all(test, unix))]
mod native_tests {
    use super::observe;
    use serde_json::json;
    #[test]
    fn invalid_observer_inputs_are_rejected() {
        assert!(observe(&json!({"specifier":"external"})).is_err());
        assert!(observe(&json!({"path":"/repo/main.js"})).is_err());
        assert!(
            observe(&json!({"path":"/repo/main.js","specifier":"external","repository_root":42}))
                .is_err()
        );
    }
    #[test]
    fn native_directory_read_failure_is_observed_before_parent_manifest() {
        let root =
            std::env::temp_dir().join(format!("semctx-declared-external-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("src");
        std::fs::create_dir(&source).unwrap();
        std::fs::create_dir(source.join("package.json")).unwrap();
        std::fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"external":"1"}}"#,
        )
        .unwrap();
        let result = observe(&json!({"path":source.join("main.js"),"repository_root":root,"specifier":"external/sub"})).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(result["external"], true);
        assert_eq!(result["reads"][0]["found"], false);
        assert_eq!(result["reads"][0]["error_kind"], "IsADirectory");
        assert_eq!(result["reads"][1]["found"], true);
        assert_eq!(result["system"], "native");
    }
}
