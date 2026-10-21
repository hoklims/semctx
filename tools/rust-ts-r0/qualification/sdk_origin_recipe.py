"""Append bounded, separately derived assertions without changing frozen inputs/checks."""
import hashlib
import json

UNITS = {f'V3-SDK-{suffix}::base' for suffix in ['02-01', '02-05', '01-01', '01-05', '08-01', '08-02', '09-01', '09-02', '04-01', '04-04', '03-01', '03-04']}

def append_sdk_origin_checks(recipes, document, origin):
    assertions = document.get('assertions', [])
    if len(assertions) != 12 or {row['unit_id'] for row in assertions} != UNITS:
        raise ValueError('SDK-origin assertions require exactly the 12 authorized existing units')
    additions = []
    for index, assertion in enumerate(assertions):
        matches = [row for row in recipes if row['unit_id'] == assertion['unit_id']]
        if len(matches) != 1 or len(matches[0]['requests']) != 1:
            raise ValueError('SDK-origin existing unit/request is not unique')
        recipe = matches[0]
        request = recipe['requests'][0]
        digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        if (recipe['frozen_unit_pointer'] != assertion['frozen_unit_pointer']
                or recipe['frozen_unit_sha256'] != assertion['frozen_unit_sha256']
                or digest != assertion['request_canonical_sha256']):
            raise ValueError('SDK-origin assertion differs from unchanged frozen request')
        additions.append((recipe, {'observation': 0, 'target': ['_sdk_origin_assertion'], 'mode': 'eq', 'expected': assertion['projection'], 'expected_origin': f'{origin}#/assertions/{index}/projection', 'actual_transform': 'none'}))
    for recipe, check in additions:
        recipe['checks'].append(check)
