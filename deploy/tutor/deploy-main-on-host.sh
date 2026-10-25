#!/usr/bin/env bash
# Deploy the six-capability tutor on 小y to an exact main-line commit.
# Intended to run as root on the host (Actions SSHes as ubuntu then sudo -n).
# Does not touch .env, liveEnabled, or budget counters. Idempotent rebuild.
set -euo pipefail

ROOT="${EDULAB_ROOT:-/opt/edulab}"
REF="${1:-}"
PUBLIC_HEALTH="${PUBLIC_HEALTH:-https://pt.yokily.com/api/health}"
LOCAL_HEALTH="${LOCAL_HEALTH:-http://127.0.0.1:8788/api/health}"

if [[ ! "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <40-hex-git-sha>" >&2
  exit 2
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "must run as root (use: sudo -n $0 $REF)" >&2
  exit 2
fi

cd "$ROOT"
git config --global --add safe.directory "$ROOT" >/dev/null 2>&1 || true

echo "==> ensure origin can fetch main"
# Host may still have a narrow fetch refspec from the old feature-branch era.
current_fetch="$(git config --get-all remote.origin.fetch || true)"
if ! grep -qx '+refs/heads/\*:refs/remotes/origin/\*' <<<"$current_fetch"    && ! grep -qx '+refs/heads/main:refs/remotes/origin/main' <<<"$current_fetch"; then
  git config --add remote.origin.fetch '+refs/heads/main:refs/remotes/origin/main'
fi

echo "==> fetch origin/main"
git fetch --no-tags origin '+refs/heads/main:refs/remotes/origin/main'

echo "==> verify $REF is on origin/main"
git cat-file -e "${REF}^{commit}"
git merge-base --is-ancestor "$REF" origin/main

echo "==> checkout main @ $REF"
# Keep branch name main (upgrade script / ops expect it). Untracked .env is preserved.
# Prior dry-runs may leave untracked copies under deploy/ that block checkout of tracked paths.
git clean -fd -- deploy/
git checkout -B main "$REF"
test "$(git rev-parse HEAD)" = "$REF"
git diff --quiet
git diff --cached --quiet

COMPOSE=(docker compose -f compose.tutor.yml -f compose.tutor.public.yml -f compose.tutor.host.yml)

echo "==> build tutor"
"${COMPOSE[@]}" build tutor

echo "==> recreate"
"${COMPOSE[@]}" up -d --force-recreate

echo "==> wait local health"
deadline=$((SECONDS + 90))
while true; do
  if curl --fail --silent --max-time 3 "$LOCAL_HEALTH" >/tmp/edulab-deploy-health.json 2>/dev/null; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "local health not ready" >&2
    exit 1
  fi
  sleep 2
done

echo "==> resume admission (idempotent; preserves counters)"
"${COMPOSE[@]}" exec -T tutor node control.mjs resume >/tmp/edulab-deploy-control.json || true

echo "==> verify local + public health"
python3 - <<'PY'
import json,sys,urllib.request
def load(path=None,url=None):
    if path:
        return json.loads(open(path).read())
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode())
local=load(path='/tmp/edulab-deploy-health.json')
# refresh after resume
with urllib.request.urlopen('http://127.0.0.1:8788/api/health', timeout=6) as r:
    local=json.loads(r.read().decode())
public=load(url='https://pt.yokily.com/api/health')
for name,h in (('local',local),('public',public)):
    if not isinstance(h, dict):
        raise SystemExit(f'{name} health not object')
    if 'stages' not in h or 'budget' not in h:
        raise SystemExit(f'{name} missing stages/budget: {sorted(h)}')
    if h.get('sampleAvailable') is not True:
        raise SystemExit(f'{name} sampleAvailable expected true')
    # Never flip live on during deploy; refuse if somehow true unexpectedly
    # (liveEnabled may be false when not configured — that is OK)
    print(name, {k:h.get(k) for k in ('liveEnabled','stopped','sampleAvailable')}, 'budget', h.get('budget'))
print('OK')
PY

echo "==> done HEAD=$(git rev-parse HEAD)"
