"""Non-mutating boundary delta for frozen29. Python never invents scope facts."""
from lifecycle_adapter_29_frozen import build_overlay as build_overlay
import lifecycle_adapter_29_frozen as previous
from public_runtime import Gap, normalize, resolve_ref


def prepare_lifecycle(*args, **kwargs):
    prepared = previous.prepare_lifecycle(*args, **kwargs)
    if prepared['public_flow_kind'] == 'public-verify':
        from full_admission_adapter import prepare_full_admission
        return prepare_full_admission(*args, **kwargs)
    if prepared['public_flow_kind'] == 'index-store':
        # Structural native index receipt. Qualified component captures remain
        # separate and are never relabelled as this ordinary receipt.
        prepared['requests'][0]['qualified'] = False
        prepared['index_profile_binding'] = 'ordinary structural facts; no qualified admission inferred'
    if prepared['public_flow_kind'] == 'retained-scope':
        request = resolve_ref(prepared['request_ref'])
        config = request['arguments'][0]['config']
        prepared['broad_discovery_request'] = {'repositoryRoot': prepared['repository_root'], 'config': {
            'version': 2, 'include': ['**/*'], 'exclude': [],
            'languages': {'typescript': 'on', 'javascript': 'on', 'python': 'on', 'markdown': 'on', 'sql': 'on'},
            'migrationsDirs': config['migrationsDirs']}}
    return prepared


def project_lifecycle(prepared, observed):
    kind = prepared['public_flow_kind']
    if kind == 'public-verify' and prepared.get('adapter') == 'full_admission_adapter':
        from full_admission_adapter import project_full_admission
        return project_full_admission(prepared, observed)
    if kind == 'index-store':
        receipt = observed.get('batch_binding_receipt', {})
        if receipt.get('state') != 'BOUND_COMPLETE_INDEX_BATCH' or receipt.get('admissible_index_store') is not True:
            raise Gap('ACTUAL_BOUND_COMPLETE_INDEX_RECEIPT_REQUIRED')
    if kind == 'retained-scope':
        receipt = observed.get('scope_ast_receipt', {})
        if (receipt.get('kind') == 'rust-consumer-native-ast-v1'
                and receipt.get('input_manifest_id') == observed.get('raw_scope', {}).get('input_manifest_id')
                and isinstance(observed.get('rust_scope_projection'), dict)):
            # All dependency interpretation is in the pinned Rust consumer. This
            # Python layer performs only path normalization on its actual DTO.
            return normalize(observed['rust_scope_projection'], prepared)
        raise Gap('RUST_NATIVE_AST_SCOPE_RECEIPT_REQUIRED')
    return previous.project_lifecycle(prepared, observed)
