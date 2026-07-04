#!/usr/bin/env python3
"""Select non-trivial, non-mechanical commits from the corpus repo for the retrieval eval.
The corpus repo is whatever SEMCTX_BENCH_REPO_ROOT points at (never hard-coded).
Read-only: only `git -C <repo>` queries, never writes to the repo."""
import subprocess, re, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_config

REPO = bench_config.repo_root()
OUT = bench_config.out("candidates.json")

CORPUS_RE = re.compile(r"^packages/[^/]+/src/.*\.ts$")
TEST_RE = re.compile(r"\.(test|spec)\.ts$|(^|/)(test|tests|__tests__)/")
MECHANICAL_SUBJECT = re.compile(r"\b(format|formatting|lint|prettier|biome|rename|renaming|typo|whitespace|reflow|reindent|eslint)\b", re.I)
TYPE_RE = re.compile(r"^(\w+)(?:\([^)]*\))?!?:")

HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$")
DECL_RE = re.compile(r"\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)")
CONST_FN_RE = re.compile(r"\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]")
METHOD_RE = re.compile(r"^\s*(?:public|private|protected|readonly|static|async|\*)*\s*([A-Za-z_$][\w$]*)\s*[(<]")
SKIP_CTX = re.compile(r"^\s*(describe|it|test|beforeEach|afterEach|beforeAll|afterAll)\b")


def git(*args):
    return subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


def corpus_files():
    out = git("ls-files", "packages")
    return {p for p in out.splitlines() if CORPUS_RE.match(p)}


def symbol_from_ctx(ctx):
    if not ctx or SKIP_CTX.match(ctx):
        return None
    for rx in (DECL_RE, CONST_FN_RE):
        m = rx.search(ctx)
        if m:
            return m.group(1)
    m = METHOD_RE.match(ctx)
    if m and m.group(1) not in ("if", "for", "while", "switch", "return", "catch"):
        return m.group(1)
    return None


def commit_info(sha, corpus):
    subject = git("show", "-s", "--format=%s", sha).strip()
    body = git("show", "-s", "--format=%b", sha).strip()
    # changed files with adds/dels
    numstat = git("show", "--numstat", "--format=", sha)
    files_all, code, tests = [], [], []
    changed_lines = {}
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        adds, dels, path = parts
        if not CORPUS_RE.match(path) or path not in corpus:
            continue
        files_all.append(path)
        n = (int(adds) if adds.isdigit() else 0) + (int(dels) if dels.isdigit() else 0)
        changed_lines[path] = n
        (tests if TEST_RE.search(path) else code).append(path)
    # symbols from hunk headers over corpus files
    symbols = set()
    if files_all:
        diff = git("show", "--unified=0", "--format=", sha, "--", *files_all)
        for line in diff.splitlines():
            m = HUNK_RE.match(line)
            if m:
                s = symbol_from_ctx(m.group(1))
                if s:
                    symbols.add(s)
    total_commit_code = sum(1 for line in numstat.splitlines()
                            if len(line.split("\t")) == 3 and line.split("\t")[2].endswith(".ts")
                            and not TEST_RE.search(line.split("\t")[2]))
    kept_code = len(code)
    coverage = kept_code / total_commit_code if total_commit_code else 0.0
    ctype = (TYPE_RE.match(subject).group(1).lower() if TYPE_RE.match(subject) else "other")
    return {
        "sha": sha, "subject": subject, "body": body[:500], "type": ctype,
        "code_files": code, "test_files": tests, "symbols": sorted(symbols),
        "changed_lines": changed_lines, "coverage": round(coverage, 2),
        "n_code": kept_code, "n_test": len(tests),
    }


def main():
    corpus = corpus_files()
    print(f"corpus TS files: {len(corpus)}", file=sys.stderr)
    shas = git("log", "--no-merges", "-300", "--pretty=%H").split()
    cands = []
    for sha in shas:
        subject = git("show", "-s", "--format=%s", sha).strip()
        if MECHANICAL_SUBJECT.search(subject):
            continue
        info = commit_info(sha, corpus)
        # focus filters
        if info["n_code"] < 1 or info["n_code"] > 8:
            continue
        if info["coverage"] < 0.6:
            continue
        if sum(info["changed_lines"].get(f, 0) for f in info["code_files"]) < 4:
            continue
        if info["type"] in ("docs", "chore", "ci", "build", "style"):
            continue
        cands.append(info)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cands, f, indent=1)
    # summary
    from collections import Counter
    by_type = Counter(c["type"] for c in cands)
    print(f"candidates: {len(cands)}  by_type={dict(by_type)}", file=sys.stderr)
    for c in cands[:40]:
        print(f"  {c['sha'][:8]} [{c['type']:8}] code={c['n_code']} test={c['n_test']} sym={len(c['symbols'])} cov={c['coverage']}  {c['subject'][:70]}", file=sys.stderr)


if __name__ == "__main__":
    main()
