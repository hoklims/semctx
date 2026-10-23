use super::*;
use semctx_r0_probe::receiver::OwnershipContext;
use serde_json::Value;

pub(super) fn inspect(
    request: &Request,
    sdk: &Sdk,
    context: &OwnershipContext<'_>,
) -> Result<Vec<Value>, String> {
    if !request.qualified || !request.retained {
        return Err("received ownership requires retained qualified inputs".into());
    }
    if batch::input_manifest(request, sdk)? != *context.input_manifest()
        || batch::capture_manifest(request)? != *context.capture_manifest()
    {
        return Err("received ownership inputs differ from validated capture".into());
    }
    let scope = batch::scope_manifest(request)?;
    if [
        "repository_root",
        "sdk_directory",
        "retained",
        "effective_options",
        "profile",
    ]
    .iter()
    .any(|field| scope[field] != context.scope_manifest()[field])
    {
        return Err("received ownership scope differs from validated capture".into());
    }
    let mut project = request
        .files
        .iter()
        .map(|(path, text)| {
            (
                path.clone(),
                ts_goport::scanner_util::go_string_from_utf8(text.clone()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    for (path, units) in &request.utf16_files {
        if project
            .insert(path.clone(), source_text::from_units(units))
            .is_some()
        {
            return Err("duplicate decoded source path".into());
        }
    }
    for (path, raw) in &request.raw_files {
        if project
            .insert(path.clone(), source_text::decode(&raw.bytes, raw.profile))
            .is_some()
        {
            return Err("duplicate decoded source path".into());
        }
    }
    let mut files = project.clone();
    for (path, text) in &sdk.files {
        if files
            .insert(
                path.clone(),
                ts_goport::scanner_util::go_string_from_utf8(text.clone()),
            )
            .is_some()
        {
            return Err("duplicate captured SDK path".into());
        }
    }
    let fs = Rc::new(
        CaptureFs::new(files, request.case_sensitive)
            .with_sdk_keys(sdk.files.keys().map(String::as_str))?,
    );
    let project = std::sync::Arc::new(project);
    request
        .roots
        .iter()
        .filter(|path| {
            ![".d.ts", ".d.mts", ".d.cts"]
                .iter()
                .any(|extension| path.ends_with(extension))
        })
        .map(|path| {
            let mut subject = inspect_subject(
                fs.clone(),
                path,
                &request.cwd,
                &request.sdk_directory,
                project.clone(),
                context.graph().clone(),
                true,
                true,
            )?;
            let relative = relative_source_path(&request.cwd, path, request.case_sensitive)?;
            subject["role"] = serde_json::json!(
                request
                    .roles
                    .get(&relative)
                    .map(String::as_str)
                    .unwrap_or("source")
            );
            subject["path"] = serde_json::json!(relative);
            subject["selection"] = serde_json::json!("selected");
            Ok(subject)
        })
        .collect()
}

#[cfg(test)]
#[path = "../tests/unit/scope_received.rs"]
mod tests;
