"""Pinned native-review provenance parser; no gate or process execution."""
import hashlib,json

PLAN_TOOL=("functions.request_user_input",)
# Exact interpret_audit source reused from proof_resume.py SHA256 31c8a31c2682799a9cef0bc0b6fcfccca1b75dd4462669620f4a0c024509e87c
def interpret_audit(events):
    phases = [event["type"] for event in events]
    categories = {"thread.started", "turn.started", "item.started", "item.updated", "item.completed", "turn.completed"}
    if (not phases or phases[0] != "thread.started" or phases[-1] != "turn.completed"
            or phases.count("turn.started") != 1 or set(phases) - categories):
        raise ValueError("fresh review had an unexpected event sequence")
    thread_ids = [event["thread_id"] for event in events if event["type"] == "thread.started"]
    if (len(thread_ids) != 1 or not isinstance(thread_ids[0], str) or not thread_ids[0].strip()
            or phases.count("turn.completed") != 1):
        raise ValueError("fresh review did not complete")
    items = [event["item"] for event in events if "item" in event]
    if any(item["type"].endswith("_call") or item["type"] not in (
        "agent_message", "reasoning", "error"
    ) for item in items):
        raise ValueError("review contained an unexpected tool or action")
    findings = [event["item"]["text"] for event in events[phases.index("turn.started") + 1:-1]
                if event["type"] == "item.completed" and event["item"]["type"] == "agent_message"]
    if len(findings) != 1:
        raise ValueError("review did not produce one completed findings message")
    if any(item["type"] == "error" and not item.get("message", "").startswith(
        "clamping SessionEnd hook timeout"
    ) for item in items):
        raise ValueError("review reported an unexpected runtime error")
    report = json.loads(findings[0])
    if (not report["findings"].strip() or tuple(report["declared_tools"]) != PLAN_TOOL
            or report["capabilities"] != {"execute": False, "write": False, "delegate": False}):
        raise ValueError("the fresh reviewer did not confirm its restricted capabilities")
    return thread_ids[0], report


def verify_bundle(review_raw, folder, product):
    def read(name):
        paths=[folder/name,folder/'independent'/name]
        found=[path for path in paths if path.is_file() and not path.is_symlink()]
        if len(found)!=1:
            raise ValueError('review bundle artifact missing or ambiguous: '+name)
        raw=found[0].read_bytes()
        if len(raw)>8_388_608:
            raise ValueError('review artifact exceeds cap')
        return raw
    digest=lambda value:hashlib.sha256(value).hexdigest()
    report=json.loads(review_raw)
    raw_events=read('review.events.jsonl')
    if (digest(raw_events)!=report['events_sha256']
            or digest(read('review.prompt.exact'))!=report['prompt_sha256']
            or digest(read('review-catalog.json'))!=report['catalog_sha256']
            or digest(read('review.stderr'))!=report['stderr_sha256']):
        raise ValueError('native review provenance bytes differ')
    thread,parsed=interpret_audit([json.loads(line) for line in raw_events.splitlines()])
    if thread!=report['review_thread_id'] or parsed!=report['review_report']:
        raise ValueError('saved review differs from actual reviewer events')
    receipt=json.loads(read('NATIVE-REVIEW-RECEIPT.json'))
    evidence=digest(read('native-evidence.json'))
    line=('NATIVE_PUBLIC38_ADEQUATE subject='+report['subject_digest']+' product='+product+
          ' evidence_sha256='+evidence)
    argv=report['audit_argv']
    if (parsed['findings'].splitlines()[0]!=line or receipt['first_line']!=line
            or receipt['state']!='PASS' or receipt['product']!=product
            or receipt['subject']!=report['subject_digest'] or receipt['evidence_sha256']!=evidence
            or receipt['provenance']['report']['sha256']!=digest(review_raw)
            or receipt['provenance']['events']['sha256']!=digest(raw_events)
            or receipt['provenance']['prompt']['sha256']!=report['prompt_sha256']
            or receipt['qualification_credit']!=0
            or '--ephemeral' not in argv or '--sandbox' not in argv
            or argv[argv.index('--sandbox')+1]!='read-only'):
        raise ValueError('native prior review is not favorable for this product/evidence')
    return {'review_sha256':digest(review_raw),'evidence_sha256':evidence,'thread_id':thread}
