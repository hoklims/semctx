# pluggy 1.6.0 corpus subset

This directory vendors an exact, reviewable subset of
[`pytest-dev/pluggy`](https://github.com/pytest-dev/pluggy) for the Python analyzer's
deterministic real-repository corpus gate.

- Upstream tag: `1.6.0`
- Upstream commit: `fd08ab5f811a9b2fa9124ae8cbbd393221151e2c`
- Retrieved from: `https://github.com/pytest-dev/pluggy`
- License: MIT; the exact upstream `LICENSE` file is preserved beside the subset.

Vendored files:

- `src/pluggy/__init__.py` — package exports and relative imports.
- `src/pluggy/_result.py` — implementation classes and methods.
- `testing/test_result.py` — focused upstream tests with nested functions.

The corpus test pins the SHA-256 bytes of every vendored upstream file and the
canonical `extractPython` result. No generated or repository-specific code is
mixed into the vendored Python sources.
