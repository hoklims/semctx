use super::*;

#[derive(Deserialize)]
struct Library {
    path: String,
    bytes: usize,
    sha256: String,
}

impl Sdk {
    pub(crate) fn matches_reference(&self) -> bool {
        self.version == "7.1.0-dev"
            && self.archive_sha256.is_none()
            && self.source_revision.as_deref() == Some("780dc512d64f40afebffa6a7028207649fb7ed1c")
            && self.library_manifest_sha256.as_deref()
                == Some("b1fa7b60aa83d187453b26c0b56a096875a47e61977954aba7deba16161fd7ad")
    }

    pub(crate) fn validate_libraries(&self, directory: &str) -> Result<(), String> {
        let libraries: Vec<Library> =
            serde_json::from_str(include_str!("../sdk/library-manifest.json"))
                .map_err(|error| format!("SDK_LIBRARY_MANIFEST_INVALID:{error}"))?;
        let prefix = format!("{}/", directory.trim_end_matches('/'));
        let expected = libraries
            .iter()
            .map(|library| format!("{prefix}{}", library.path))
            .collect::<BTreeSet<_>>();
        for library in &libraries {
            if !self
                .files
                .contains_key(&format!("{prefix}{}", library.path))
            {
                return Err(format!("SDK_LIBRARY_MISSING:{}", library.path));
            }
        }
        for path in self.files.keys() {
            if !expected.contains(path) {
                return Err(format!(
                    "SDK_LIBRARY_UNEXPECTED:{}",
                    path.strip_prefix(&prefix).unwrap_or(path)
                ));
            }
        }
        for library in &libraries {
            let text = &self.files[&format!("{prefix}{}", library.path)];
            if text.len() != library.bytes
                || identity::digest_bytes(text.as_bytes()) != format!("sha256:{}", library.sha256)
            {
                return Err(format!("SDK_LIBRARY_CONTENT_MISMATCH:{}", library.path));
            }
        }
        Ok(())
    }

    pub(crate) fn capability_identity(
        &self,
        compatibility: sdk_compatibility::Compatibility,
    ) -> serde_json::Value {
        match compatibility {
            sdk_compatibility::Compatibility::Native => serde_json::json!({
                "version":self.version,
                "sourceRevision":self.source_revision,
                "libraryManifestSha256":self.library_manifest_sha256,
                "inventoryValidated":true,
                "allLibrariesConsumptionProven":false
            }),
            sdk_compatibility::Compatibility::Ts5Degraded => serde_json::json!({
                "version":self.version,
                "archiveSha256":self.archive_sha256,
                "inventoryValidated":false,
                "allLibrariesConsumptionProven":false
            }),
        }
    }
}
