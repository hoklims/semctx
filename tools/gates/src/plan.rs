use crate::Result;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Lane {
    pub index: usize,
    pub id: String,
    pub os: String,
    pub profile: String,
    pub targets: String,
    pub smoke: String,
    pub shard: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subject {
    pub base: String,
    pub head: String,
    pub tree: String,
    pub policy_hash: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Matrix {
    pub include: Vec<Lane>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub schema: u32,
    pub plan_id: String,
    pub subject: Subject,
    pub mode: String,
    pub reason: String,
    pub paths: Vec<String>,
    pub matrix: Matrix,
}

pub fn affected(
    paths: &[String],
    graph: &BTreeMap<String, BTreeSet<String>>,
) -> Option<BTreeSet<String>> {
    let mut selected = BTreeSet::new();
    for path in paths {
        if !valid_path(path) {
            return None;
        }
        if documentation(path) {
            continue;
        }
        if path.starts_with("plugins/") {
            // Plugin helpers are also imported directly by CLI/services outside workspace
            // manifests. Until that graph is complete, retain all consumers on every OS.
            return None;
        }
        if path.starts_with("site/")
            || path.starts_with("examples/")
            || path.starts_with("benchmarks/")
        {
            return None;
        }
        let component = path.split('/').take(2).collect::<Vec<_>>().join("/");
        if !graph.contains_key(&component) {
            return None;
        }
        selected.insert(component);
    }
    loop {
        let before = selected.len();
        for (consumer, dependencies) in graph {
            if dependencies
                .iter()
                .any(|dependency| selected.contains(dependency))
            {
                selected.insert(consumer.clone());
            }
        }
        if before == selected.len() {
            break;
        }
    }
    // These integrations bundle/import product code without a complete package dependency manifest.
    if selected
        .iter()
        .any(|x| x.starts_with("packages/") || x.starts_with("apps/"))
    {
        selected.insert("apps/cli".into());
        if graph.contains_key("packages/mcp-server") {
            selected.insert("packages/mcp-server".into());
        }
        if graph.contains_key("packages/github-action") {
            selected.insert("packages/github-action".into());
        }
        selected.insert("plugins".into());
    }
    Some(
        selected
            .into_iter()
            .map(|x| {
                if x == "plugins" {
                    x
                } else {
                    format!("{x}/test")
                }
            })
            .collect(),
    )
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '\r', '\n', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn documentation(path: &str) -> bool {
    [
        "README.md",
        "README.fr.md",
        "CONTRIBUTING.md",
        "CHANGELOG.md",
        "SECURITY.md",
        "ROADMAP.md",
        ".github/pull_request_template.md",
    ]
    .contains(&path)
        || (path.starts_with("docs/") && path.ends_with(".md"))
        || (path.starts_with("docs/assets/") && path.ends_with(".svg"))
}

pub fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let argv = std::iter::once("git".to_owned())
        .chain(args.iter().map(|x| (*x).to_owned()))
        .collect::<Vec<_>>();
    let result = crate::process::run(&argv, root, 30_000, 8 * 1024 * 1024)?;
    if result.kind != "success" {
        return Err(format!("git {args:?}: {}: {}", result.kind, result.stderr));
    }
    Ok(result.stdout.into_bytes())
}
fn git_text(root: &Path, args: &[&str]) -> Result<String> {
    String::from_utf8(git(root, args)?)
        .map(|s| s.trim().to_owned())
        .map_err(|e| e.to_string())
}
pub fn clean(root: &Path) -> Result<()> {
    if git(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?
    .is_empty()
    {
        return Ok(());
    }
    git(root, &["diff", "--quiet", "--no-ext-diff"])?;
    git(root, &["diff", "--cached", "--quiet", "--no-ext-diff"])?;
    if !git(root, &["ls-files", "--others", "--exclude-standard", "-z"])?.is_empty() {
        return Err(
            "non-ignored untracked files: receipts/plans must be outside the source tree".into(),
        );
    }
    Ok(())
}
fn commit_subject(root: &Path, base: &str, head: &str) -> Result<(String, String, String)> {
    if base.starts_with('-') || head.starts_with('-') {
        return Err("refs cannot start with '-'".into());
    }
    let identities = git_text(
        root,
        &[
            "rev-parse",
            &format!("{base}^{{commit}}"),
            &format!("{head}^{{commit}}"),
            "HEAD",
        ],
    )?;
    let identities = identities.lines().collect::<Vec<_>>();
    let [base, head, checkout] = identities.as_slice() else {
        return Err("invalid Git commit identities".into());
    };
    if identities
        .iter()
        .any(|id| !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("invalid Git commit identities".into());
    }
    if head != checkout {
        return Err("checkout is not the requested head".into());
    }
    let tree = git_text(root, &["rev-parse", &format!("{head}^{{tree}}")])?;
    Ok(((*base).into(), (*head).into(), tree))
}
fn graph(root: &Path) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let mut names = BTreeMap::new();
    let mut manifests = BTreeMap::new();
    for parent in ["packages", "apps"] {
        for entry in std::fs::read_dir(root.join(parent)).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let path = entry.path().join("package.json");
            if !path.exists() {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            let component = format!(
                "{parent}/{}",
                entry.file_name().to_str().ok_or("non-UTF8 component")?
            );
            let name = value["name"].as_str().ok_or("manifest missing name")?;
            if names.insert(name.to_owned(), component.clone()).is_some() {
                return Err("duplicate workspace package name".into());
            }
            manifests.insert(component, value);
        }
    }
    let mut result = BTreeMap::new();
    for (component, value) in manifests {
        result.insert(component, workspace_dependencies(&value, &names)?);
    }
    Ok(result)
}
fn workspace_dependencies(
    manifest: &serde_json::Value,
    names: &BTreeMap<String, String>,
) -> Result<BTreeSet<String>> {
    let mut dependencies = BTreeSet::new();
    for field in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        let Some(object) = manifest[field].as_object() else {
            continue;
        };
        for (name, version) in object {
            if let Some(dependency) = names.get(name) {
                dependencies.insert(dependency.clone());
            } else if version
                .as_str()
                .is_some_and(|value| value.starts_with("workspace:"))
            {
                return Err(format!("unknown workspace dependency {name}"));
            }
        }
    }
    Ok(dependencies)
}
fn lane(os: &str, profile: &str, targets: &str, smoke: bool, shard: &str) -> Lane {
    Lane {
        index: 0,
        id: String::new(),
        os: os.into(),
        profile: profile.into(),
        targets: targets.into(),
        smoke: smoke.to_string(),
        shard: shard.into(),
    }
}
fn suites(os: &str, profile: &str, targets: &str, smoke: bool) -> Vec<Lane> {
    let count = if os == "windows-latest" { 4 } else { 2 };
    (1..=count)
        .map(|i| lane(os, profile, targets, smoke, &format!("{i}/{count}")))
        .collect()
}
pub fn create(root: &Path, base: &str, head: &str) -> Result<Plan> {
    clean(root)?;
    let (base, head, tree) = commit_subject(root, base, head)?;
    let policy_hash = crate::digest(
        concat!(
            include_str!("plan.rs"),
            include_str!("receipt.rs"),
            include_str!("process.rs"),
            include_str!("main.rs"),
            include_str!("lib.rs"),
            include_str!("rust_workspace.rs"),
            include_str!("../Cargo.toml"),
            include_str!("../Cargo.lock")
        )
        .replace("\r\n", "\n"),
    );
    let bytes = git(
        root,
        &[
            "diff",
            "--name-only",
            "--no-renames",
            "--no-ext-diff",
            "-z",
            &format!("{base}...{head}"),
        ],
    )?;
    if !bytes.is_empty() && bytes.last() != Some(&0) {
        return Err("malformed Git path list".into());
    }
    let paths = String::from_utf8(bytes)
        .map_err(|_| "non-UTF8 changed path")?
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut lanes = vec![lane("ubuntu-latest", "contract", "", false, "")];
    let docs = !paths.is_empty() && paths.iter().all(|p| documentation(p));
    let mode;
    let reason;
    if docs {
        mode = "docs";
        reason = "documentation only";
    } else {
        let targets = graph(root)
            .ok()
            .and_then(|g| affected(&paths, &g))
            .filter(|t| {
                !paths.is_empty() && !t.is_empty() && t.iter().all(|t| root.join(t).exists())
            });
        let smoke = true; // Conservative worker equivalence until explicit capability mapping replaces legacy inputs.
        lanes.extend(suites("ubuntu-latest", "full", "", smoke));
        if let Some(targets) = targets {
            mode = "affected";
            reason = "manifest consumer closure plus integrations";
            let targets = targets.into_iter().collect::<Vec<_>>().join(",");
            for os in ["windows-latest", "macos-15"] {
                lanes.extend(suites(os, "focused", &targets, smoke));
            }
        } else {
            mode = "fallback";
            reason = "unknown impact, empty diff, or missing target";
            for os in ["windows-latest", "macos-15"] {
                lanes.extend(suites(os, "full", "", smoke));
            }
        }
    }
    for (i, lane) in lanes.iter_mut().enumerate() {
        lane.index = i;
        lane.id = format!("lane-{i:03}-{}-{}", lane.os, lane.profile);
    }
    let mut plan = Plan {
        schema: 1,
        plan_id: String::new(),
        subject: Subject {
            base,
            head,
            tree,
            policy_hash,
        },
        mode: mode.into(),
        reason: reason.into(),
        paths,
        matrix: Matrix { include: lanes },
    };
    plan.plan_id = crate::digest(serde_json::to_vec(&plan).map_err(|e| e.to_string())?);
    Ok(plan)
}
pub fn validate(root: &Path, plan: &Plan) -> Result<()> {
    let expected = create(root, &plan.subject.base, &plan.subject.head)?;
    if &expected != plan {
        return Err("plan does not match recomputed subject/policy/obligations".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closes_transitive_consumers_and_integrations() {
        let graph = BTreeMap::from([
            ("packages/core".into(), BTreeSet::new()),
            (
                "packages/service".into(),
                BTreeSet::from(["packages/core".into()]),
            ),
            (
                "apps/cli".into(),
                BTreeSet::from(["packages/service".into()]),
            ),
        ]);
        let got = affected(&["packages/core/src/index.ts".into()], &graph).unwrap();
        assert!(got.contains("packages/service/test"));
        assert!(got.contains("apps/cli/test"));
        assert!(got.contains("plugins"));
    }
    #[test]
    fn unknown_and_deleted_package_fall_back() {
        let graph = BTreeMap::new();
        assert!(affected(&["new-runtime/x.rs".into()], &graph).is_none());
        assert!(affected(&["packages/deleted/src/x.ts".into()], &graph).is_none());
    }
}
