#!/usr/bin/env python3
"""Run every retriever over every task; emit ranked file lists + timing/size to runs.json.
Retrievers: bm25 (lexical), centrality (repo-map, task-blind), ccc (semantic),
semctx_full (A4 recommendedReads), semctx_primary (A3 lexical+graph), plus semctx symbol/test lists.
Ablations A1 (lexical-name) and A2 (=centrality) computed here too."""
import json, os, re, math, subprocess, sqlite3, time, sys
from collections import defaultdict, Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_config

HERE = bench_config.OUTPUT_DIR
os.makedirs(HERE, exist_ok=True)
REPO = bench_config.repo_root()
WS = bench_config.require_workdir_indexed()
DB = bench_config.DB
CLI = bench_config.CLI

tasks = json.load(open(f"{HERE}/tasks.json", encoding="utf-8"))

# ---------- corpus + graph ----------
def corpus_files():
    out = []
    for root, _, files in os.walk(f"{WS}/packages"):
        for fn in files:
            if fn.endswith(".ts"):
                p = os.path.join(root, fn).replace("\\", "/")
                rel = p[len(WS) + 1:]
                out.append(rel)
    return sorted(out)

CORPUS = corpus_files()
CORPUS_SET = set(CORPUS)
IS_TEST = lambda p: bool(re.search(r"\.(test|spec)\.ts$", p))

def read_text(rel):
    try:
        return open(f"{WS}/{rel}", encoding="utf-8", errors="replace").read()
    except OSError:
        return ""

# graph: node->file, file adjacency, node names per file
con = sqlite3.connect(DB)
node_file = {}
file_names = defaultdict(set)   # file -> set of symbol names
for nid, kind, name, fp in con.execute("select id,kind,name,file_path from nodes"):
    if fp:
        node_file[nid] = fp
        if kind in ("function", "class", "interface", "type", "enum"):
            file_names[fp].add(name)
adj = defaultdict(set)          # file <-> file (structural)
STRUCT = {"calls", "imports", "tested_by", "covers", "declares", "constrained_by", "implements_capability", "related_to", "references"}
for kind, a, b in con.execute("select kind,from_id,to_id from edges"):
    if kind in STRUCT:
        fa, fb = node_file.get(a), node_file.get(b)
        if fa and fb and fa != fb:
            adj[fa].add(fb); adj[fb].add(fa)
con.close()

# ---------- tokenization ----------
def toks(text):
    # split camelCase then non-alnum, lowercase, keep len>=3
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return [t for t in re.split(r"[^A-Za-z0-9]+", text.lower()) if len(t) >= 3]

# ---------- BM25 ----------
class BM25:
    def __init__(self, docs, k1=1.5, b=0.75):
        self.docs = docs; self.k1 = k1; self.b = b
        self.N = len(docs)
        self.dl = [len(d) for d in docs]
        self.avgdl = sum(self.dl) / max(self.N, 1)
        self.tf = [Counter(d) for d in docs]
        df = Counter()
        for d in self.tf:
            for w in d: df[w] += 1
        self.idf = {w: math.log(1 + (self.N - n + 0.5) / (n + 0.5)) for w, n in df.items()}
    def scores(self, q):
        qs = Counter(q); out = []
        for i in range(self.N):
            s = 0.0; tf = self.tf[i]; dl = self.dl[i]
            for w in qs:
                if w in tf:
                    idf = self.idf.get(w, 0.0)
                    s += idf * tf[w] * (self.k1 + 1) / (tf[w] + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
            out.append(s)
        return out

DOC_TOKENS = [toks(f + " " + read_text(f)) for f in CORPUS]
bm25 = BM25(DOC_TOKENS)

def bm25_rank(query):
    s = bm25.scores(toks(query))
    order = sorted(range(len(CORPUS)), key=lambda i: (-s[i], CORPUS[i]))
    return [CORPUS[i] for i in order if s[i] > 0]

# ---------- lexical-name ranker (A1: semctx-style token->name match) ----------
STOP = set("that this with from when which into your will have been they then than else does need should make change update were some there their would could about where while gate the and for".split())
def task_tokens4(query):
    return {t for t in toks(query) if len(t) >= 4 and t not in STOP}

def lexical_name_rank(query):
    tks = task_tokens4(query)
    hits = {}
    for f in CORPUS:
        base = os.path.basename(f).lower()
        cnt = 0
        for name in file_names.get(f, ()):
            nl = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name).lower()
            ntoks = set(re.split(r"[^a-z0-9]+", nl))
            cnt += sum(1 for t in tks if any(nt.startswith(t) for nt in ntoks))
        cnt += sum(1 for t in tks if t in base)
        if cnt > 0:
            hits[f] = cnt
    return [f for f in sorted(hits, key=lambda f: (-hits[f], f))]

# ---------- centrality (A2 / repo-map, task-blind) ----------
def pagerank(adj, iters=30, d=0.85):
    nodes = list(adj.keys())
    if not nodes: return {}
    pr = {n: 1.0 / len(nodes) for n in nodes}
    for _ in range(iters):
        nxt = {n: (1 - d) / len(nodes) for n in nodes}
        for n in nodes:
            deg = len(adj[n]) or 1
            share = d * pr[n] / deg
            for m in adj[n]:
                nxt[m] = nxt.get(m, (1 - d) / len(nodes)) + share
        pr = nxt
    return pr
PR = pagerank(adj)
CENTRALITY_RANK = [f for f in sorted(CORPUS, key=lambda f: (-PR.get(f, 0.0), f))]

# ---------- ccc semantic ----------
CCC_FILE_RE = re.compile(r"^File:\s+(packages/[^\s:]+\.ts)")
def ccc_rank(query):
    try:
        p = subprocess.run(["ccc", "search", query], cwd=REPO, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=90)
    except Exception as e:
        return None
    seen, ranked = set(), []
    for line in p.stdout.splitlines():
        m = CCC_FILE_RE.match(line.strip())
        if m:
            f = m.group(1)
            if f in CORPUS_SET and f not in seen:
                seen.add(f); ranked.append(f)
    return ranked

# ---------- semctx ----------
def semctx_pack(task_md_path, task_text):
    create = subprocess.run(["bun", "run", CLI, "task", "create", "--from-file", task_md_path],
                            cwd=WS, capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = re.search(r"task:(\w+)", create.stdout)
    if not m:
        return None
    tid = "task:" + m.group(1)
    t0 = time.perf_counter()
    prep = subprocess.run(["bun", "run", CLI, "context", "prepare", tid, "--json"],
                          cwd=WS, capture_output=True, text=True, encoding="utf-8", errors="replace")
    dt = time.perf_counter() - t0
    try:
        pack = json.loads(prep.stdout)
    except json.JSONDecodeError:
        return None
    reads = [r["path"] for r in pack.get("recommendedReads", [])]
    crit = [r["path"] for r in pack.get("recommendedReads", []) if r.get("priority") == "critical"]
    primary = []
    for n in pack.get("primaryNodes", []):
        fp = n.get("filePath")
        if fp and fp not in primary:
            primary.append(fp)
    syms = [n.get("name") for n in pack.get("primaryNodes", []) if n.get("name")]
    tests = [t.get("filePath") for t in pack.get("relevantTests", []) if t.get("filePath")]
    size = len(prep.stdout.encode("utf-8"))
    warn = pack.get("meta", {}).get("warnings", [])
    return {"reads": reads, "critical": crit, "primary": primary, "symbols": syms,
            "tests": tests, "compile_s": round(dt, 3), "pack_bytes": size, "warnings": warn}

# ---------- run all ----------
runs = {}
for t in tasks:
    q = t["task_text"]
    md = f"{HERE}/tasks/{t['id']}.md"
    print("running", t["id"], flush=True)
    sc = semctx_pack(md, q)
    ccc = ccc_rank(q)
    runs[t["id"]] = {
        "bm25": bm25_rank(q),
        "lexical_name": lexical_name_rank(q),
        "centrality": CENTRALITY_RANK,   # task-blind
        "ccc": ccc,
        "semctx_full": sc["reads"] if sc else [],
        "semctx_primary": sc["primary"] if sc else [],
        "semctx_critical": sc["critical"] if sc else [],
        "semctx_symbols": sc["symbols"] if sc else [],
        "semctx_tests": sc["tests"] if sc else [],
        "compile_s": sc["compile_s"] if sc else None,
        "pack_bytes": sc["pack_bytes"] if sc else None,
        "warnings": sc["warnings"] if sc else None,
    }

# persist adjacency + corpus for the scorer
json.dump({"runs": runs,
           "corpus": CORPUS,
           "adj": {k: sorted(v) for k, v in adj.items()},
           "file_names": {k: sorted(v) for k, v in file_names.items()}},
          open(f"{HERE}/runs.json", "w", encoding="utf-8"))
print("wrote runs.json;  corpus files:", len(CORPUS), " ccc ok:", sum(1 for t in tasks if runs[t['id']]['ccc']))
