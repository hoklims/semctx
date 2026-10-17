"""Execute documented success-only replay blocks with bounded shell stubs."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BASH = (
    shutil.which(
        "bash",
        path=str(Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin"),
    )
    if os.name == "nt"
    else shutil.which("bash")
)
STUBS = r"""
export RUN="$PWD"
export RESEARCH="$RUN/research"
mkdir -p "$RUN/raw" "$RUN/tools"
record_probe() {
  count=0
  if [ -f "$RUN/count" ]; then read -r count < "$RUN/count"; fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$RUN/count"
  printf '%s' "$count" >> "$RUN/invocations"
  printf '\t%s' "$@" >> "$RUN/invocations"
  printf '\n' >> "$RUN/invocations"
  printf 'probe %s\n' "$count"
  printf 'timing %s\n' "$count" >&2
  if [ "$count" -eq "$FAIL_AT" ]; then return 42; fi
}
export -f record_probe
function /usr/bin/time() { record_probe "$@"; }
cat > "$RUN/tools/scip" <<'STUB'
#!/usr/bin/env bash
record_probe scip "$@"
STUB
chmod +x "$RUN/tools/scip"
"""


@unittest.skipUnless(BASH, "documented shell replay requires Bash")
class ReplayStatusTests(unittest.TestCase):
    def block(self, section):
        source = (ROOT / "docs/research/rust-indexing/replay.md").read_text(
            encoding="utf-8"
        )
        heading = f"## {section} — "
        self.assertEqual(source.count(heading), 1)
        return source.split(heading, 1)[1].split("```sh\n", 1)[1].split("\n```", 1)[0]

    def expected_calls(self, section):
        calls = []
        for n in range(1, 4):
            for name, project in (
                ("fixture", "fixture"),
                ("pico", "corpus/pico-args-0.5.0"),
            ):
                if section == "L":
                    args = [
                        "-l",
                        "python3",
                        "scripts/rust-indexing-lsp.py",
                        "<RUN>/tools/rust-analyzer",
                        f"<RUN>/research/{project}",
                        "app/src/main.rs" if name == "fixture" else "src/lib.rs",
                    ]
                    if name == "pico":
                        args += [
                            "--line",
                            "124",
                            "--character",
                            "14",
                            "--definition-line",
                            "125",
                            "--definition-character",
                            "14",
                        ]
                else:
                    args = [
                        "-l",
                        "<RUN>/tools/rust-analyzer",
                        "scip",
                        f"<RUN>/research/{project}",
                        "--output",
                        f"<RUN>/raw/{name}-{n}.scip",
                        "--num-threads",
                        "4",
                    ]
                calls.append(args)
        if section == "S":
            calls.extend(
                ["scip", "print", "--json", f"<RUN>/raw/{name}-1.scip"]
                for name in ("fixture", "pico")
            )
        return calls

    def check_replay(self, section, fail_at):
        with tempfile.TemporaryDirectory(prefix="replay status ") as directory:
            run = Path(directory)
            result = subprocess.run(
                [BASH, "--noprofile", "--norc", "-c", STUBS + self.block(section)],
                cwd=run,
                env={**os.environ, "FAIL_AT": str(fail_at)},
                capture_output=True,
                text=True,
                check=False,
            )
            # Establish that the real block reached the stub before asserting status.
            invocation_file = run / "invocations"
            self.assertTrue(invocation_file.exists(), result.stderr)
            rows = [
                line.split("\t") for line in invocation_file.read_text().splitlines()
            ]
            self.assertEqual(
                [int(row[0]) for row in rows], list(range(1, len(rows) + 1))
            )
            if fail_at:
                self.assertGreaterEqual(len(rows), fail_at)
            self.assertEqual(result.returncode, 42 if fail_at else 0, result.stderr)
            calls = self.expected_calls(section)
            count = fail_at or len(calls)
            self.assertEqual(len(rows), count)
            # Bash's $PWD uses POSIX paths even on native Windows.
            shell_run = rows[0][4 if section == "L" else 2].removesuffix(
                "/tools/rust-analyzer"
            )
            self.assertEqual(
                [[arg.replace(shell_run, "<RUN>") for arg in row[1:]] for row in rows],
                calls[:count],
            )
            expected_files = {}
            for index in range(1, count + 1):
                if index <= 6:
                    name = "fixture" if index % 2 else "pico"
                    n = (index + 1) // 2
                    prefix = f"{name}-lsp-{n}" if section == "L" else f"{name}-{n}"
                    suffix = ".json" if section == "L" else ".stdout"
                    expected_files[prefix + suffix] = f"probe {index}\n"
                    expected_files[prefix + ".time"] = f"timing {index}\n"
                else:
                    name = "fixture" if index == 7 else "pico"
                    expected_files[f"{name}-1.json"] = f"probe {index}\n"
            self.assertEqual(
                {path.name: path.read_text() for path in (run / "raw").iterdir()},
                expected_files,
            )
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                result.stderr,
                ""
                if count <= 6
                else "".join(f"timing {index}\n" for index in range(7, count + 1)),
            )

    def test_all_success_keeps_repeats_arguments_and_redirects(self):
        for section in ("L", "S"):
            with self.subTest(section=section):
                self.check_replay(section, 0)

    def test_failure_stops_and_preserves_status(self):
        for section, failures in (("L", range(1, 7)), ("S", range(1, 9))):
            for fail_at in failures:
                with self.subTest(section=section, fail_at=fail_at):
                    self.check_replay(section, fail_at)


if __name__ == "__main__":
    unittest.main()
