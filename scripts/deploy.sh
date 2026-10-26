#!/usr/bin/env bash
# Botara deploy (git-based).
#
# Pulls the latest main, installs workspace deps, rebuilds the web
# bundle, restarts the systemd services, and health-checks the result.
#
# Usage (on the VPS):
#   bash scripts/deploy.sh
#
# Assumes: the checkout lives at ~/botara, the deploy key is configured
# for git@github-botara:kampunginggrisec/botara.git, and the botara-*
# systemd units point at this checkout (EnvironmentFile=~/botara/.env).
set -euo pipefail

cd "$(dirname "$0")/.."

# bun installs to ~/.bun by default and is not on PATH in non-login
# shells (ssh one-shots, cron).
if ! command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "==> git pull"
git pull --ff-only origin main

echo "==> bun install"
bun install

echo "==> build web"
bun run --cwd apps/web build

echo "==> restart services"
sudo systemctl restart botara-api botara-realtime botara-worker

sleep 3

echo "==> health check"
curl -fsS http://127.0.0.1:3001/health >/dev/null && echo "api: healthy"
systemctl is-active --quiet botara-realtime && echo "realtime: active"
systemctl is-active --quiet botara-worker && echo "worker: active"

echo "==> done at $(git log --oneline -1)"
