use super::*;

pub(super) const TS5_DEGRADED_ANALYSIS: &str = "TS5_DEGRADED_ANALYSIS";
const TS5_ARCHIVE: &str = "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3";
const WARNING: &str = "Projet TypeScript 5 analysé avec ts_goport 7.1.0-dev ; compatibilité TS5 non garantie et admission qualifiée indisponible";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Compatibility {
    Native,
    Ts5Degraded,
}

#[derive(Deserialize)]
struct Package {
    name: String,
    version: String,
}

fn stable_ts5(version: &str) -> bool {
    let parts = version.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts[0] == "5"
        && parts[1..].iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

pub(super) fn classify(sdk: &Sdk, directory: &str) -> Result<Compatibility, String> {
    let unrecognized = || "SDK_IDENTITY_UNRECOGNIZED".to_string();
    let package_path = std::path::Path::new(directory)
        .parent()
        .ok_or_else(unrecognized)?
        .join("package.json")
        .to_string_lossy()
        .replace('\\', "/");
    let packages = sdk
        .files
        .iter()
        .filter(|(path, _)| path.ends_with("/package.json"))
        .collect::<Vec<_>>();
    let explicit = match packages.as_slice() {
        [] => false,
        [(path, text)] if **path == package_path => {
            let package: Package = serde_json::from_str(text).map_err(|_| unrecognized())?;
            if package.name != "typescript" {
                return Err(unrecognized());
            }
            if package.version != sdk.version {
                return Err("SDK_IDENTITY_INCONSISTENT".into());
            }
            true
        }
        _ => return Err(unrecognized()),
    };
    if sdk.archive_sha256.len() != 64
        || !sdk
            .archive_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(unrecognized());
    }
    if sdk.archive_sha256.eq_ignore_ascii_case(TS5_ARCHIVE) && sdk.version == "5.9.3" {
        return Ok(Compatibility::Ts5Degraded);
    }
    if !explicit {
        return Err(unrecognized());
    }
    if sdk.archive_sha256.eq_ignore_ascii_case(TS5_ARCHIVE) {
        return Err("SDK_IDENTITY_INCONSISTENT".into());
    }
    if stable_ts5(&sdk.version) {
        return Ok(Compatibility::Ts5Degraded);
    }
    if sdk.version == "7.1.0-dev" {
        return Ok(Compatibility::Native);
    }
    Err(unrecognized())
}

pub(super) fn warn(compatibility: Compatibility) {
    if compatibility == Compatibility::Ts5Degraded {
        eprintln!(
            "{}",
            serde_json::json!({"code":TS5_DEGRADED_ANALYSIS,"severity":"warning","message":WARNING})
        );
    }
}
