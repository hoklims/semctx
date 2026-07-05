#!/usr/bin/env bash
# End-to-end stress test for the semctx semantic layer.
#
# Scaffolds a throwaway TypeScript git repo (an @invariant-marked domain + a test), then drives the
# full CLI through five scenarios, asserting the composed verdict and exit code of each:
#   1. PARTIAL -> VERIFIED   (open unknown + pending proof, then resolved)
#   2. BLOCKED               (critical invariant touched without a covering test)
#   3. STALE                 (a repository link no longer resolves)
#   4. DIAGNOSTICS           (a malformed .sem: check reports file:line:col, never crashes)
#   5. DETERMINISM           (change verify --format json is byte-identical across runs)
#
# Runs in Git Bash (the semctx CLI runs under Bun). Usage:
#   bash scripts/semantic-stress-test.sh            # uses this repo's CLI source
#   SEMCTX_SRC=/abs/apps/cli/src/index.ts bash scripts/semantic-stress-test.sh
set -u

# --- locate the semctx CLI (source; always current) ------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEMCTX_SRC="${SEMCTX_SRC:-$SCRIPT_DIR/../apps/cli/src/index.ts}"
semctx() { bun "$SEMCTX_SRC" "$@"; }

# --- pretty pass/fail -----------------------------------------------------------------------------
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
jqf()  { python -c "import sys,json; d=json.load(sys.stdin); print(d$1)" 2>/dev/null; }

# --- throwaway repo -------------------------------------------------------------------------------
TMP="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/semctx-stress-$$")"; mkdir -p "$TMP"
cleanup() { [ "${KEEP:-0}" = "1" ] || rm -rf "$TMP"; }
trap cleanup EXIT
echo "Stress repo: $TMP"
cd "$TMP" || exit 1

cat > package.json <<'JSON'
{ "name": "stress", "type": "module", "version": "0.0.0" }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "module": "ESNext", "target": "ES2022", "moduleResolution": "bundler", "noEmit": true } }
JSON
mkdir -p src test

cat > src/inventory.ts <<'TS'
export interface StockPort { get(id: string): number; set(id: string, n: number): void; }

/**
 * @capability stock-management
 * @invariant no-negative-stock: reserving must never drive stock below zero
 * @contract stock-port
 */
export function reserveStock(port: StockPort, id: string, qty: number): number {
  const current = port.get(id);
  if (qty > current) throw new Error("insufficient stock");
  const next = current - qty;
  port.set(id, next);
  return next;
}

/**
 * @invariant no-negative-stock: refunds must not overshoot the ledger
 */
export function applyRefund(port: StockPort, id: string, qty: number): number {
  const next = port.get(id) + qty;
  port.set(id, next);
  return next;
}
TS

cat > test/inventory.test.ts <<'TS'
import { reserveStock } from "../src/inventory";
// Covers reserveStock (so it is 'tested'); applyRefund is deliberately left uncovered.
export function testReserve(): void {
  const store = new Map<string, number>([["a", 3]]);
  const port = { get: (k: string) => store.get(k) ?? 0, set: (k: string, n: number) => void store.set(k, n) };
  if (reserveStock(port, "a", 2) !== 1) throw new Error("fail");
}
TS

git init -q; git add -A; git -c user.email=t@t -c user.name=t commit -qm init

# --- bootstrap ------------------------------------------------------------------------------------
echo; echo "== bootstrap =="
semctx init >/dev/null
NODES="$(semctx index --json | jqf "['nodes']")"
[ "${NODES:-0}" -gt 0 ] && ok "index built ($NODES nodes)" || bad "index found 0 nodes"
semctx semantic init >/dev/null
semctx semantic check >/dev/null 2>&1 && ok "semantic check green on fresh scaffold" || bad "semantic check failed on scaffold"

# Resolve the real graph ids the analyzer produced (deterministic, but line-dependent).
RESERVE_ID="$(semctx inspect symbol reserveStock --json | jqf "['matchedNodes'][0]['id']")"
REFUND_ID="$(semctx inspect symbol applyRefund --json | jqf "['matchedNodes'][0]['id']")"
echo "  reserveStock -> $RESERVE_ID"
echo "  applyRefund  -> $REFUND_ID"

# Author a critical invariant linked to the real repo invariant + evidence + an unknown.
cat > .semctx/semantic/invariants.sem <<SEM
invariant invariant.stock.no-negative
  statement: stock must never go below zero
  status: declared
  link: inv:no-negative-stock
  tag: critical
SEM
cat > .semctx/semantic/evidence.sem <<SEM
evidence proof.stock.reserve-test
  statement: test/inventory.test.ts covers reserveStock
  status: declared
  link: test:test/inventory.test.ts
SEM
cat > .semctx/semantic/unknowns.sem <<SEM
unknown unknown.stock.race
  statement: two concurrent reservations may both pass the stock check
SEM
# The scaffold decision `justifies` the scaffold invariant we just replaced — clear it so the model
# stays internally consistent (leaving it would make `check` correctly flag a dangling reference).
printf '# decisions (cleared for the stress test)\n' > .semctx/semantic/decisions.sem
semctx index >/dev/null   # re-index so the linked test node exists
semctx semantic check >/dev/null 2>&1 && ok "semantic check green with authored + linked model" || bad "check failed after authoring (links unresolved?)"

: > empty.diff
# verify_json <change-id> [source-flags...] : writes $TMP/o.json, echoes semctx's exit code
verify_json() { semctx change verify "$@" --format json > "$TMP/o.json" 2>/dev/null; printf '%s' "$?"; }
vjson() { jqf "$1" < "$TMP/o.json"; }

# --- case 1: PARTIAL -> VERIFIED ------------------------------------------------------------------
echo; echo "== case 1: PARTIAL -> VERIFIED =="
semctx change open change.reserve-safe \
  --statement "make reservation retry-safe" \
  --preserves invariant.stock.no-negative \
  --requires proof.stock.reserve-test \
  --unknown unknown.stock.race >/dev/null
C1="$(verify_json change.reserve-safe --from-file "$TMP/empty.diff")"; V1="$(vjson "['verdict']")"
[ "$V1" = "PARTIAL" ] && [ "$C1" -eq 0 ] && ok "open unknown + pending proof -> PARTIAL (exit 0)" || bad "expected PARTIAL/exit0" "got $V1 / exit $C1"

# obtain the proof (mark evidence tested) and resolve the unknown
sed -i 's/status: declared/status: tested/' .semctx/semantic/evidence.sem
semctx change update change.reserve-safe --resolve-unknown unknown.stock.race >/dev/null
C1b="$(verify_json change.reserve-safe --from-file "$TMP/empty.diff")"; V1b="$(vjson "['verdict']")"
[ "$V1b" = "VERIFIED" ] && [ "$C1b" -eq 0 ] && ok "proof obtained + unknown resolved -> VERIFIED (exit 0)" || bad "expected VERIFIED/exit0" "got $V1b / exit $C1b"

# --- case 2: BLOCKED (critical invariant touched without a test) ----------------------------------
echo; echo "== case 2: BLOCKED =="
semctx change open change.refund \
  --statement "tweak refund math" \
  --preserves invariant.stock.no-negative >/dev/null
# edit the UNTESTED, invariant-constrained applyRefund in the working tree
sed -i 's/port.get(id) + qty/port.get(id) + qty + 0/' src/inventory.ts
C2="$(verify_json change.refund)"; V2="$(vjson "['verdict']")"
[ "$V2" = "BLOCKED" ] && [ "$C2" -eq 3 ] && ok "critical invariant touched w/o test -> BLOCKED (exit 3)" || bad "expected BLOCKED/exit3" "got $V2 / exit $C2"
git checkout -q -- src/inventory.ts   # restore

# --- case 3: STALE (a repository link no longer resolves) -----------------------------------------
echo; echo "== case 3: STALE =="
semctx change open change.stale \
  --statement "change with a drifted link" \
  --link sym:function:src/inventory.ts:deletedFunction:999 >/dev/null
C3="$(verify_json change.stale --from-file "$TMP/empty.diff")"; V3="$(vjson "['verdict']")"
[ "$V3" = "STALE" ] && [ "$C3" -eq 3 ] && ok "dangling repository link -> STALE (exit 3)" || bad "expected STALE/exit3" "got $V3 / exit $C3"

# --- case 4: DIAGNOSTICS (malformed .sem -> check reports, never crashes) --------------------------
echo; echo "== case 4: DIAGNOSTICS =="
cat > .semctx/semantic/assumptions.sem <<'SEM'
assumption assumption.bad
  statement: broken block
  status: nonsense-status
  preserevs: goal.typo
SEM
CHECK_OUT="$(semctx semantic check 2>&1)"; C4=$?
if [ "$C4" -eq 1 ] && printf '%s' "$CHECK_OUT" | grep -q 'unknown status'; then
  ok "malformed .sem -> check exit 1 with a precise diagnostic (no crash)"
else
  bad "expected exit 1 + diagnostic" "exit $C4"
fi
rm -f .semctx/semantic/assumptions.sem

# --- case 5: DETERMINISM (byte-identical composed report across runs) ------------------------------
echo; echo "== case 5: DETERMINISM =="
R1="$(semctx change verify change.reserve-safe --from-file "$TMP/empty.diff" --format json 2>/dev/null)"
R2="$(semctx change verify change.reserve-safe --from-file "$TMP/empty.diff" --format json 2>/dev/null)"
[ "$R1" = "$R2" ] && [ -n "$R1" ] && ok "change verify --format json is byte-identical across runs" || bad "non-deterministic output"

# --- summary --------------------------------------------------------------------------------------
echo; echo "================ stress summary ================"
printf '  passed: %s   failed: %s\n' "$PASS" "$FAIL"
[ "${KEEP:-0}" = "1" ] && echo "  (repo kept at $TMP)"
[ "$FAIL" -eq 0 ] || exit 1
echo "  all semantic-layer stress cases behaved as expected."
