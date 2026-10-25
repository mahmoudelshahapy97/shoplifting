#!/usr/bin/env bash
# Run the Playwright suite against the running stack.
#
# The tests execute inside Microsoft's Playwright image rather than on the
# host: it already carries the browsers and their system libraries, so the run
# needs nothing installed locally beyond Docker. --network host is what lets
# the container reach the console on the host's published port, which is also
# why BASE_URL defaults to localhost rather than a service name.
#
#   docker compose up -d --build
#   docker compose exec -T postgres psql -U shoplifting -d shoplifting_db < database/seed.sql
#   ./e2e/run.sh                                  # whole suite
#   ./e2e/run.sh tests/03-incidents.spec.js       # one file
#
# Results land in e2e/playwright-report (HTML), e2e/results.json and
# e2e/test-results (screenshots, traces, video of any failure).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.50.0-noble}"
BASE_URL="${BASE_URL:-http://localhost:8083}"

echo "[e2e] waiting for ${BASE_URL} to answer"
for attempt in $(seq 1 90); do
  if curl -fsS "${BASE_URL}/health" >/dev/null 2>&1; then
    echo "[e2e] stack is up (attempt ${attempt})"
    break
  fi
  if [ "${attempt}" -eq 90 ]; then
    echo "[e2e] ${BASE_URL} never became ready - is 'docker compose up -d' running?" >&2
    exit 1
  fi
  sleep 2
done

# node_modules lives in a named volume so a rerun does not re-download the
# Playwright package on every invocation.
docker volume create shoplifting-e2e-node-modules >/dev/null

docker run --rm \
  --network host \
  -e BASE_URL="${BASE_URL}" \
  -e CI=1 \
  -v "${HERE}:/e2e" \
  -v shoplifting-e2e-node-modules:/e2e/node_modules \
  -w /e2e \
  --user root \
  "${IMAGE}" \
  bash -lc "npm install --no-audit --no-fund --silent && npx playwright test $*"
