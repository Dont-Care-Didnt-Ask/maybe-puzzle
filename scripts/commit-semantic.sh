#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Run from a clean staging area so each commit contains only its intended group.
if ! git diff --cached --quiet; then
  echo "Please clear or commit the existing staging area first." >&2
  exit 1
fi

commit_group() {
  local message=$1
  shift
  git add -A -- "$@"
  if ! git diff --cached --quiet; then
    git commit -m "$message"
  fi
}

commit_group "Add chess puzzle application" \
  .gitignore index.html engine.py prepare.py export_static.py \
  web scripts/serve.mjs scripts/source.mjs scripts/validate-data.mjs
commit_group "Add puzzle datasets and static assets" data public
commit_group "Add application tests and tooling" \
  tests benchmark.py package.json package-lock.json pyproject.toml uv.lock \
  vite.config.js playwright.config.js
commit_group "Document project decisions and hosting" \
  README.md DECISIONS.md HOSTING.md THIRD_PARTY.md LICENSE next_steps.md .github \
  scripts/commit-semantic.sh
