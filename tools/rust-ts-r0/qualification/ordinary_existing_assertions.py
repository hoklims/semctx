"""Append baseline-derived checks to existing immutable recipes, without new inputs."""
import copy
import hashlib
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def append_existing_assertions(recipes, frozen, origin):
    if frozen['baseline'] != '3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b' or frozen['typescript_version'] != '5.9.3':
        raise ValueError('unexpected ordinary assertion baseline')
    by_id = {recipe['unit_id']: recipe for recipe in recipes}
    pending = []
    for index, assertion in enumerate(frozen['assertions']):
        recipe = by_id[assertion['unit_id']]
        request = recipe['requests'][0]
        if (recipe['frozen_unit_pointer'] != assertion['frozen_unit_pointer']
                or recipe['frozen_unit_sha256'] != assertion['frozen_unit_sha256']
                or digest(request) != assertion['request_sha256']):
            raise ValueError('ordinary assertion does not match existing frozen input')
        for document in assertion['input_documents']:
            if hashlib.sha256(request['files'][document['path']].encode()).hexdigest() != document['sha256']:
                raise ValueError('ordinary assertion source custody mismatch')
        additions = copy.deepcopy(assertion['checks'])
        for check_index, check in enumerate(additions):
            check['expected_origin'] = f'{origin}#/assertions/{index}/checks/{check_index}/expected'
        pending.append((recipe, additions))
    # Validate all entries before mutating any recipe.
    for recipe, additions in pending:
        recipe['checks'].extend(additions)
