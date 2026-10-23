import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

REPO = pathlib.Path(os.environ["DEV_REPO"]).resolve()
TOOLS = REPO / "tools/rust-ts-r0/qualification/public-closure-20261022"
BUN = os.environ["DEV_BUN"]


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def save(path, value):
    write(path, json.dumps(value))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def setup(condition, message):
    if not condition:
        raise RuntimeError("INCONCLUSIVE_SETUP: " + message)


def dictionaries(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from dictionaries(child)
    elif isinstance(value, list):
        for child in value:
            yield from dictionaries(child)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


class IndependentCollectorWitnesses(unittest.TestCase):
    def setUp(self):
        setup(os.name == "posix", "Use Linux/macOS/WSL for the controlled executable")
        setup(" " not in sys.executable, "Interpreter path must work as a shebang")
        setup(shutil.which(BUN) is not None, "DEV_BUN is unavailable")
        evidence = pathlib.Path(os.environ["DEV_EVIDENCE_ROOT"])
        setup(evidence.is_absolute() and evidence.is_dir() and not evidence.is_symlink(),
              "Existing absolute ROOT-owned evidence parent required")
        setup(evidence == evidence.resolve(), "Evidence parent must be its exact resolved path")
        self.root = evidence / self._testMethodName
        setup(not self.root.exists() and not self.root.is_symlink(), "Fresh per-test evidence directory required")
        self.root.mkdir(exist_ok=False)
        setup(self.root.resolve().parent == evidence, "Test root left its exact evidence parent")
        self.invocation_count = 0
        self.baseline = self.root / "fake-baseline"
        source = self.baseline / "packages/ts-analyzer/src"
        write(self.baseline / "package.json", '{"type":"module"}')
        write(
            self.baseline / "node_modules/typescript/lib/typescript.js",
            "export default {version:'5.9.3',sys:{useCaseSensitiveFileNames:true}};",
        )
        write(
            source / "ts-symbols.ts",
            "export function extractTypeScript(){"
            "throw new Error('DEV_CONTROLLED_REFUSAL');}",
        )
        write(source / "analyze.ts", "export function analyzeRepository(){return {};}")
        write(
            source / "discovery.ts",
            "export function discoverRepository(){return {files:[],candidates:[]};}",
        )
        write(
            source / "javascript-diagnostics.ts",
            "export function inspectSourceParsing(){return [];}\n",
        )
        self.sdk = self.root / "fake-sdk.json"
        save(self.sdk, {"version": "5.9.3", "archive_sha256": "DEV", "files": {}})

    def invoke(self, argv):
        self.invocation_count += 1
        record = self.root / "invocations" / f"{self.invocation_count:03}"
        record.mkdir(parents=True, exist_ok=False)
        setup(record.resolve().is_relative_to(self.root.resolve()), "Invocation evidence left its owned test root")
        arguments = list(map(str, argv))
        started = time.monotonic()
        try:
            result = subprocess.run(
                arguments,
                cwd=self.root,
                capture_output=True,
                timeout=15,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            stdout = getattr(error, "stdout", None) or b""
            stderr = getattr(error, "stderr", None) or b""
            (record / "stdout.raw").write_bytes(stdout)
            (record / "stderr.raw").write_bytes(stderr)
            save(record / "receipt.json", {
                "argv": arguments, "cwd": str(self.root), "seconds": time.monotonic() - started,
                "timeout_seconds": 15, "exit_code": None, "error_type": type(error).__name__,
                "timed_out": isinstance(error, subprocess.TimeoutExpired),
                "stdout_sha256": digest(record / "stdout.raw"), "stderr_sha256": digest(record / "stderr.raw"),
            })
            raise RuntimeError("INCONCLUSIVE_SETUP: collector did not complete") from error
        (record / "stdout.raw").write_bytes(result.stdout)
        (record / "stderr.raw").write_bytes(result.stderr)
        save(record / "receipt.json", {
            "argv": arguments, "cwd": str(self.root), "seconds": time.monotonic() - started,
            "timeout_seconds": 15, "exit_code": result.returncode, "error_type": None, "timed_out": False,
            "stdout_sha256": digest(record / "stdout.raw"), "stderr_sha256": digest(record / "stderr.raw"),
        })
        return result

    def fake_artifact(self, name, exit_seven=False):
        artifact = self.root / (name + ".py")
        marker = self.root / (name + "-invoked")
        # Only this locally authored executable runs. No production binary.
        write(artifact, f"""#!{sys.executable}
import hashlib,json,pathlib,sys
pathlib.Path({str(marker)!r}).write_text('CONTROLLED_EXECUTABLE_RAN')
if {exit_seven!r}:
    sys.stdout.write('DEV_STDOUT_EXIT7\\n')
    sys.stderr.write('DEV_STDERR_EXIT7\\n')
    raise SystemExit(7)
if '--discover-repository' in sys.argv:
    request=json.loads(pathlib.Path(sys.argv[-1]).read_bytes())
    canonical=json.dumps(request,sort_keys=True,separators=(',',':'),ensure_ascii=False)
    observed={{
        'producer_artifact_id':'sha256:'+hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
        'request_descriptor_id':'sha256:'+hashlib.sha256(canonical.encode()).hexdigest(),
        'executed':True,'unsupported':[],'files':[],'candidates':[]
    }}
    print(json.dumps(observed))
else:
    sys.stderr.write('{{"error":"DEV_CONTROLLED_REFUSAL"}}\\n')
    raise SystemExit(1)
""")
        artifact.chmod(0o700)
        freeze = self.root / (name + "-freeze.json")
        save(freeze, {
            "artifact_path": str(artifact),
            "artifact_sha256": digest(artifact),
            "sdk_path": str(self.sdk),
            "sdk_sha256": digest(self.sdk),
        })
        return freeze, marker

    def capture(self, script, name, files, outside):
        freeze, marker = self.fake_artifact(name)
        inputs = self.root / (name + "-inputs.json")
        save(inputs, {
            "baseline": "DEV_FAKE_BASELINE",
            "units": [{
                "id": "DEV",
                "owner": "extractTypeScript",
                "retained": False,
                "qualified": False,
                "diagnostic": False,
                "obligation_indices": [],
                "files": files,
                "outside": outside,
            }],
        })
        out = self.root / (name + "-output")
        process = self.invoke([
            BUN, "--no-install", TOOLS / script, self.baseline, freeze, inputs, out
        ])
        return process, out, marker

    def test_1_confinement(self):
        # Independent successful controls establish the fake environment first.
        scripts = [
            "refusal-capture.mjs",
            "refusal-discovery-capture.mjs",
        ]
        for index, script in enumerate(scripts):
            process, out, marker = self.capture(
                script, f"control-{index}", {"main.ts": "export {};"}, {}
            )
            setup(process.returncode == 0, process.stderr.decode(errors="replace"))
            setup(marker.exists(), "Controlled executable was not reached")
            setup(json.loads((out / "result.json").read_bytes())["pass"] is True,
                  "Collector control did not pass")

            for field in ["files", "outside"]:
                name = f"escape-{index}-{field}"
                canary = self.root / (name + "-canary")
                canary.write_bytes(b"ORIGINAL_CANARY")
                # Both destinations remain inside our owned scratch envelope.
                files = {"main.ts": "export {};"}
                outside = {}
                if field == "files":
                    files["../../../" + canary.name] = "OVERWRITTEN"
                else:
                    outside["../../" + canary.name] = "OVERWRITTEN"
                process, out, marker = self.capture(
                    script, name, files, outside
                )
                self.assertEqual(
                    canary.read_bytes(), b"ORIGINAL_CANARY",
                    "TARGET_RED: fixture write escaped fresh-output-root",
                )
                self.assertNotEqual(
                    process.returncode, 0,
                    "TARGET_RED: escaping fixture was not refused",
                )

        # Pure validator witness for the Windows path separator.
        spec = importlib.util.spec_from_file_location(
            "dev_workspace_checker", TOOLS / "workspace-replay.py"
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        valid = {
            "id": "DEV",
            "queries": [{"operation": "read_file", "path": "/dev/a"}],
            "results": [{"operation": "read_file", "path": "/dev/a", "value": "a"}],
        }
        module.validate_oracle({"units": [valid]})  # setup control
        with self.assertRaises(
            ValueError,
            msg="TARGET_RED: Windows traversal identity was accepted",
        ):
            module.validate_oracle({
                "units": [{**valid, "id": "..\\outside"}]
            })

    def diagnostics(self, name, existing_work=False, existing_instrumented=False):
        inputs = self.root / (name + "-inputs.json")
        contracts = self.root / (name + "-contracts.json")
        save(inputs, {
            "obligation_indices": [],
            "units": [{
                "id": "DEV",
                "operation": "parsing",
                "path": "main.ts",
                "files": {"main.ts": "export {};"},
                "origin": "independent DEV fake baseline",
                "obligation_indices": [],
            }],
        })
        save(contracts, {"rows": []})
        work = self.root / (name + "-work")
        if existing_work:
            work.mkdir()
        instrumented = (
            self.baseline / "packages/ts-analyzer/src/"
            "diagnostics-public-closure-instrumented.ts"
        )
        if existing_instrumented:
            write(instrumented, "export const PRESERVE_THESE_BYTES = 1729;\n")
        before = {
            p.relative_to(self.baseline): p.read_bytes()
            for p in self.baseline.rglob("*") if p.is_file()
        }
        process = self.invoke([
            BUN, "--no-install", TOOLS / "diagnostics-oracle.mjs",
            self.baseline, inputs, contracts,
            self.root / (name + "-manifest.json"),
            self.root / (name + "-activation.json"), work,
        ])
        after = {
            p.relative_to(self.baseline): p.read_bytes()
            for p in self.baseline.rglob("*") if p.is_file()
        }
        return process, before, after

    def test_2_diagnostics_preserves_baseline(self):
        # No original oracle: only the locally authored return-[] export.
        process, _, _ = self.diagnostics("diagnostic-control")
        setup(process.returncode == 0, process.stderr.decode(errors="replace"))

        # Remove only the instrumentation created in this owned fake baseline.
        instrumented = (
            self.baseline / "packages/ts-analyzer/src/"
            "diagnostics-public-closure-instrumented.ts"
        )
        instrumented.unlink(missing_ok=True)

        process, before, after = self.diagnostics("existing-work", existing_work=True)
        setup(process.returncode != 0, "Existing workRoot was unexpectedly accepted")
        self.assertEqual(
            after, before,
            "TARGET_RED: rejected existing workRoot still modified baseline bytes",
        )

        process, before, after = self.diagnostics(
            "existing-instrumented", existing_instrumented=True
        )
        self.assertEqual(
            after, before,
            "TARGET_RED: preexisting baseline instrumentation was overwritten",
        )
        # An isolated-copy implementation may succeed; explicit refusal is also
        # acceptable, provided its diagnostic identifies the existing output.
        if process.returncode != 0:
            diagnostic = process.stderr.decode(errors="replace").lower()
            setup(
                any(token in diagnostic for token in ["exist", "eexist", "fresh"]),
                "Failure was not attributable to existing output",
            )

    def test_3_nonzero_process_evidence_is_retained(self):
        freeze, marker = self.fake_artifact("exit-seven", exit_seven=True)
        oracle = self.root / "workspace-oracle.json"
        save(oracle, {
            "authority": {"caseSensitive": True},
            "units": [{
                "id": "DEV",
                "root": "/dev",
                "files": {"/dev/a": "a"},
                "queries": [{"operation": "read_file", "path": "/dev/a"}],
                "results": [{"operation": "read_file", "path": "/dev/a", "value": "a"}],
            }],
        })
        out = self.root / "workspace-output"
        process = self.invoke([
            sys.executable, TOOLS / "workspace-replay.py", oracle, freeze, out
        ])
        setup(marker.exists(), "Controlled executable was not reached")

        result = out / "result.json"
        self.assertTrue(
            result.exists(),
            "TARGET_RED: exit7 discarded the structured NONPASS report",
        )
        summary = json.loads(result.read_bytes())
        self.assertIs(
            summary.get("pass"), False,
            "TARGET_RED: exit7 must remain NONPASS",
        )

        records = []
        raw = []
        for path in out.rglob("*"):
            if not path.is_file():
                continue
            content = path.read_bytes()
            raw.append(content)
            try:
                records.append(json.loads(content))
            except (ValueError, UnicodeDecodeError):
                pass

        self.assertTrue(
            any(
                any(row.get(key) == 7 for key in ["exit_code", "status", "returncode"])
                for record in records for row in dictionaries(record)
            ),
            "TARGET_RED: retained process evidence lost exit code7",
        )
        retained_strings = [
            text for record in records for text in strings(record)
        ]
        for expected in ["DEV_STDOUT_EXIT7\n", "DEV_STDERR_EXIT7\n"]:
            self.assertTrue(
                expected in retained_strings or expected.encode() in raw,
                "TARGET_RED: retained process evidence lost " + repr(expected),
            )
        self.assertNotEqual(
            process.returncode, 0,
            "TARGET_RED: exit7 collection must signal failure",
        )


if __name__ == "__main__":
    unittest.main()
