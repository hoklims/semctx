"""Exercise the research replay's documented materialization, not product crates."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
RESEARCH = ROOT / "docs/research/rust-indexing"


class ResearchReplayTests(unittest.TestCase):
    def materialize(self, run):
        source = (RESEARCH / "replay.md").read_text(encoding="utf-8")
        blocks = source.split("python3 - <<'PY' || exit 1\n")
        self.assertEqual(len(blocks), 2, "one executable materialization recipe")
        code = blocks[1].split("\nPY", 1)[0]
        return subprocess.run(
            [sys.executable, "-B", "-c", code],
            cwd=ROOT,
            env={**os.environ, "RUN": str(run)},
            capture_output=True,
            text=True,
            check=False,
        )

    def test_materializes_exact_manifest_bytes_in_scratch(self):
        with tempfile.TemporaryDirectory(prefix="research replay ") as directory:
            run = Path(directory)
            result = self.materialize(run)
            self.assertEqual(result.returncode, 0, result.stderr)
            snapshots = sorted(RESEARCH.rglob("Cargo.toml.snapshot"))
            self.assertEqual(len(snapshots), 8)
            self.assertEqual(list(RESEARCH.rglob("Cargo.toml")), [])
            for snapshot in snapshots:
                target = run / "rust-indexing" / snapshot.relative_to(RESEARCH)
                self.assertFalse(target.exists())
                self.assertEqual(
                    target.with_name("Cargo.toml").read_bytes(), snapshot.read_bytes()
                )
            self.assertEqual(
                (run / "rust-indexing/fixture/domain/src/lib.rs").read_bytes(),
                (RESEARCH / "fixture/domain/src/lib.rs").read_bytes(),
            )

    def test_refuses_existing_destination_without_overwriting(self):
        with tempfile.TemporaryDirectory(prefix="research replay ") as directory:
            run = Path(directory)
            destination = run / "rust-indexing"
            destination.mkdir()
            sentinel = destination / "sentinel"
            sentinel.write_bytes(b"keep")
            result = self.materialize(run)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FileExistsError", result.stderr)
            self.assertEqual(sentinel.read_bytes(), b"keep")
            self.assertEqual(list(destination.iterdir()), [sentinel])


if __name__ == "__main__":
    unittest.main()
