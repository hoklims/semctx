"""Prepare the independently frozen token witnesses without executing any program."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile

PACKAGE_SHA = 'c15fd7803a612c3977913c0662af91287ae6125992ba09a76d000af32583337b'
MANIFEST_SHA = '58036fdf209e27bb8d37027b29afc3b8646c3671dfd9e09dfa22f0421b46f3e5'
EXPECTED_SHA = '9b268653eb2c6d6fd06fa8104fc1fffd52960a0da68a12c0414496caae85a675'
OPTIONS = {'target': 'ES2022', 'module': 'ESNext', 'moduleResolution': 'Bundler', 'allowJs': True,
           'jsx': 'Preserve', 'skipLibCheck': True, 'noEmit': True, 'strict': False}
BASELINE_OPTIONS = {'target': 9, 'module': 99, 'moduleResolution': 100, 'allowJs': True,
                    'jsx': 1, 'skipLibCheck': True, 'noEmit': True, 'strict': False}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def prepare(package):
    package = Path(package).resolve()
    require(digest((package/'package-pin.json').read_bytes()) == PACKAGE_SHA, 'token package pin differs')
    pins = json.loads((package/'package-pin.json').read_text(encoding='utf-8'))
    for item in pins['files']:
        name = item['path']
        require(Path(name).name == name and name not in {'.', '..'}, 'unsafe token package member')
        data = (package/name).read_bytes()
        require(len(data) == item['bytes'] and digest(data) == item['sha256'], 'token package member differs: '+name)
    require(digest((package/'manifest.json').read_bytes()) == MANIFEST_SHA, 'token manifest differs')
    require(digest((package/'expected.json').read_bytes()) == EXPECTED_SHA, 'token expectations differ')
    manifest = json.loads((package/'manifest.json').read_text(encoding='utf-8'))
    entries = manifest['files']
    # Archives are read in memory only. No extraction, baseline replay or native call.
    archive = base64.b64decode((package/'lot.tar.gz.b64').read_bytes(), validate=False)
    files, source_pins = {}, {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        for relative in ['main.ts', 'package.json']:
            name = 'fixture/'+relative
            matches = [member for member in bundle.getmembers() if member.name.removeprefix('./') == name]
            require(len(matches) == 1 and matches[0].isfile(), 'token fixture member absent or ambiguous')
            stream = bundle.extractfile(matches[0])
            require(stream is not None, 'token fixture stream absent')
            data = stream.read()
            expected = next((item for item in entries if item['path'] == name), None)
            require(expected is not None and digest(data) == expected['sha256'] and len(data) == expected['bytes'], 'token fixture differs from frozen manifest')
            files[relative] = data.decode('utf-8')
            source_pins[relative] = {'sha256': digest(data), 'bytes': len(data)}
        raw_member = bundle.getmember('./raw-observations.json')
        require(raw_member.isfile(), 'baseline token observation member is not regular')
        stream = bundle.extractfile(raw_member)
        require(stream is not None, 'baseline token observations absent')
        raw_bytes = stream.read()
        raw_pin = next(item for item in entries if item['path'] == 'raw-observations.json')
        require(digest(raw_bytes) == raw_pin['sha256'] and len(raw_bytes) == raw_pin['bytes'],
                'baseline token observations differ from frozen bytes')
        raw = json.loads(raw_bytes)
        programs = [record for row in raw['revalidation'] for record in row['actualProgramRecords']]
        require(len(programs) == 21, 'baseline token Program count differs')
        for record in programs:
            require(record['options'] == BASELINE_OPTIONS, 'baseline token compiler options differ')
            require(len(record['rootNames']) == 1 and record['rootNames'][0].replace('\\', '/').endswith('/fixture/main.ts'),
                    'baseline token Program roots differ')
            retained = {Path(name.replace('\\', '/')).name: text for name, text in record['retained']}
            require(len(record['retained']) == 2 and retained == files, 'baseline retained Map source bytes differ')
    expected = json.loads((package/'expected.json').read_text(encoding='utf-8'))
    require(len(expected['issuance']) == 13 and len(expected['revalidation']) == 7,
            'token frozen expected denominator differs')
    return {'kind': 'INDEPENDENT_TOKEN_GUARD_FAMILY', 'execution_enabled': False,
            'candidate_execution_authorized': False, 'package_root': str(package),
            'package_pin_sha256': PACKAGE_SHA, 'manifest_sha256': MANIFEST_SHA,
            'expected_sha256': EXPECTED_SHA, 'expected': expected,
            'source_pins': source_pins, 'counts': {'issuance': 13, 'revalidation': 7, 'map_identity': 1},
            'baseline_program_options': BASELINE_OPTIONS, 'baseline_program_records_joined': 21,
            'baseline_retained_map_bytes_joined': True,
            'baseline_actual_program_records': 21, 'native_queries': 0, 'planned_native_queries': 1,
            'request_template': {'id': 'independent-token-guards', 'cwd': '$ROOT', 'sdk_directory': '/sdk/lib',
                'roots': ['main.ts'], 'files': files, 'options': OPTIONS, 'retained': True,
                'qualified': True, 'roles': {}, 'selection': {}, 'disabled': [],
                'utf16_files': {}, 'raw_files': {}},
            'qualified': False, 'qualification_credit': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), 'token plan output already exists')
    value = prepare(args.package)
    args.output.write_text(json.dumps(value, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
