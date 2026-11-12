"""Acquire the separately frozen two-context public witness; never award credit."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

FREEZE = 'c63f6c126b5a91155fb379034a1c756f3f2f0de487e5bfc628529a5a506f550b'
ORACLE = 'e735077c8e4a2331cae55b3e3779225ba971537d70a8834fc9937675f46ccb2f'
READER = 'c4e62e6ce82b2e6675f572c8ceb115d70d0d66c8ad8df59ea12ed6ef7579c4b8'
BUNDLE = Path('docs/research/rust-ts-r0/cases/supplement-as-expression-20261022')
CAPSULE = '8e69b0e77961542118cb0b721c455ff90a02288014318ff4185e44961cf9bc6c'
IGNORED_CAPSULE_DATA = {
    'manifest.frozen.json', 'native_preflight.py', 'execute_native_v2.py', 'public96_preflight.py',
    'native-bindings.actual.disabled.json', 'prepare_staging.py', 'test_execution_guards.py',
    'execution-guard-controls.json', 'STAGING-FREEZE.json', 'EXECUTION-FREEZE-V2.json',
}
CONTEXTS = ('legacy', 'retained')
CAP = 8_388_608

CALLER = r'''use semctx_gates::process;
use sha2::{Digest, Sha256};
use std::{env, fs, path::Path};
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn need(value: bool, message: &str) -> Result<(), String> {
    if value { Ok(()) } else { Err(message.into()) }
}
fn checked(spec: &serde_json::Value) -> Result<(), String> {
    need(
        spec["execution_authorized"] == true
            && spec["timeout_ms"] == 20_000
            && spec["output_cap"] == 8_388_608,
        "exact authority/budget required",
    )?;
    for pin in spec["pins"].as_array().ok_or("pins required")? {
        let path = pin["path"].as_str().ok_or("pin path required")?;
        need(Path::new(path).is_absolute(), "absolute pin required")?;
        need(
            sha(&fs::read(path).map_err(|e| e.to_string())?)
                == pin["sha256"].as_str().ok_or("pin digest required")?,
            "input/tool drift",
        )?;
    }
    Ok(())
}
fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    need(
        args.len() == 3,
        "spec, new output and independent spec SHA required",
    )?;
    let raw_spec = fs::read(&args[0]).map_err(|e| e.to_string())?;
    need(sha(&raw_spec) == args[2], "external spec byte pin differs")?;
    let spec: serde_json::Value = serde_json::from_slice(&raw_spec).map_err(|e| e.to_string())?;
    checked(&spec)?;
    let argv: Vec<String> = spec["argv"]
        .as_array()
        .ok_or("argv required")?
        .iter()
        .map(|v| v.as_str().map(String::from).ok_or("string argv required"))
        .collect::<Result<_, _>>()?;
    need(argv.len() == 3, "exact direct candidate argc required")?;
    let cwd = spec["cwd"].as_str().ok_or("cwd required")?;
    let helper = spec["helper"].as_str().ok_or("helper required")?;
    need(
        Path::new(cwd).is_absolute() && Path::new(helper).is_absolute(),
        "absolute paths required",
    )?;
    let output = Path::new(&args[1]);
    fs::create_dir(output).map_err(|e| e.to_string())?;
    process::install_cancellation();
    let outcome =
        process::run_with_helper(&argv, Path::new(cwd), 20_000, 8_388_608, Path::new(helper))
            .map_err(|e| e.to_string())?;
    // Outcome strings are bounded UTF-8 decodings, potentially lossy/truncated.
    // Keep compatibility filenames and original read counts/hashes separately.
    fs::write(output.join("stdout.raw"), outcome.stdout.as_bytes()).map_err(|e| e.to_string())?;
    fs::write(output.join("stderr.raw"), outcome.stderr.as_bytes()).map_err(|e| e.to_string())?;
    fs::write(
        output.join("process-outcome.json"),
        serde_json::to_vec_pretty(&outcome).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let storage = serde_json::json!({
        "representation": "bounded_utf8_decoded_ProcessOutcome_strings",
        "decoder": "String::from_utf8_lossy",
        "raw_suffix_is_compatibility_filename": true,
        "original_read_counts_and_hashes": "process-outcome.json",
        "original_capture_cap_bytes_per_stream": 8_388_608,
        "maximum_decoded_utf8_bytes_per_stream": 25_165_824,
        "exactness": "Only successful, nontruncated streams whose stored lengths and SHA256 equal the original outcome are accepted."
    });
    fs::write(
        output.join("capture-storage.json"),
        serde_json::to_vec_pretty(&storage).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    checked(&spec)?;
    println!("{{\"captured\":true}}");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
'''


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(Path(path).read_bytes())


def save(path, value):
    with Path(path).open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def inspect_capsule(raw, manifest_raw):
    """Read a finite regular-file archive as data; never extract or execute it."""
    require(hashlib.sha256(manifest_raw).hexdigest() == FREEZE, 'public witness freeze differs')
    manifest = json.loads(manifest_raw)
    require(len(manifest['files']) == 23, 'public witness file count differs')
    expected = {}
    for row in manifest['files']:
        require(row['path'] not in expected, 'duplicate frozen path')
        expected[row['path']] = row
    seen, members, total = set(), {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive:
            name, path = member.name, PurePosixPath(member.name)
            require(path.as_posix() == name and not path.is_absolute() and
                    all(p not in ('.', '..') and not p.endswith(('.', ' ')) for p in path.parts) and
                    '\\' not in name and ':' not in name and not any(ord(c) < 32 for c in name),
                    'noncanonical capsule member')
            require(name not in seen, 'duplicate capsule member')
            require(member.type in (tarfile.REGTYPE, tarfile.AREGTYPE), 'regular capsule members only')
            require(name in expected or name in IGNORED_CAPSULE_DATA, 'foreign capsule member')
            total += member.size
            require(0 <= member.size <= 16_777_216 and total <= 16_777_216, 'capsule decoded budget exceeded')
            seen.add(name)
            stream = archive.extractfile(member)
            require(stream is not None, 'capsule member unreadable')
            data = stream.read()
            require(len(data) == member.size, 'capsule member byte count differs')
            if name in expected:
                pin = expected[name]
                require(len(data) == pin['bytes'] and hashlib.sha256(data).hexdigest() == pin['sha256'],
                        'frozen witness member bytes differ')
                members[name] = data
            elif name == 'manifest.frozen.json':
                require(data == manifest_raw, 'embedded/external manifest differs')
    require(seen == set(expected) | IGNORED_CAPSULE_DATA and len(seen) == 33,
            'capsule required member inventory differs')
    require(hashlib.sha256(members['expected-oracle.json']).hexdigest() == ORACLE and
            hashlib.sha256(members['read_public.py']).hexdigest() == READER,
            'independent oracle/reader pin differs')
    return members


def bundle_pins(folder):
    require(sha(folder/'capsule.tar.gz') == CAPSULE, 'public witness capsule differs')
    inspect_capsule((folder/'capsule.tar.gz').read_bytes(), (folder/'manifest.frozen.json').read_bytes())
    return {str((folder/'capsule.tar.gz').resolve()): CAPSULE,
            str((folder/'manifest.frozen.json').resolve()): FREEZE}


def materialize_bundle(package, output):
    require(not output.exists(), 'new materialized witness directory required')
    bundle_pins(package)
    manifest_raw = (package/'manifest.frozen.json').read_bytes()
    members = inspect_capsule((package/'capsule.tar.gz').read_bytes(), manifest_raw)
    output.mkdir()
    for name, raw in members.items():
        path = output/name
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as stream:
            stream.write(raw)
        require(hashlib.sha256(path.read_bytes()).hexdigest() == hashlib.sha256(raw).hexdigest(),
                'materialized witness bytes differ')
    with (output/'manifest.frozen.json').open('xb') as stream:
        stream.write(manifest_raw)
    return {str(path.resolve()): sha(path) for path in output.rglob('*') if path.is_file()}


def import_reader(folder, artifact):
    require(len(artifact) == 64 and set(artifact) <= set('0123456789abcdef'), 'artifact pin required')
    # The frozen reader gets its Windows producer pin from the already finalized
    # owned build receipt, before any candidate result exists. No oracle changes.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(folder.resolve()))
    try:
        spec = importlib.util.spec_from_file_location('_frozen_public_as_reader', folder/'read_public.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        require(Path(sys.modules['identity_scope_reader'].__file__).resolve() ==
                (folder/'identity_scope_reader.py').resolve(), 'foreign reader dependency import')
    finally:
        sys.path.pop(0)
    module.ARTIFACT['windows'] = artifact
    return module


def unchanged(pins):
    require(all(sha(path) == digest for path, digest in pins.items()), 'public witness input/tool drift')


def native_path(path):
    """Use one explicit drive-verbatim namespace for actual Windows inputs."""
    value = path.resolve(strict=True).as_posix()
    if value.startswith('//?/'):
        require(len(value) > 7 and value[4].isalpha() and value[5:7] == ':/', 'foreign Windows path namespace')
        return value
    require(len(value) > 3 and value[0].isalpha() and value[1:3] == ':/', 'drive-local Windows input required')
    return '//?/'+value


def prepare_inputs(folder, root, sdk_input):
    require(not root.exists(), 'public witness inputs already exist; no retry')
    supplied, expected = load(sdk_input), load(folder/'sdk.frozen.json')
    def by_name(sdk):
        files = {Path(p).name: t for p, t in sdk['files'].items()}
        require(len(files) == len(sdk['files']) == 100, 'SDK basename/census differs')
        return files
    require(supplied['version'] == expected['version'] == '5.9.3' and
            supplied['archive_sha256'] == expected['archive_sha256'] and
            by_name(supplied) == by_name(expected), 'prepared SDK differs from frozen reference')
    root.mkdir()
    project, sdk_root = root/'repo', root/'sdk'
    project.mkdir(); sdk_root.mkdir()
    probe = root/'case-probe'
    probe.write_bytes(b'case\n')
    sensitive = not (root/'CASE-PROBE').exists()
    probe.unlink()
    save(root/'case-probe.json', {'case_sensitive': sensitive,
                                'method': 'owned lowercase probe, then uppercase existence check'})
    require(sensitive is False, 'this Windows witness profile requires measured insensitive case semantics')
    source = project/'entry.ts'
    source.write_bytes((folder/'fixture/repo/entry.ts').read_bytes())
    libraries = {}
    for name, text in by_name(supplied).items():
        path = sdk_root/name
        path.write_bytes(text.encode('utf-8'))
        libraries[native_path(path)] = text
    sdk = {'version': supplied['version'], 'archive_sha256': supplied['archive_sha256'], 'files': libraries}
    save(root/'sdk.json', sdk)
    for context in CONTEXTS:
        request = load(folder/('request.'+context+'.local.json'))
        request.update(cwd=native_path(project), sdk_directory=native_path(sdk_root), case_sensitive=sensitive,
                       roots=[native_path(source)], files={native_path(source): source.read_text(encoding='utf-8')})
        save(root/('request.'+context+'.json'), request)
    return {str(path.resolve()): sha(path) for path in root.rglob('*') if path.is_file()}


def compile_caller(repo, out, env, run):
    """One extra transport build; separate from the four existing Cargo artifacts."""
    from native_build_identity import environment_snapshot
    build = out/'caller-build'
    build.mkdir()
    source = build/'caller.rs'
    source.write_text(CALLER, encoding='utf-8', newline='\n')
    dependencies = repo/'tools/gates/target/release/deps'
    externs = {}
    for crate in ('semctx_gates', 'serde_json', 'sha2'):
        choices = list(dependencies.glob('lib'+crate+'-*.rlib'))
        require(len(choices) == 1, 'one current release rlib required: '+crate)
        externs[crate] = choices[0].resolve()
    pins = {str(path.resolve()): sha(path) for path in dependencies.iterdir() if path.is_file()}
    pins[str(source.resolve())] = sha(source)
    before = environment_snapshot(env)
    rustc_lookup = run(repo, build, 'rustc-path', ['rustup', 'which', '--toolchain', '1.95.0', 'rustc'], env, timeout=30)
    require(type(rustc_lookup['exit_code']) is int and rustc_lookup['exit_code'] == 0, 'rustc resolution failed')
    rustc = Path((build/'rustc-path.stdout').read_text(encoding='utf-8').strip()).resolve(strict=True)
    pins[str(rustc)] = sha(rustc)
    target = build/'public-as-caller.exe'
    argv = [str(rustc), '--edition=2024', '--crate-name', 'public_as_caller', str(source), '-O',
            '-L', 'dependency='+str(dependencies.resolve())]
    for crate, path in externs.items():
        argv.extend(['--extern', crate+'='+str(path)])
    argv.extend(['-o', str(target)])
    unchanged(pins)
    result = run(repo, build, 'caller-compile', argv, env, timeout=120)
    unchanged(pins)
    require(type(result['exit_code']) is int and result['exit_code'] == 0 and target.is_file(), 'caller build failed')
    require(environment_snapshot(env) == before, 'transport build environment drift')
    receipt = {'kind': 'ADDITIONAL_TRANSPORT_CALLER_BUILD_NOT_C1_OR_CARGO_ARTIFACT', 'attempts': 1,
               'argv': argv, 'exit_code': result['exit_code'], 'environment_before': before,
               'environment_after': environment_snapshot(env), 'input_tool_pins': pins,
               'artifact_path': str(target), 'artifact_sha256': sha(target),
               'cargo_artifact_set_changed': False, 'candidate_queries': 0, 'qualification_credit': 0}
    save(build/'build-binding.json', receipt)
    return target, {**pins, str(target.resolve()): sha(target), str((build/'build-binding.json').resolve()): sha(build/'build-binding.json')}


def validate_outcome(directory):
    outcome = load(directory/'process-outcome.json')
    for stream in ('stdout', 'stderr'):
        raw = (directory/(stream+'.raw')).read_bytes()
        require(type(outcome[stream+'_bytes']) is int and len(raw) == outcome[stream+'_bytes'] <= CAP,
                'actual stream size/cap differs')
        require(hashlib.sha256(raw).hexdigest() == outcome[stream+'_hash'], 'actual stream hash differs')
    require(outcome['kind'] == 'success' and type(outcome['exit_code']) is int and outcome['exit_code'] == 0,
            'candidate outcome non-success; no retry')
    return json.loads((directory/'stdout.raw').read_bytes())


def acquire(repo, out, fixture, env, run, source_check, *, authorized=False):
    from native_build_identity import validate_frozen_document
    require(authorized is True and fixture.get('candidate_execution_authorized') is True and
            fixture.get('optimized_frozen') is True and fixture.get('platform') == 'windows',
            'additional Windows witness authorization absent')
    validate_frozen_document(fixture['build_environment_path'], fixture, fixture['source_head'])
    package = repo/BUNDLE
    pins = bundle_pins(package)
    pins.update({str(Path(fixture[k+'_path']).resolve()): fixture[k+'_sha256']
                 for k in ('artifact', 'helper', 'transport_fixture', 'qualification_observer')})
    pins[str(Path(fixture['build_environment_path']).resolve())] = fixture['build_environment_sha256']
    pins[str(Path(fixture['sdk_path']).resolve())] = fixture['sdk_sha256']
    pins[str(Path(__file__).resolve())] = sha(__file__)
    source_check(); unchanged(pins)
    root = out/'public-as-expression'
    require(not root.exists(), 'public witness acquisition already attempted')
    root.mkdir()
    save(root/'one-shot-claim.json', {'attempt': 1, 'contexts': list(CONTEXTS), 'qualification_credit': 0})
    state, failure, contexts, attempts = 'FAILED', None, [], []
    before = dict(pins)
    try:
        folder = root/'frozen-witness'
        pins.update(materialize_bundle(package, folder))
        inputs = root/'inputs'
        pins.update(prepare_inputs(folder, inputs, fixture['sdk_path']))
        caller, caller_pins = compile_caller(repo, root, env, run)
        pins.update(caller_pins)
        reader = import_reader(folder, fixture['artifact_sha256'])
        sdk = load(inputs/'sdk.json')
        for context in CONTEXTS:
            source_check(); unchanged(pins)
            request_path = inputs/('request.'+context+'.json')
            request = load(request_path)
            reader.check_inputs('windows', context, request, sdk)
            spec = {'execution_authorized': True, 'timeout_ms': 20_000, 'output_cap': CAP,
                    'argv': [fixture['artifact_path'], str(request_path), str(inputs/'sdk.json')],
                    'cwd': request['cwd'], 'helper': fixture['helper_path'],
                    'pins': [{'path': p, 'sha256': digest} for p, digest in sorted(pins.items())]}
            spec_path = root/(context+'.spec.json')
            save(spec_path, spec)
            spec_digest = sha(spec_path)
            attempts.append(context)
            result = run(repo, root, context+'-caller', [str(caller), str(spec_path), str(root/context), spec_digest], env,
                         timeout=45, required=False)
            require(sha(spec_path) == spec_digest, 'caller spec drift')
            require(type(result['exit_code']) is int and result['exit_code'] == 0, 'bounded transport caller failed; no retry')
            observed = validate_outcome(root/context)
            adjudication = reader.read('windows', context, request, sdk, observed)
            save(root/context/'adjudication.json', adjudication)
            contexts.append({'context': context, 'adjudication': adjudication,
                             'outcome_sha256': sha(root/context/'process-outcome.json'),
                             'request_sha256': sha(request_path), 'spec_sha256': sha(spec_path)})
        state = 'PASS_PUBLIC_AS_EXPRESSION_TWO_CONTEXTS_NOT_QUALIFICATION'
    except Exception as error:
        failure = str(error)
        raise
    finally:
        postflight_ok, postflight_error = False, None
        try:
            source_check(); unchanged(pins)
            postflight_ok = True
        except Exception as error:
            postflight_error = str(error)
            state = 'FAILED'
            diagnostic = 'additional witness postflight drift: '+postflight_error
            failure = diagnostic if failure is None else failure+'; '+diagnostic
        report = {'kind': 'PUBLIC_AS_EXPRESSION_WINDOWS_ADDITIONAL_WITNESS', 'state': state,
                  'source_head': fixture['source_head'], 'platform': 'windows',
                  'producer_artifact_sha256': fixture['artifact_sha256'],
                  'build_environment_sha256': fixture['build_environment_sha256'],
                  'sdk_container_sha256': fixture['sdk_sha256'],
                  'stream_storage': 'bounded UTF8-decoded ProcessOutcome strings; .raw names are compatibility only',
                  'exact_stream_rule': 'success, nontruncated, stored byte counts and SHA256 equal original outcome; cap enforced',
                  'frozen_manifest_sha256': FREEZE, 'oracle_sha256': ORACLE, 'reader_sha256': READER,
                  'opaque_capsule_sha256': CAPSULE, 'expected_materialized_frozen_files': 23,
                  'materialized_frozen_files': sum(p.is_file() for p in (root/'frozen-witness').rglob('*')
                                                 if p.name != 'manifest.frozen.json'),
                  'ignored_controller_data_member_policy': 10,
                  'attempts': 1, 'contexts': contexts, 'candidate_phases_completed': len(contexts),
                  'caller_invocations_attempted': attempts,
                  'candidate_outcomes_recorded': sum((root/c/'process-outcome.json').is_file() for c in CONTEXTS),
                  'expected_candidate_phases': 2, 'postflight_ok': postflight_ok, 'postflight_error': postflight_error,
                  'failure': failure, 'initial_input_tool_pins': before, 'final_input_tool_pins': pins,
                  'original_denominators_changed': False, 'qualification_credit': 0, 'R0_decision': None}
        save(root/'report.json', report)
        require(postflight_ok, 'additional witness postflight drift: '+str(postflight_error))
    return root/'report.json'
