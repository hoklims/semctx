use super::*;

#[derive(Clone, Serialize)]
pub struct WorkspaceIssue {
    pub path: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Clone, Default)]
struct Links {
    aliases: BTreeMap<String, String>,
    unsupported: BTreeSet<String>,
    refusals: BTreeSet<String>,
}

pub struct Workspace {
    pub root: String,
    sdk_directory: Option<String>,
    sdk_files: BTreeSet<String>,
    sdk_directories: BTreeSet<String>,
    cache: RefCell<BTreeMap<String, Links>>,
    pub aliases: RefCell<BTreeMap<String, String>>,
    pub unsupported: RefCell<BTreeSet<String>>,
    pub refusals: RefCell<BTreeSet<String>>,
    pub issues: RefCell<Vec<WorkspaceIssue>>,
}

fn within(root: &str, path: &str) -> bool {
    root == "/" || path == root || path.starts_with(&format!("{root}/"))
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/')
        .map_or("/", |(head, _)| if head.is_empty() { "/" } else { head })
}

fn json_at(fs: &CaptureFs, path: &str) -> Option<serde_json::Value> {
    let (text, found) = fs.read_file(path);
    found
        .then(|| serde_json::from_str::<serde_json::Value>(&text).ok())
        .flatten()
        .filter(serde_json::Value::is_object)
}

fn nested_repository(fs: &CaptureFs, root: &str, path: &str) -> bool {
    let mut directory = if fs.dirs.contains(path) {
        path
    } else {
        parent(path)
    };
    while within(root, directory) && directory != root {
        if fs.files.contains_key(&fs.key(&format!("{directory}/.git")))
            || fs.dirs.contains(&fs.key(&format!("{directory}/.git")))
        {
            return true;
        }
        directory = parent(directory);
    }
    false
}

fn patterns(value: &serde_json::Value) -> Vec<String> {
    let values = value
        .as_array()
        .or_else(|| value.get("packages").and_then(serde_json::Value::as_array));
    values
        .filter(|values| values.iter().all(serde_json::Value::is_string))
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn declaration(
    fs: &CaptureFs,
    directory: &str,
    root: &str,
    unsupported: &mut BTreeSet<String>,
) -> Option<(String, Vec<String>)> {
    let mut current = directory;
    while within(root, current) {
        let pnpm = format!("{current}/pnpm-workspace.yaml");
        if fs.files.contains_key(&fs.key(&pnpm)) {
            fs.read_file(&pnpm);
            unsupported.insert("WORKSPACE_PNPM_DECLARATION_UNSUPPORTED".into());
            return None;
        }
        if current == root
            || fs.files.contains_key(&fs.key(&format!("{current}/.git")))
            || fs.dirs.contains(&fs.key(&format!("{current}/.git")))
        {
            break;
        }
        current = parent(current);
    }
    current = directory;
    while within(root, current) {
        let path = format!("{current}/package.json");
        if let Some(value) = json_at(fs, &path) {
            if let Some(value) = value.get("workspaces") {
                return Some((current.into(), patterns(value)));
            }
        } else if fs.files.contains_key(&fs.key(&path)) {
            return Some((current.into(), vec![]));
        }
        if current == root
            || fs.files.contains_key(&fs.key(&format!("{current}/.git")))
            || fs.dirs.contains(&fs.key(&format!("{current}/.git")))
        {
            break;
        }
        current = parent(current);
    }
    None
}

fn workspace_globs(
    values: Vec<String>,
    sensitive: bool,
    unsupported: &mut BTreeSet<String>,
) -> Option<(Vec<String>, Vec<String>)> {
    let mut include = vec![];
    let mut exclude = vec![];
    for value in values {
        let (negative, value) = value
            .strip_prefix('!')
            .map_or((false, value.as_str()), |value| (true, value));
        let value = value.trim_start_matches("./").trim_end_matches('/');
        if value.is_empty()
            || value.starts_with('/')
            || value.split('/').any(|segment| {
                segment.is_empty()
                    || segment.starts_with('.')
                    || segment == "node_modules"
                    || (!matches!(segment, "*" | "**")
                        && segment
                            .chars()
                            .any(|character| "*?{}[]\\".contains(character)))
            })
        {
            unsupported.insert(format!("WORKSPACE_PATTERN_UNSUPPORTED:{value}"));
            return None;
        }
        let value = if sensitive {
            value.into()
        } else {
            value.to_lowercase()
        };
        if negative {
            exclude.push(value);
        } else {
            include.push(value);
        }
    }
    Some((include, exclude))
}

fn workspace_path_matches(pattern: &str, path: &str) -> bool {
    let segments = path.split('/').collect::<Vec<_>>();
    let mut reachable = vec![false; segments.len() + 1];
    reachable[0] = true;
    for pattern in pattern.split('/') {
        let mut next = vec![false; segments.len() + 1];
        if pattern == "**" {
            for index in 0..=segments.len() {
                next[index] = reachable[index] || index > 0 && next[index - 1];
            }
        } else {
            for index in 1..=segments.len() {
                next[index] =
                    reachable[index - 1] && (pattern == "*" || pattern == segments[index - 1]);
            }
        }
        reachable = next;
    }
    reachable[segments.len()]
}

fn valid_name(name: &str) -> bool {
    let segments = name.split('/').collect::<Vec<_>>();
    let shape = if name.starts_with('@') {
        segments.len() == 2
    } else {
        segments.len() == 1
    };
    shape
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && !matches!(*segment, "." | "..")
                && !segment.contains('\\')
                && !segment.chars().any(char::is_whitespace)
        })
}

fn comparator(value: &str) -> bool {
    let value = [">=", "<=", ">", "<", "=", "^", "~"]
        .into_iter()
        .find_map(|prefix| value.strip_prefix(prefix))
        .unwrap_or(value);
    let value = value.strip_prefix('v').unwrap_or(value);
    let components = value.split('.').collect::<Vec<_>>();
    (1..=3).contains(&components.len())
        && components.iter().all(|component| {
            matches!(*component, "x" | "X" | "*")
                || (!component.is_empty()
                    && component.bytes().all(|byte| byte.is_ascii_digit())
                    && (component.len() == 1 || !component.starts_with('0')))
        })
}

fn numeric_range_grammar(range: &str) -> bool {
    range.split("||").all(|alternative| {
        let parts = alternative.split_whitespace().collect::<Vec<_>>();
        if parts.len() == 3 && parts[1] == "-" {
            comparator(parts[0]) && comparator(parts[2])
        } else {
            !parts.is_empty() && parts.iter().all(|part| comparator(part))
        }
    })
}

fn satisfies(
    fs: &CaptureFs,
    member: &str,
    range: &str,
    unsupported: &mut BTreeSet<String>,
) -> bool {
    if matches!(range, "" | "*" | "^" | "~") {
        return true;
    }
    if !range
        .chars()
        .all(|character| character.is_ascii_digit() || "vxX*.^~<>=| -\t\r\n".contains(character))
    {
        unsupported.insert(format!("WORKSPACE_RANGE_UNSUPPORTED:{range}"));
        return false;
    }
    let Some(manifest) = json_at(fs, &format!("{member}/package.json")) else {
        return false;
    };
    let Some(version) = manifest["version"].as_str() else {
        return false;
    };
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let components = core.split('.').collect::<Vec<_>>();
    if components.len() != 3
        || components.iter().any(|component| {
            component.is_empty() || !component.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        return false;
    }
    if version.contains(['-', '+']) {
        unsupported.insert("WORKSPACE_PRERELEASE_VERSION_UNSUPPORTED".into());
        return false;
    }
    let Ok(version) = ts_goport::frontend::semver::try_parse_version(version) else {
        return false;
    };
    let tokens = range.split_whitespace().collect::<Vec<_>>();
    let mut normalized = Vec::new();
    let mut offset = 0;
    while offset < tokens.len() {
        if matches!(tokens[offset], ">" | ">=" | "<" | "<=" | "=" | "^" | "~")
            && tokens.get(offset + 1).is_some_and(|token| {
                token
                    .strip_prefix('v')
                    .unwrap_or(token)
                    .chars()
                    .next()
                    .is_some_and(|character| {
                        character.is_ascii_digit() || matches!(character, 'x' | 'X' | '*')
                    })
            })
        {
            normalized.push(format!("{}{}", tokens[offset], tokens[offset + 1]));
            offset += 2;
        } else {
            normalized.push(tokens[offset].to_string());
            offset += 1;
        }
    }
    let normalized = normalized.join(" ");
    if !numeric_range_grammar(&normalized) {
        return false;
    }
    let (range, parsed) = ts_goport::frontend::semver::try_parse_version_range(&normalized);
    parsed && range.test(&version)
}

fn links_for(fs: &CaptureFs, consumer: &str, root: &str, requested_name: Option<&str>) -> Links {
    let mut result = Links::default();
    if !within(root, consumer) || nested_repository(fs, root, consumer) {
        return result;
    }
    let Some(manifest) = json_at(fs, &format!("{consumer}/package.json")) else {
        return result;
    };
    let mut dependencies = BTreeMap::new();
    for field in ["dependencies", "devDependencies", "optionalDependencies"] {
        for (name, value) in manifest[field].as_object().into_iter().flatten() {
            let Some(range) = value
                .as_str()
                .and_then(|value| value.strip_prefix("workspace:"))
            else {
                continue;
            };
            if !valid_name(name) || range.contains(['@', '/', '\\']) {
                continue;
            }
            dependencies.insert(name.clone(), range.trim().to_string());
        }
    }
    if let Some(name) = requested_name {
        dependencies.retain(|candidate, _| candidate == name);
    }
    if dependencies.is_empty() {
        return result;
    }
    let Some((workspace_root, values)) = declaration(fs, consumer, root, &mut result.unsupported)
    else {
        return result;
    };
    let Some((include, exclude)) = workspace_globs(values, fs.sensitive, &mut result.unsupported)
    else {
        return result;
    };
    let mut members = BTreeSet::from([workspace_root.clone()]);
    for path in fs
        .files
        .keys()
        .filter(|path| path.ends_with("/package.json") && within(&workspace_root, path))
    {
        let directory = parent(path);
        let Some(relative) = directory.strip_prefix(&format!("{workspace_root}/")) else {
            continue;
        };
        if relative
            .split('/')
            .any(|segment| segment == "node_modules" || segment.starts_with('.'))
            || nested_repository(fs, &workspace_root, directory)
        {
            continue;
        }
        if include
            .iter()
            .any(|glob| workspace_path_matches(glob, relative))
            && !exclude
                .iter()
                .any(|glob| workspace_path_matches(glob, relative))
        {
            members.insert(directory.into());
        }
    }
    if !members.contains(consumer) {
        return result;
    }
    let mut names = BTreeMap::<String, Option<String>>::new();
    for member in members {
        let Some(value) = json_at(fs, &format!("{member}/package.json")) else {
            continue;
        };
        let Some(name) = value["name"].as_str().filter(|name| valid_name(name)) else {
            continue;
        };
        if names.contains_key(name) {
            names.insert(name.into(), None);
        } else {
            names.insert(name.into(), Some(member));
        }
    }
    for (name, range) in dependencies {
        let Some(Some(member)) = names.get(&name) else {
            if names.get(&name) == Some(&None) {
                result
                    .refusals
                    .insert(format!("WORKSPACE_MEMBER_AMBIGUOUS:{name}"));
            }
            continue;
        };
        let mut directory = consumer;
        let mut installed = false;
        loop {
            let path = fs.key(&format!("{directory}/node_modules/{name}"));
            if fs.dirs.contains(&path) || fs.files.contains_key(&path) {
                installed = true;
                break;
            }
            if directory == "/" {
                break;
            }
            directory = parent(directory);
        }
        if installed || !satisfies(fs, member, &range, &mut result.unsupported) {
            continue;
        }
        result.aliases.insert(
            fs.key(&format!("{consumer}/node_modules/{name}")),
            member.clone(),
        );
    }
    result
}

impl Workspace {
    pub fn build(fs: &CaptureFs, root: &str, sdk_directory: Option<&str>) -> Self {
        Self {
            root: fs.key(root),
            sdk_directory: sdk_directory.map(|path| fs.key(path)),
            sdk_files: BTreeSet::new(),
            sdk_directories: BTreeSet::new(),
            cache: RefCell::new(BTreeMap::new()),
            aliases: RefCell::new(BTreeMap::new()),
            unsupported: RefCell::new(BTreeSet::new()),
            refusals: RefCell::new(BTreeSet::new()),
            issues: RefCell::new(vec![]),
        }
    }
    pub fn enable_sdk(&mut self, keys: BTreeSet<String>) -> Result<(), String> {
        if keys.is_empty() {
            return Ok(());
        }
        let root = self
            .sdk_directory
            .as_deref()
            .ok_or("CAPTURED_SYSTEM_SDK_DIRECTORY_REQUIRED")?;
        if keys.iter().any(|key| !within(root, key)) {
            return Err("CAPTURED_SYSTEM_SDK_FILE_OUTSIDE_DIRECTORY".into());
        }
        let mut directories = BTreeSet::new();
        for key in &keys {
            let mut directory = parent(key);
            while within(root, directory) {
                directories.insert(directory.to_string());
                if directory == root || directory == "/" {
                    break;
                }
                directory = parent(directory);
            }
        }
        self.sdk_files = keys;
        self.sdk_directories = directories;
        Ok(())
    }
    fn issue(&self, path: &str, kind: &str, detail: &str) {
        if kind == "unsupported" {
            self.unsupported.borrow_mut().insert(detail.into());
        } else {
            self.refusals.borrow_mut().insert(detail.into());
        }
        self.issues.borrow_mut().push(WorkspaceIssue {
            path: path.into(),
            kind: kind.into(),
            detail: detail.into(),
        });
    }
    fn links(&self, fs: &CaptureFs, consumer: &str, requested: &str, name: Option<&str>) -> Links {
        let key = format!("{consumer}\0{}", name.unwrap_or("*"));
        let cached = self.cache.borrow().get(&key).cloned();
        let mut links = cached.unwrap_or_else(|| {
            let links = links_for(fs, consumer, &self.root, name);
            self.cache.borrow_mut().insert(key, links.clone());
            links
        });
        if name.is_none() && !links.aliases.is_empty() {
            links.unsupported.clear();
            links.refusals.clear();
        }
        self.aliases.borrow_mut().extend(links.aliases.clone());
        for detail in &links.unsupported {
            self.issue(requested, "unsupported", detail);
        }
        for detail in &links.refusals {
            self.issue(requested, "refusal", detail);
        }
        links
    }
    fn admitted_key(&self, fs: &CaptureFs, path: &str) -> Option<String> {
        let key = fs.key(path);
        if self.sdk_files.contains(&key) || self.sdk_directories.contains(&key) {
            return Some(key);
        }
        if !within(&self.root, &key) {
            self.issue(path, "refusal", "WORKSPACE_PATH_OUTSIDE_ROOT");
            return None;
        }
        if nested_repository(fs, &self.root, &key) {
            self.issue(path, "refusal", "WORKSPACE_NESTED_REPOSITORY");
            return None;
        }
        Some(key)
    }
    pub fn physical_path(&self, fs: &CaptureFs, path: &str) -> Option<String> {
        let key = self.admitted_key(fs, path)?;
        (fs.files.contains_key(&key) || fs.dirs.contains(&key)).then_some(key)
    }
    pub fn resolve(&self, fs: &CaptureFs, path: &str) -> Option<String> {
        let key = self.admitted_key(fs, path)?;
        if fs.files.contains_key(&key) || fs.dirs.contains(&key) {
            return Some(key);
        }
        let lexical = if fs.sensitive {
            key.clone()
        } else {
            CaptureFs::new(BTreeMap::new(), true).key(path)
        };
        for (marker, _) in lexical.match_indices("/node_modules/") {
            let consumer = fs.key(&lexical[..marker]);
            let remaining = &lexical[marker + "/node_modules/".len()..];
            let segments = remaining.split('/').collect::<Vec<_>>();
            let name_length = if remaining.starts_with('@') { 2 } else { 1 };
            if segments.len() < name_length
                || segments[..name_length]
                    .iter()
                    .any(|segment| segment.is_empty())
            {
                continue;
            }
            let name = segments[..name_length].join("/");
            let links = self.links(fs, &consumer, path, Some(&name));
            for (virtual_root, member) in &links.aliases {
                let target = if let Some(relative) = key.strip_prefix(&format!("{virtual_root}/")) {
                    fs.key(&format!("{member}/{relative}"))
                } else if key == *virtual_root {
                    member.clone()
                } else {
                    continue;
                };
                if !within(member, &target) || nested_repository(fs, &self.root, &target) {
                    continue;
                }
                if fs.files.contains_key(&target) || fs.dirs.contains(&target) {
                    return Some(target);
                }
            }
        }
        None
    }
    pub fn virtual_node_modules(&self, fs: &CaptureFs, path: &str) -> bool {
        let key = fs.key(path);
        if !path.replace('\\', "/").ends_with("/node_modules") {
            return false;
        }
        key.strip_suffix("/node_modules")
            .is_some_and(|consumer| !self.links(fs, consumer, path, None).aliases.is_empty())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Profile {
    Retained,
    Workspace,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemRequest {
    profile: Profile,
    root: String,
    #[serde(default = "native_case")]
    case_sensitive: bool,
    files: BTreeMap<String, String>,
    #[serde(default)]
    utf16_files: BTreeMap<String, Vec<u16>>,
    #[serde(default)]
    raw_files: BTreeMap<String, RawFile>,
    sdk_directory: Option<String>,
    queries: Vec<SystemQuery>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SystemQuery {
    operation: SystemOperation,
    path: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum SystemOperation {
    ReadFile,
    FileExists,
    DirectoryExists,
    ReadDirectory,
    Realpath,
    NativeGetAccessibleEntries,
}

fn native_case() -> bool {
    ts_goport::frontend::vfs::osvfs_fs().use_case_sensitive_file_names()
}

pub(super) fn absolute(path: &str) -> bool {
    path.starts_with('/')
        || path.starts_with('\\')
        || (path.len() > 2
            && path.as_bytes()[0].is_ascii_alphabetic()
            && path.as_bytes()[1] == b':'
            && matches!(path.as_bytes()[2], b'/' | b'\\'))
}

fn utf16_units(text: &str) -> Vec<u16> {
    let mut units = vec![];
    let mut offset = 0;
    while offset < text.len() {
        let (code, size, _) = ts_goport::scanner_util::decode_go_js_string_rune(&text[offset..]);
        if code <= u32::from(u16::MAX) {
            units.push(code as u16);
        } else if let Some(character) = char::from_u32(code) {
            units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
        }
        offset += size;
    }
    units
}

fn observe_query(fs: &CaptureFs, profile: &Profile, query: &SystemQuery) -> serde_json::Value {
    let first_issue = fs
        .workspace
        .as_ref()
        .map_or(0, |workspace| workspace.issues.borrow().len());
    let mut unsupported = BTreeSet::<String>::new();
    let mut result = match query.operation {
        SystemOperation::ReadFile => {
            let (text, found) = fs.read_file(&query.path);
            let units = found.then(|| utf16_units(&text));
            let value = units
                .as_ref()
                .and_then(|units| String::from_utf16(units).ok());
            let probe = fs.log.borrow().last().cloned().unwrap();
            serde_json::json!({"found":found,"value":value,"utf16Units":units,"physicalPath":found.then_some(probe.path),"contentId":probe.content_id,"contentIdEncoding":"ts_goport_go_string_utf8"})
        }
        SystemOperation::FileExists => serde_json::json!({"value":fs.file_exists(&query.path)}),
        SystemOperation::DirectoryExists => {
            serde_json::json!({"value":fs.directory_exists(&query.path)})
        }
        SystemOperation::Realpath => serde_json::json!({"value":fs.realpath(&query.path)}),
        SystemOperation::ReadDirectory if matches!(profile, Profile::Retained) => {
            serde_json::json!({"value":fs.retained_read_directory(&query.path)})
        }
        SystemOperation::ReadDirectory => {
            unsupported.insert("WORKSPACE_READ_DIRECTORY_UNSUPPORTED".into());
            serde_json::json!({"value":null})
        }
        SystemOperation::NativeGetAccessibleEntries => {
            let entries = fs.get_accessible_entries(&query.path);
            serde_json::json!({"value":{"files":entries.files,"directories":entries.directories}})
        }
    };
    let mut refusals = BTreeSet::new();
    if let Some(workspace) = &fs.workspace {
        for issue in workspace.issues.borrow().iter().skip(first_issue) {
            if issue.kind == "unsupported" {
                unsupported.insert(issue.detail.clone());
            } else {
                refusals.insert(issue.detail.clone());
            }
        }
    }
    result["operation"] = serde_json::json!(query.operation);
    result["path"] = serde_json::json!(query.path);
    result["executed"] = serde_json::json!(
        !matches!(query.operation, SystemOperation::ReadDirectory)
            || matches!(profile, Profile::Retained)
    );
    result["unsupported"] = serde_json::json!(unsupported);
    result["refusals"] = serde_json::json!(refusals);
    result
}

fn observe(request: serde_json::Value, sdk: Option<&Sdk>) -> Result<serde_json::Value, String> {
    let descriptor = identity::digest(&request);
    let request: SystemRequest = serde_json::from_value(request)
        .map_err(|error| format!("CAPTURED_SYSTEM_REQUEST_INVALID:{error}"))?;
    if !absolute(&request.root) {
        return Err("CAPTURED_SYSTEM_ABSOLUTE_ROOT_REQUIRED".into());
    }
    if request.queries.is_empty() || request.queries.len() > 4096 {
        return Err("CAPTURED_SYSTEM_QUERY_COUNT_INVALID".into());
    }
    if request.queries.iter().any(|query| !absolute(&query.path)) {
        return Err("CAPTURED_SYSTEM_ABSOLUTE_QUERY_PATH_REQUIRED".into());
    }
    let normalizer = CaptureFs::new(BTreeMap::new(), request.case_sensitive);
    let mut files = request
        .files
        .into_iter()
        .map(|(path, text)| (path, ts_goport::scanner_util::go_string_from_utf8(text)))
        .collect::<BTreeMap<_, _>>();
    for (path, units) in request.utf16_files {
        if files
            .insert(path, source_text::from_units(&units))
            .is_some()
        {
            return Err("CAPTURED_SYSTEM_DUPLICATE_FILE".into());
        }
    }
    for (path, raw) in request.raw_files {
        if files
            .insert(path, source_text::decode(&raw.bytes, raw.profile))
            .is_some()
        {
            return Err("CAPTURED_SYSTEM_DUPLICATE_FILE".into());
        }
    }
    match (sdk, request.sdk_directory.as_deref()) {
        (Some(sdk), Some(directory)) => {
            if sdk.version != "5.9.3"
                || sdk.archive_sha256
                    != "10e108c9cf7d5f2879053dff18515fb405abf2ccef63eaaf017d9c571687a1d3"
            {
                return Err("CAPTURED_SYSTEM_FOREIGN_SDK".into());
            }
            if !absolute(directory) {
                return Err("CAPTURED_SYSTEM_ABSOLUTE_SDK_DIRECTORY_REQUIRED".into());
            }
            let root = normalizer.key(directory);
            for (path, text) in &sdk.files {
                if !within(&root, &normalizer.key(path)) {
                    return Err("CAPTURED_SYSTEM_SDK_FILE_OUTSIDE_DIRECTORY".into());
                }
                if files
                    .insert(
                        path.clone(),
                        ts_goport::scanner_util::go_string_from_utf8(text.clone()),
                    )
                    .is_some()
                {
                    return Err("CAPTURED_SYSTEM_DUPLICATE_FILE".into());
                }
            }
        }
        (Some(_), None) => return Err("CAPTURED_SYSTEM_SDK_DIRECTORY_REQUIRED".into()),
        (None, Some(_)) => return Err("CAPTURED_SYSTEM_SDK_DESCRIPTOR_REQUIRED".into()),
        (None, None) => {}
    }
    let mut keys = BTreeSet::new();
    let mut bytes = 0_usize;
    if files.len() > 20_000 {
        return Err("CAPTURED_SYSTEM_FILE_COUNT_INVALID".into());
    }
    for (path, text) in &files {
        if !absolute(path) {
            return Err("CAPTURED_SYSTEM_ABSOLUTE_FILE_PATH_REQUIRED".into());
        }
        if !keys.insert(normalizer.key(path)) {
            return Err("CAPTURED_SYSTEM_CONFLICTING_FILE_KEY".into());
        }
        bytes = bytes
            .checked_add(text.len())
            .ok_or("CAPTURED_SYSTEM_INPUT_SIZE_INVALID")?;
    }
    if bytes > 33_554_432 {
        return Err("CAPTURED_SYSTEM_INPUT_SIZE_INVALID".into());
    }
    let fs = match request.profile {
        Profile::Retained => CaptureFs::new(files, request.case_sensitive),
        Profile::Workspace => CaptureFs::with_workspace_root(
            files,
            request.case_sensitive,
            &request.root,
            request.sdk_directory.as_deref(),
        ),
    }
    .with_sdk_keys(
        sdk.into_iter()
            .flat_map(|sdk| sdk.files.keys().map(String::as_str)),
    )?;
    let results = request
        .queries
        .iter()
        .map(|query| observe_query(&fs, &request.profile, query))
        .collect::<Vec<_>>();
    let mut unsupported = BTreeSet::new();
    for result in &results {
        for item in result["unsupported"].as_array().into_iter().flatten() {
            if let Some(item) = item.as_str() {
                unsupported.insert(item.to_string());
            }
        }
    }
    let (aliases, issues) = fs
        .workspace
        .as_ref()
        .map(|workspace| {
            (
                workspace.aliases.borrow().clone(),
                workspace.issues.borrow().clone(),
            )
        })
        .unwrap_or_default();
    Ok(
        serde_json::json!({"executed":true,"reasons":[],"unsupported":unsupported,"requestDescriptorId":descriptor,"results":results,"probes":fs.log.borrow().clone(),"workspaceMappings":aliases,"workspaceIssues":issues,"status":"development_observation_not_qualification"}),
    )
}

pub fn run(request: serde_json::Value, sdk: Option<&Sdk>) -> serde_json::Value {
    match observe(request, sdk) {
        Ok(value) => value,
        Err(error) => {
            serde_json::json!({"executed":false,"reasons":[],"unsupported":[error],"results":[],"probes":[],"workspaceMappings":{},"workspaceIssues":[]})
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/captured_system_observations.rs"]
mod tests;
