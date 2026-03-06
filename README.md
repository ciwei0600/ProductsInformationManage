# 产品信息管理系统

基于 `Flask + SQLite` 的 Web 产品信息管理系统，支持：

- 产品目录管理（新增、重命名、删除、树形展示）
- 产品管理（新增、编辑、删除、目录筛选、关键词搜索）
- 产品图片管理（上传、删除、预览）
- 从 `目录图片.zip` 一键导入目录/产品/图片

产品字段包含：产品编号、中文名、作用、描述、喷洒半径（可选）、单个重量、包装数量、包装尺寸、总重量。

## 1. 安装与启动

```bash
cd /Users/dc/Desktop/Projects/ProductsInformationManage
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

启动后访问：`http://127.0.0.1:5000`

如果 `5000` 端口被占用：

```bash
PORT=5055 python app.py
```

## 2. 导入当前目录 zip

在页面顶部 `Zip 导入` 区域：

- Zip 路径填 `目录图片.zip`（默认已填写）
- 点击 `导入`

如果要覆盖重建，勾选 `清空现有数据后导入`。

## 3. API 示例（curl）

### 3.1 健康检查

```bash
curl http://127.0.0.1:5000/api/health
```

### 3.2 查询目录

```bash
curl http://127.0.0.1:5000/api/categories
```

### 3.3 新增目录

```bash
curl -X POST http://127.0.0.1:5000/api/categories \
  -H 'Content-Type: application/json' \
  -d '{"name":"测试目录","parent_id":null}'
```

### 3.4 查询产品

```bash
curl 'http://127.0.0.1:5000/api/products?page=1&page_size=20&q=SQ1001'
```

### 3.5 新增产品

```bash
curl -X POST http://127.0.0.1:5000/api/products \
  -H 'Content-Type: application/json' \
  -d '{
    "code":"TEST001",
    "chinese_name":"测试产品",
    "effect":"用于温室微喷",
    "description":"适用于育苗棚",
    "spray_radius":"2m",
    "unit_weight":"120g",
    "package_quantity":"100个/箱",
    "package_size":"40x30x20cm",
    "gross_weight":"12kg",
    "category_id":null
  }'
```

### 3.6 导入 zip

```bash
curl -X POST http://127.0.0.1:5000/api/import \
  -H 'Content-Type: application/json' \
  -d '{"zip_path":"目录图片.zip","reset":false}'
```

## 4. GitHub + Webhook VPS 部署

项目已内置与其他项目同风格的部署文件：

- `Dockerfile`
- `docker-compose.yml`（服务名 `web`）
- `deploy/deploy.sh`（只更新目标服务）
- `deploy/github_webhook.py`（HMAC 校验）
- `deploy/app.env.example`
- `deploy/hook.env.example`
- `deploy/products-information-manage.service.example`
- `deploy/products-information-manage-hook.service.example`
- `deploy/setup_vps_ip.sh`（一键安装 Docker/Nginx/systemd/hook）

### 4.1 推送到 GitHub

```bash
cd /Users/dc/Desktop/Projects/ProductsInformationManage
git init
git checkout -b main
git add .
git commit -m "init products information manage with vps deploy"
git remote add origin <你的仓库URL>
git push -u origin main
```

说明：`目录图片.zip`、`deploy/*.env`、`data/pim.db`、`data/media/` 已在 `.gitignore` 中排除。

### 4.2 VPS 初始化并启用 webhook 自动部署

在 Ubuntu 22.04+ VPS 执行（按需替换变量）：

```bash
cd /opt
git clone <你的仓库URL> ProductsInformationManage
cd /opt/ProductsInformationManage

APP_USER=ubuntu \
APP_GROUP=ubuntu \
APP_DIR=/opt/ProductsInformationManage \
REPO_URL=<你的仓库URL> \
REPO_FULL_NAME=<你的GitHub用户名/仓库名> \
BRANCH=main \
APP_HOST=<你的域名或nip.io> \
APP_PORT=8085 \
HOOK_PORT=9005 \
HOOK_PATH=/github-webhook-products-information-manage \
COMPOSE_PROJECT_NAME=productsinformationmanage \
SERVICE_NAME=web \
bash deploy/setup_vps_ip.sh
```

执行后会输出：

- App URL：`http://<APP_HOST>/`
- Webhook URL：`http://<APP_HOST>/github-webhook-products-information-manage`
- Webhook Secret（填到 GitHub Webhook）
