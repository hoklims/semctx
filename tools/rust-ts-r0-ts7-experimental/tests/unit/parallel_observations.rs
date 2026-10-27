use super::*;

#[test]
fn selected_dependency_root_uses_the_repository_graph_boundary_fallback() {
    let dependency_directories =
        if !ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names() {
            vec!["node_modules", "NODE_MODULES"]
        } else {
            vec!["node_modules"]
        };
    for dependency_directory in dependency_directories {
        let root = std::env::temp_dir().join(format!(
            "semctx-parallel-boundary-dev-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join(format!("{dependency_directory}/pkg"))).unwrap();
        let regular = root.join("regular.ts");
        let dependency = root.join(format!("{dependency_directory}/pkg/index.ts"));
        std::fs::write(&regular, "export function regular() { return 1; }\n").unwrap();
        std::fs::write(&dependency, "export function dependency() { return 2; }\n").unwrap();
        let result = preflight(
            root.to_str().unwrap(),
            &[
                regular.to_string_lossy().into_owned(),
                dependency.to_string_lossy().into_owned(),
            ],
        );
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_ok(),
            "boundary must be an observable unsafe preflight, not an unavailable graph"
        );
        let result = result.unwrap();
        assert_eq!(
            result.unsafe_reason.as_deref(),
            Some("extraction root is outside the repository module graph boundary")
        );
        assert_eq!(result.observation["safe"], false);
    }
}
