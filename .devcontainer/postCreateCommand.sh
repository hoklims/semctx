#!/usr/bin/env bash
# Idempotent contributor setup. Installs project dependencies only. It never publishes, never
# runs the private benchmark, never installs Claude Code, and never needs an API key. It does not
# modify any user configuration outside the workspace.
set -euo pipefail

# Move to the repository root (this script lives in .devcontainer/).
cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not on PATH; the dev container image is expected to provide it." >&2
  exit 1
fi

check_pinned_quality_tool() {
  local tool="$1"
  local required_version
  local installed_version

  required_version="$(awk -F'==' -v package="$tool" '$1 == package { print $2 }' requirements-quality.txt)"
  if [[ -z "$required_version" ]]; then
    echo "error: $tool must have an exact pin in requirements-quality.txt." >&2
    exit 1
  fi

  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is not on PATH; the dev container image is expected to provide it." >&2
    exit 1
  fi

  installed_version="$("$tool" --version | awk '{ print $2; exit }')"
  if [[ "$installed_version" != "$required_version" ]]; then
    echo "error: $tool $installed_version is installed; requirements-quality.txt requires $required_version." >&2
    exit 1
  fi

  echo "==> $tool --version: $("$tool" --version)"
}

check_pinned_quality_tool ruff
check_pinned_quality_tool zizmor

echo "==> bun --version: $(bun --version)"
echo "==> bun install"
bun install

cat <<'EOF'

semctx dev container ready. Common tasks:

  bun run quality                                # targeted quality checks while iterating
  bun test packages/app-services                 # targeted application-service tests
  bun run verify:pr                              # sole pre-PR gate

  # Try the CLI on the shipped fixture:
  cd examples/sample-typescript-repo && bun ../../apps/cli/src/index.ts index

  # Benchmark portability smoke test (no corpus needed):
  python3 benchmarks/change-impact-eval/scripts/smoke_test.py

See docs/contributing/devcontainer.md.
EOF
