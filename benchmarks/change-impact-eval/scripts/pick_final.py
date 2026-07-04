#!/usr/bin/env python3
"""Deterministic, bias-free selection of the eval commit set from candidates.json."""
import json, os, sys
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_config

HERE = bench_config.OUTPUT_DIR
os.makedirs(HERE, exist_ok=True)
cands = json.load(open(os.path.join(HERE, "candidates.json"), encoding="utf-8"))

def norm_type(t):
    if t in ("fix", "feat", "refactor"):
        return t
    return "other"

# candidates.json is newest-first (git log order). Keep that order.
eligible = [c for c in cands
            if c["coverage"] >= 0.75 and 1 <= c["n_code"] <= 4 and len(c["symbols"]) >= 1]

CAPS = {"fix": 6, "feat": 6, "refactor": 3, "other": 3}
TOTAL = 16
buckets = defaultdict(list)
chosen = []
for c in eligible:
    t = norm_type(c["type"])
    if len(buckets[t]) < CAPS[t] and len(chosen) < TOTAL:
        buckets[t].append(c)
        chosen.append(c)

# If refactor/other underfilled and total<16, backfill with newest remaining fix/feat.
if len(chosen) < TOTAL:
    for c in eligible:
        if c in chosen:
            continue
        chosen.append(c)
        if len(chosen) >= TOTAL:
            break

pkgs = set()
for c in chosen:
    for f in c["code_files"]:
        pkgs.add(f.split("/")[1])

json.dump(chosen, open(os.path.join(HERE, "eval_set.json"), "w", encoding="utf-8"), indent=1)
print(f"selected {len(chosen)} commits across packages: {sorted(pkgs)}")
from collections import Counter
print("by type:", dict(Counter(norm_type(c['type']) for c in chosen)))
for c in chosen:
    print(f"  {c['sha'][:8]} [{norm_type(c['type']):8}] code={c['n_code']} test={c['n_test']} sym={len(c['symbols'])}  {c['subject'][:66]}")
