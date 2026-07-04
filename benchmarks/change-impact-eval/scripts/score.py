#!/usr/bin/env python3
"""Score every retriever against ground truth. Emits tables + results.json."""
import json, os, sys
from statistics import mean
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_config

HERE = bench_config.OUTPUT_DIR
os.makedirs(HERE, exist_ok=True)
tasks = json.load(open(f"{HERE}/tasks.json", encoding="utf-8"))
data = json.load(open(f"{HERE}/runs.json", encoding="utf-8"))
runs = data["runs"]
adj = {k: set(v) for k, v in data["adj"].items()}

FILE_RETRIEVERS = ["bm25", "ccc", "centrality", "lexical_name", "semctx_primary", "semctx_full"]
# ablation aliases
ABLATION = {"A1_lexical": "lexical_name", "A2_graph": "centrality",
            "A3_lex+graph": "semctx_primary", "A4_full(+scoring)": "semctx_full"}

def recall_at(ranked, gt, k):
    if not gt: return None
    top = ranked[:k]
    return len(set(top) & set(gt)) / len(gt)

def mrr(ranked, gt):
    if not gt: return None
    for i, f in enumerate(ranked, 1):
        if f in gt: return 1.0 / i
    return 0.0

def false_neighbor_rate(ranked, gt_all, k):
    top = ranked[:k]
    if not top: return None
    bad = 0
    gtset = set(gt_all)
    for f in top:
        if f in gtset: continue
        if any(g in adj.get(f, ()) for g in gtset): continue
        bad += 1
    return bad / len(top)

# ---- per-task, per-retriever ----
per_task = {}
agg = {r: {"r5": [], "r10": [], "r20": [], "r10_all": [], "mrr": [], "fnr10": []} for r in FILE_RETRIEVERS}
sym_recall, test_recall, crit_prec, compile_s, pack_bytes, proposed = [], [], [], [], [], []

for t in tasks:
    tid = t["id"]; rr = runs[tid]
    gtc, gta, gtt, gts = t["gt_files_code"], t["gt_files_all"], t["gt_tests"], t["gt_symbols"]
    row = {}
    for r in FILE_RETRIEVERS:
        ranked = rr.get(r) or []
        row[r] = {
            "r5": recall_at(ranked, gtc, 5), "r10": recall_at(ranked, gtc, 10),
            "r20": recall_at(ranked, gtc, 20), "r10_all": recall_at(ranked, gta, 10),
            "mrr": mrr(ranked, gtc), "fnr10": false_neighbor_rate(ranked, gta, 10),
        }
        for m in ("r5", "r10", "r20", "r10_all", "mrr", "fnr10"):
            if row[r][m] is not None:
                agg[r][m].append(row[r][m])
    per_task[tid] = row
    # semctx-only
    if gts:
        sym_recall.append(len(set(rr.get("semctx_symbols") or []) & set(gts)) / len(gts))
    if gtt:
        tr = len(set(rr.get("semctx_tests") or []) & set(gtt)) / len(gtt)
        test_recall.append(tr)
    crit = rr.get("semctx_critical") or []
    if crit:
        crit_prec.append(len(set(crit) & set(gta)) / len(crit))
    if rr.get("compile_s") is not None: compile_s.append(rr["compile_s"])
    if rr.get("pack_bytes") is not None: pack_bytes.append(rr["pack_bytes"])
    proposed.append(len(rr.get("semctx_full") or []))

def M(xs): return round(mean(xs), 3) if xs else None

# ---- headline table ----
print("="*92)
print("RETRIEVAL — mean over 16 tasks (recall on modified CODE files; MRR = 1/rank of first hit)")
print("="*92)
print(f"{'retriever':<20} {'R@5':>6} {'R@10':>6} {'R@20':>6} {'R@10all':>8} {'MRR':>6} {'FNR@10':>7}")
for r in FILE_RETRIEVERS:
    a = agg[r]
    print(f"{r:<20} {M(a['r5']):>6} {M(a['r10']):>6} {M(a['r20']):>6} {M(a['r10_all']):>8} {M(a['mrr']):>6} {M(a['fnr10']):>7}")

print("\nABLATION LADDER (recall on CODE files):")
print(f"{'stage':<20} {'R@5':>6} {'R@10':>6} {'R@20':>6} {'MRR':>6}")
for label, r in ABLATION.items():
    a = agg[r]
    print(f"{label:<20} {M(a['r5']):>6} {M(a['r10']):>6} {M(a['r20']):>6} {M(a['mrr']):>6}")

print("\nSEMCTX-specific:")
print(f"  symbol recall (gt hunk-symbols in primaryNodes): {M(sym_recall)}  (n={len(sym_recall)})")
print(f"  test recall   (modified tests in relevantTests): {M(test_recall)}  (n={len(test_recall)})")
print(f"  critical-read precision (crit reads in gt_all)  : {M(crit_prec)}  (n={len(crit_prec)})")
print(f"  mean files proposed (recommendedReads)          : {round(mean(proposed),1)}")
print(f"  mean compile time (s)                           : {M(compile_s)}")
print(f"  mean pack size (KB)                             : {round(mean(pack_bytes)/1024,1)}")

# ---- per-task recall@10 matrix (for win/loss picking) ----
print("\nPER-TASK recall@10 (code):  bm25 / ccc / semctx_full   [type]")
wins, losses = [], []
for t in tasks:
    tid = t["id"]; row = per_task[tid]
    b, c, s = row["bm25"]["r10"], row["ccc"]["r10"], row["semctx_full"]["r10"]
    tag = ""
    if s is not None and b is not None:
        if s > max(b, c or 0): wins.append(tid); tag = " WIN(semctx)"
        elif s < min(b, c if c is not None else 1): losses.append(tid); tag = " LOSS(semctx)"
    print(f"  {tid:<14} {b}   {c}   {s}   [{t['type']}]{tag}")

print("\nwins(semctx>both baselines):", wins)
print("losses(semctx<both baselines):", losses)

json.dump({"agg": {r: {k: M(v) for k, v in agg[r].items()} for r in FILE_RETRIEVERS},
           "semctx": {"symbol_recall": M(sym_recall), "test_recall": M(test_recall),
                      "critical_precision": M(crit_prec), "mean_proposed": round(mean(proposed),1),
                      "compile_s": M(compile_s), "pack_kb": round(mean(pack_bytes)/1024,1)},
           "per_task": per_task, "wins": wins, "losses": losses},
          open(f"{HERE}/results.json", "w", encoding="utf-8"), indent=1)
