#!/usr/bin/env python3
"""Addendum A — add minimal semantic markers to ground-truth files (isolated workspace copy only).

This step is CORPUS-SPECIFIC: it annotates the ground-truth symbols of *your* corpus so the
Addendum-A re-measure can show the ergonomic ceiling markers reach. The concrete (file, anchor,
marker) set for the private corpus behind RESULTS.md is not shipped.

Supply your own edit set one of two ways:
  1. Point SEMCTX_BENCH_MARKERS at a local JSON file: a list of [relpath, anchor, marker_block]
     triples (relpath is relative to the indexed workspace copy). Git-ignored under data/.
  2. Or edit the EXAMPLE_EDITS template below in place for a quick one-off run.

Only run this against the isolated, indexed workspace COPY — never a repo you edit.
"""
import io, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_config

WS = bench_config.require_workdir_indexed()

# Illustrative template — replace with your corpus's ground-truth symbols, or load a set from
# SEMCTX_BENCH_MARKERS (see module docstring). Anchors must occur exactly once in the file.
EXAMPLE_EDITS = [
    (
        "src/example-module.ts",
        "export function exampleExportedSymbol(",
        "/**\n"
        " * @capability example-capability: one line stating what this symbol guarantees\n"
        " * @invariant  example-invariant: the property a change here must preserve\n"
        " */\nexport function exampleExportedSymbol(",
    ),
]


def load_edits():
    src = os.environ.get("SEMCTX_BENCH_MARKERS")
    if src:
        with io.open(src, "r", encoding="utf-8") as f:
            return json.load(f)
    return EXAMPLE_EDITS


edits = load_edits()
if edits is EXAMPLE_EDITS:
    print(
        "note: using the illustrative EXAMPLE_EDITS template. Set SEMCTX_BENCH_MARKERS to a JSON "
        "edit set for your corpus, or edit EXAMPLE_EDITS. See the module docstring.",
        file=sys.stderr,
    )

for relpath, anchor, block in edits:
    path = f"{WS}/{relpath.lstrip('/')}"
    if not os.path.exists(path):
        print("!! file not found:", path, "(is it a path inside the indexed workspace copy?)")
        sys.exit(1)
    with io.open(path, "r", encoding="utf-8") as f:
        src = f.read()
    if anchor not in src:
        print("!! anchor not found:", path, anchor)
        sys.exit(1)
    if src.count(anchor) != 1:
        print("!! anchor not unique:", path, anchor, src.count(anchor))
        sys.exit(1)
    src = src.replace(anchor, block, 1)
    with io.open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(src)
    print("marked", relpath)
print("done")
