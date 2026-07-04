#!/usr/bin/env python3
"""Build anonymized tasks + ground truth from the selected eval commits.

Anonymization rule (documented, auditable):
  - strip conventional-commit scope  fix(decision): -> fix:   (removes package leak)
  - redact full paths  packages/.../x.ts  and bare  x.ts / x.test.ts
  - redact modified SYMBOLS that are code-shaped (camelCase / PascalCase / has _ or digit)
  - redact file BASENAMES that are code-shaped (contain '-', camelCase, or digit)
  - KEEP plain lowercase domain words (damage, pricing, summon, reachability): legitimate ticket vocab
Every redaction is logged per task so leakage is auditable.
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_config

HERE = bench_config.OUTPUT_DIR
TASKS_DIR = os.path.join(HERE, "tasks")
os.makedirs(TASKS_DIR, exist_ok=True)

evalset = json.load(open(os.path.join(HERE, "eval_set.json"), encoding="utf-8"))

CODE_SHAPED = re.compile(r"[a-z][A-Z]|[A-Z][a-z].*[A-Z]|[_0-9]|^[A-Z][a-z]+[A-Z]")
def code_shaped(tok):
    return bool(re.search(r"[a-z][A-Z]", tok) or re.search(r"[_0-9]", tok)
               or (tok[:1].isupper() and not tok.isupper() and len(tok) > 3) or "-" in tok)

SCOPE_RE = re.compile(r"^(\w+)\([^)]*\)(!?:)")
PATH_RE = re.compile(r"packages/[\w./-]+\.ts\b")
DOTTS_RE = re.compile(r"\b[\w-]+\.(?:test\.|spec\.)?ts\b")

def anonymize(commit):
    subject = commit["subject"]
    body = commit.get("body", "") or ""
    # strip conventional scope on the subject
    subject = SCOPE_RE.sub(r"\1\2", subject)
    text = subject + ("\n" + body if body else "")
    redacted = []

    def redact(pattern, is_regex=True, label=None):
        nonlocal text
        if is_regex:
            found = set(m.group(0) for m in re.finditer(pattern, text))
            for f in found:
                redacted.append(f)
            text = re.sub(pattern, "REDACTED", text)
        return

    # full paths + *.ts mentions
    redact(PATH_RE)
    redact(DOTTS_RE)

    # symbols (code-shaped)
    for sym in commit["symbols"]:
        if code_shaped(sym):
            pat = re.compile(r"\b" + re.escape(sym) + r"\b")
            if pat.search(text):
                redacted.append(sym)
                text = pat.sub("REDACTED", text)

    # file basenames (code-shaped)
    for f in commit["code_files"] + commit["test_files"]:
        base = os.path.basename(f).replace(".test.ts", "").replace(".spec.ts", "").replace(".ts", "")
        if code_shaped(base):
            pat = re.compile(r"\b" + re.escape(base) + r"\b")
            if pat.search(text):
                redacted.append(base)
                text = pat.sub("REDACTED", text)

    text = re.sub(r"\bREDACTED\b(?:\s+REDACTED\b)+", "REDACTED", text)  # collapse runs
    return text.strip(), sorted(set(redacted))

tasks = []
for i, c in enumerate(evalset):
    task_text, redacted = anonymize(c)
    tid = f"t{i:02d}_{c['sha'][:7]}"
    tasks.append({
        "id": tid,
        "sha": c["sha"],
        "type": c["type"],
        "subject_original": c["subject"],
        "task_text": task_text,
        "redacted": redacted,
        "gt_files_code": sorted(c["code_files"]),
        "gt_files_all": sorted(c["code_files"] + c["test_files"]),
        "gt_tests": sorted(c["test_files"]),
        "gt_symbols": sorted(c["symbols"]),
    })
    # write the semctx task file (raw anonymized message)
    with open(os.path.join(TASKS_DIR, tid + ".md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(task_text + "\n")

json.dump(tasks, open(os.path.join(HERE, "tasks.json"), "w", encoding="utf-8"), indent=1)
print(f"built {len(tasks)} tasks")
for t in tasks:
    print(f"\n=== {t['id']} [{t['type']}]  gt_code={len(t['gt_files_code'])} gt_test={len(t['gt_tests'])} gt_sym={len(t['gt_symbols'])}")
    print("  redacted:", t["redacted"])
    print("  task:", t["task_text"].replace("\n", " ")[:180])
