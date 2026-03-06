#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-ubuntu}"
APP_GROUP="${APP_GROUP:-$APP_USER}"
APP_DIR="${APP_DIR:-/opt/ProductsInformationManage}"
REPO_URL="${REPO_URL:-https://github.com/ciwei0600/ProductsInformationManage.git}"
REPO_FULL_NAME="${REPO_FULL_NAME:-ciwei0600/ProductsInformationManage}"
BRANCH="${BRANCH:-main}"
APP_HOST="${APP_HOST:-pim.example.com}"
APP_PORT="${APP_PORT:-8085}"
HOOK_PORT="${HOOK_PORT:-9005}"
HOOK_PATH="${HOOK_PATH:-/github-webhook-products-information-manage}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-productsinformationmanage}"
SERVICE_NAME="${SERVICE_NAME:-web}"
GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-}"

APP_SERVICE_NAME="${APP_SERVICE_NAME:-products-information-manage.service}"
HOOK_SERVICE_NAME="${HOOK_SERVICE_NAME:-products-information-manage-hook.service}"
NGINX_SITE_NAME="${NGINX_SITE_NAME:-products-information-manage.conf}"

run_as_app() {
  sudo -u "$APP_USER" -H bash -lc "$*"
}

info() {
  printf "\n[%s] %s\n" "$(date '+%H:%M:%S')" "$*"
}

check_nginx_conflicts() {
  local server_conflicts webhook_conflicts default_count

  server_conflicts="$(grep -R "server_name" -n /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/sites-available 2>/dev/null | grep -F "$APP_HOST" | grep -v "$NGINX_SITE_NAME" || true)"
  if [ -n "$server_conflicts" ]; then
    echo "发现 server_name 冲突（$APP_HOST）:" >&2
    echo "$server_conflicts" >&2
    exit 1
  fi

  webhook_conflicts="$(grep -R "/github-webhook" -n /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/nginx/sites-available 2>/dev/null | grep -F "$HOOK_PATH" | grep -v "$NGINX_SITE_NAME" || true)"
  if [ -n "$webhook_conflicts" ]; then
    echo "发现 webhook path 冲突（$HOOK_PATH）:" >&2
    echo "$webhook_conflicts" >&2
    exit 1
  fi

  default_count="$(grep -R "default_server" -n /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${default_count:-0}" -lt 1 ]; then
    echo "警告：未检测到 default_server guard，建议保留一个默认站点防护。" >&2
  fi
}

if [ "$(id -u)" -ne 0 ] && ! sudo -n true >/dev/null 2>&1; then
  echo "需要 passwordless sudo（或 root）执行该脚本。" >&2
  exit 1
fi

info "1/9 安装依赖"
sudo apt update
sudo apt install -y git docker.io docker-compose-v2 python3 python3-venv nginx openssl

info "2/9 启动 Docker 并准备用户"
sudo systemctl enable --now docker
id "$APP_USER" >/dev/null 2>&1 || { echo "用户不存在: $APP_USER" >&2; exit 1; }
sudo usermod -aG docker "$APP_USER" || true
sudo mkdir -p /opt
sudo chown -R "$APP_USER:$APP_GROUP" /opt

info "3/9 仓库可达性检查"
if [ -n "$GIT_SSH_COMMAND" ]; then
  run_as_app "GIT_SSH_COMMAND='$GIT_SSH_COMMAND' git ls-remote '$REPO_URL' >/dev/null"
else
  run_as_app "git ls-remote '$REPO_URL' >/dev/null"
fi

info "4/9 拉取/更新代码"
if run_as_app "test -d '$APP_DIR/.git'"; then
  run_as_app "cd '$APP_DIR' && git remote set-url origin '$REPO_URL'"
  if [ -n "$GIT_SSH_COMMAND" ]; then
    run_as_app "cd '$APP_DIR' && GIT_SSH_COMMAND='$GIT_SSH_COMMAND' git fetch origin '$BRANCH' && git checkout '$BRANCH' && git pull --ff-only origin '$BRANCH'"
  else
    run_as_app "cd '$APP_DIR' && git fetch origin '$BRANCH' && git checkout '$BRANCH' && git pull --ff-only origin '$BRANCH'"
  fi
else
  if [ -n "$GIT_SSH_COMMAND" ]; then
    run_as_app "GIT_SSH_COMMAND='$GIT_SSH_COMMAND' git clone -b '$BRANCH' '$REPO_URL' '$APP_DIR'"
  else
    run_as_app "git clone -b '$BRANCH' '$REPO_URL' '$APP_DIR'"
  fi
fi

info "5/9 初始化运行环境"
run_as_app "cd '$APP_DIR' && python3 -m venv .venv"
run_as_app "cd '$APP_DIR' && .venv/bin/pip install -r requirements.txt"
run_as_app "cd '$APP_DIR' && mkdir -p deploy data"
run_as_app "cd '$APP_DIR' && [ -f deploy/app.env ] || cp deploy/app.env.example deploy/app.env"
run_as_app "cd '$APP_DIR' && [ -f deploy/hook.env ] || cp deploy/hook.env.example deploy/hook.env"

APP_ENV_FILE="$APP_DIR/deploy/app.env"
HOOK_ENV_FILE="$APP_DIR/deploy/hook.env"

DEPLOY_HOOK_SECRET="$(run_as_app "grep -E '^DEPLOY_HOOK_SECRET=' '$HOOK_ENV_FILE' | cut -d '=' -f 2- || true")"
if [ -z "$DEPLOY_HOOK_SECRET" ] || [ "$DEPLOY_HOOK_SECRET" = "replace_with_random_webhook_secret" ]; then
  DEPLOY_HOOK_SECRET="$(openssl rand -hex 32)"
fi

if [ -n "$GIT_SSH_COMMAND" ]; then
  GIT_SSH_COMMAND_QUOTED="\"$GIT_SSH_COMMAND\""
else
  GIT_SSH_COMMAND_QUOTED=""
fi

run_as_app "bash -lc '
  set -euo pipefail
  upsert_kv() {
    local file="\$1" key="\$2" value="\$3"
    if grep -q "^\${key}=" "\$file"; then
      sed -i "s|^\${key}=.*|\${key}=\${value}|" "\$file"
    else
      echo "\${key}=\${value}" >>"\$file"
    fi
  }

  upsert_kv "$APP_ENV_FILE" APP_PORT "$APP_PORT"
  upsert_kv "$APP_ENV_FILE" PORT "8080"
  upsert_kv "$APP_ENV_FILE" COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"

  upsert_kv "$HOOK_ENV_FILE" DEPLOY_HOOK_HOST "127.0.0.1"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_HOOK_PORT "$HOOK_PORT"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_HOOK_PATH "$HOOK_PATH"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_HOOK_SECRET "$DEPLOY_HOOK_SECRET"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_REPO "$REPO_FULL_NAME"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_BRANCH "refs/heads/$BRANCH"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_SCRIPT "$APP_DIR/deploy/deploy.sh"
  upsert_kv "$HOOK_ENV_FILE" DEPLOY_LOG "/var/log/products-information-manage/deploy-hook.log"
  upsert_kv "$HOOK_ENV_FILE" PROJECT_DIR "$APP_DIR"
  upsert_kv "$HOOK_ENV_FILE" BRANCH "$BRANCH"
  upsert_kv "$HOOK_ENV_FILE" COMPOSE_FILE "$APP_DIR/docker-compose.yml"
  upsert_kv "$HOOK_ENV_FILE" COMPOSE_ENV_FILE "$APP_DIR/deploy/app.env"
  upsert_kv "$HOOK_ENV_FILE" COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT_NAME"
  upsert_kv "$HOOK_ENV_FILE" SERVICE_NAME "$SERVICE_NAME"
  upsert_kv "$HOOK_ENV_FILE" DOCKER_BIN "/usr/bin/docker"
  if [ -n "$GIT_SSH_COMMAND_QUOTED" ]; then
    upsert_kv "$HOOK_ENV_FILE" GIT_SSH_COMMAND "$GIT_SSH_COMMAND_QUOTED"
  fi
  chmod 600 "$APP_ENV_FILE" "$HOOK_ENV_FILE"
'"

info "6/9 检查 Nginx 路由冲突"
check_nginx_conflicts

info "7/9 安装 systemd 服务"
sudo cp "$APP_DIR/deploy/products-information-manage.service.example" "/etc/systemd/system/$APP_SERVICE_NAME"
sudo cp "$APP_DIR/deploy/products-information-manage-hook.service.example" "/etc/systemd/system/$HOOK_SERVICE_NAME"
sudo sed -i "s#__APP_DIR__#$APP_DIR#g" "/etc/systemd/system/$APP_SERVICE_NAME" "/etc/systemd/system/$HOOK_SERVICE_NAME"
sudo sed -i "s#__COMPOSE_PROJECT_NAME__#$COMPOSE_PROJECT_NAME#g" "/etc/systemd/system/$APP_SERVICE_NAME"
sudo sed -i "s#__SERVICE_NAME__#$SERVICE_NAME#g" "/etc/systemd/system/$APP_SERVICE_NAME"
sudo sed -i "s#__APP_USER__#$APP_USER#g" "/etc/systemd/system/$HOOK_SERVICE_NAME"
sudo sed -i "s#__APP_GROUP__#$APP_GROUP#g" "/etc/systemd/system/$HOOK_SERVICE_NAME"
sudo mkdir -p /var/log/products-information-manage
sudo chown -R "$APP_USER:$APP_GROUP" /var/log/products-information-manage

info "8/9 写入并启用 Nginx 站点"
sudo tee "/etc/nginx/sites-available/$NGINX_SITE_NAME" >/dev/null <<NGINX
server {
    listen 80;
    server_name $APP_HOST;

    location $HOOK_PATH {
        proxy_pass http://127.0.0.1:$HOOK_PORT$HOOK_PATH;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

sudo ln -sfn "/etc/nginx/sites-available/$NGINX_SITE_NAME" "/etc/nginx/sites-enabled/$NGINX_SITE_NAME"
sudo nginx -t
sudo systemctl reload nginx

info "9/9 启动服务并首发部署"
sudo systemctl daemon-reload
sudo systemctl enable --now "$APP_SERVICE_NAME"
sudo systemctl enable --now "$HOOK_SERVICE_NAME"
run_as_app "cd '$APP_DIR' && set -a && . deploy/hook.env && set +a && bash deploy/deploy.sh"

echo
echo "================ 完成 ================"
echo "App URL:       http://$APP_HOST/"
echo "Webhook URL:   http://$APP_HOST$HOOK_PATH"
echo "Webhook Secret: $DEPLOY_HOOK_SECRET"
echo
echo "状态检查:"
echo "  sudo systemctl is-active $APP_SERVICE_NAME $HOOK_SERVICE_NAME nginx"
echo "  sudo docker compose --project-name $COMPOSE_PROJECT_NAME --env-file $APP_DIR/deploy/app.env -f $APP_DIR/docker-compose.yml ps"
echo "  sudo tail -n 200 /var/log/products-information-manage/deploy-hook.log"
