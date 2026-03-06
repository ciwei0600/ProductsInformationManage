#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/opt/ProductsInformationManage}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="${COMPOSE_FILE:-$PROJECT_DIR/docker-compose.yml}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-$PROJECT_DIR/deploy/app.env}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-productsinformationmanage}"
SERVICE_NAME="${SERVICE_NAME:-web}"
DOCKER_BIN="${DOCKER_BIN:-/usr/bin/docker}"
GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-}"

cd "$PROJECT_DIR"

if [ -n "$GIT_SSH_COMMAND" ]; then
  export GIT_SSH_COMMAND
fi

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "compose file not found: $COMPOSE_FILE" >&2
  exit 1
fi

if [ ! -x "$DOCKER_BIN" ]; then
  echo "docker binary not found: $DOCKER_BIN" >&2
  exit 1
fi

"$DOCKER_BIN" compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" up -d --no-deps --build "$SERVICE_NAME"
"$DOCKER_BIN" compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" ps

echo "deploy ok: $(date '+%Y-%m-%d %H:%M:%S')"
