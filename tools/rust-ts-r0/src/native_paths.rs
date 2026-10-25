pub(super) fn compiler_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    if let Some(rest) = path.strip_prefix("//?/")
        && rest.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && rest.as_bytes().get(1) == Some(&b':')
        && rest.as_bytes().get(2) == Some(&b'/')
    {
        return rest.into();
    }
    path
}
