#!/bin/bash
# Renders the screenshot baselines of e2e/visual.e2e.ts on Linux, in the Playwright image of the pinned version,
# as the CI runner renders them. Needs Docker. Run from anywhere:
#
#   bun run test:visual:update
#
# With --check it renders the pages again and compares them with the committed baselines instead, without writing
# anything: a way to see on a workstation what the CI runner will see.
#
# The repository is copied into the container, so the host's node_modules and build are left alone. Only
# apps/web/e2e/__screenshots__ is written back. The image is amd64, the CI runner's architecture.
set -euo pipefail
mode=${1:-update}
[ "$#" -gt 0 ] && shift
# Further arguments go to Playwright in --check mode, for example --repeat-each=20.
extra="$*"
repo=$(cd "$(dirname "$0")/../../.." && pwd)
version=$(sed -n 's/.*"@playwright\/test": "\([^"]*\)".*/\1/p' "$repo/apps/web/package.json")
bun_version=$(sed -n 's/.*"packageManager": "bun@\([^"]*\)".*/\1/p' "$repo/package.json")
mkdir -p "$repo/apps/web/e2e/__screenshots__" "$repo/apps/web/test-results"
docker run --rm --platform linux/amd64 --ipc=host \
  -v "$repo":/repo:ro -v "$repo/apps/web/e2e/__screenshots__":/screenshots -v "$repo/apps/web/test-results":/results \
  -e CI=1 -e BUN_VERSION="$bun_version" -e MODE="$mode" -e EXTRA="$extra" -w /work "mcr.microsoft.com/playwright:v$version-noble" bash -c '
set -euo pipefail
cd /repo
tar --exclude=./.git --exclude="*/node_modules" --exclude=./node_modules --exclude=./apps/web/.next \
  --exclude=./contracts/lib --exclude=./contracts/out --exclude=./contracts/cache -cf - . | tar -xf - -C /work
cd /work
npm install --global --silent "bun@$BUN_VERSION"
bun install --frozen-lockfile
bun run build
cd apps/web
if [ "$MODE" = "--check" ]; then
  rm -rf e2e/__screenshots__ && cp -r /screenshots e2e/__screenshots__
  # A failure leaves the expected, actual and diff images in apps/web/test-results.
  bunx playwright test e2e/visual.e2e.ts --reporter=line $EXTRA || { cp -r test-results/. /results/; exit 1; }
  exit
fi
rm -rf e2e/__screenshots__/visual.e2e.ts
bunx playwright test e2e/visual.e2e.ts --update-snapshots=all --reporter=line
rm -rf /screenshots/visual.e2e.ts
cp -r e2e/__screenshots__/visual.e2e.ts /screenshots/
'
[ "$mode" = "--check" ] || echo "Baselines written to apps/web/e2e/__screenshots__/visual.e2e.ts"
