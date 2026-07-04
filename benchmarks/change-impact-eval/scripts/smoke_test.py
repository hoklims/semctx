#!/usr/bin/env python3
"""Smoke test for benchmark portability. Runs no evaluation; touches no corpus.

Checks:
  1. no absolute machine paths remain in the versioned scripts;
  2. missing SEMCTX_BENCH_REPO_ROOT exits non-zero with guidance;
  3. a configured environment builds the expected paths (without running the eval).

Run:  python scripts/smoke_test.py   (exit 0 = pass)
"""
import os
import re
import subprocess
import sys

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
SELF = os.path.basename(__file__)

# Patterns assembled from fragments so this file does not itself contain the literal
# absolute-path strings it forbids (keeps `git grep` for those strings clean).
DRIVE = re.compile(r"^[A-Za-z]:[\\/]", re.M)
USERS = re.compile("/" + "Users" + "/")
HOME = re.compile("/" + "home" + "/")


def check_no_absolute_paths():
    bad = []
    for fn in sorted(os.listdir(SCRIPTS_DIR)):
        if not fn.endswith(".py") or fn == SELF:
            continue
        text = open(os.path.join(SCRIPTS_DIR, fn), encoding="utf-8").read()
        for rx, name in ((DRIVE, "drive-letter"), (USERS, "users-home"), (HOME, "home-dir")):
            if rx.search(text):
                bad.append(f"{fn}: {name}")
    assert not bad, f"absolute machine paths found in versioned scripts: {bad}"
    print("[ok] no absolute machine paths in versioned scripts")


def check_missing_config_fails():
    env = {k: v for k, v in os.environ.items() if k != "SEMCTX_BENCH_REPO_ROOT"}
    code = f"import sys; sys.path.insert(0, r'{SCRIPTS_DIR}'); import bench_config; bench_config.repo_root()"
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert r.returncode != 0, "expected non-zero exit when SEMCTX_BENCH_REPO_ROOT is unset"
    assert "SEMCTX_BENCH_REPO_ROOT" in r.stderr, r.stderr
    print("[ok] missing SEMCTX_BENCH_REPO_ROOT exits non-zero with guidance")


def check_configured_paths():
    env = dict(os.environ)
    env["SEMCTX_BENCH_REPO_ROOT"] = SCRIPTS_DIR  # any existing dir satisfies the existence check
    env["SEMCTX_BENCH_WORKDIR"] = os.path.join(SCRIPTS_DIR, "_wd")
    env["SEMCTX_BENCH_OUTPUT_DIR"] = os.path.join(SCRIPTS_DIR, "_out")
    code = (
        f"import sys; sys.path.insert(0, r'{SCRIPTS_DIR}'); import bench_config as b; "
        "print(b.OUTPUT_DIR); print(b.WORKDIR); print(b.DB); print(b.CLI); print(b.repo_root())"
    )
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=env)
    assert r.returncode == 0, r.stderr
    out_dir, wd, db, cli, rr = r.stdout.strip().splitlines()
    assert out_dir.endswith("_out"), out_dir
    assert wd.endswith("_wd"), wd
    assert db.replace("\\", "/").endswith(".semctx/semctx.db"), db
    assert cli.replace("\\", "/").endswith("apps/cli/src/index.ts"), cli
    assert rr == SCRIPTS_DIR, rr
    print("[ok] configured env builds expected paths (no eval run)")


if __name__ == "__main__":
    check_no_absolute_paths()
    check_missing_config_fails()
    check_configured_paths()
    print("smoke test PASSED")
