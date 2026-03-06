#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import hmac
import json
import os
import subprocess
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("DEPLOY_HOOK_HOST", "127.0.0.1")
PORT = int(os.environ.get("DEPLOY_HOOK_PORT", "9005"))
HOOK_PATH = os.environ.get("DEPLOY_HOOK_PATH", "/github-webhook-products-information-manage")
SECRET = os.environ.get("DEPLOY_HOOK_SECRET", "")
EXPECT_REPO = os.environ.get("DEPLOY_REPO", "")
EXPECT_REF = os.environ.get("DEPLOY_BRANCH", "refs/heads/main")
DEPLOY_SCRIPT = os.environ.get("DEPLOY_SCRIPT", str(Path(__file__).resolve().parent / "deploy.sh"))
DEPLOY_LOG = os.environ.get("DEPLOY_LOG", "/tmp/products-information-manage-deploy.log")


def now_text() -> str:
    return datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")


def append_log(text: str) -> None:
    Path(DEPLOY_LOG).parent.mkdir(parents=True, exist_ok=True)
    with open(DEPLOY_LOG, "a", encoding="utf-8") as fh:
        fh.write(f"[{now_text()}] {text}\n")


def verify_signature(payload: bytes, signature_header: str | None) -> bool:
    if not SECRET:
        return False
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    digest = hmac.new(SECRET.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    expected = f"sha256={digest}"
    return hmac.compare_digest(expected, signature_header)


def run_deploy() -> tuple[int, str]:
    result = subprocess.run(
        ["bash", DEPLOY_SCRIPT],
        capture_output=True,
        text=True,
        timeout=1800,
        check=False,
    )
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    return result.returncode, output.strip()


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != HOOK_PATH:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        payload = self.rfile.read(length)
        signature = self.headers.get("X-Hub-Signature-256")
        event = self.headers.get("X-GitHub-Event", "")

        if not verify_signature(payload, signature):
            append_log("拒绝请求：签名校验失败")
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid signature"})
            return

        if event == "ping":
            self._json(HTTPStatus.OK, {"ok": True, "message": "pong"})
            return

        if event != "push":
            self._json(HTTPStatus.OK, {"ok": True, "message": f"ignored event: {event}"})
            return

        try:
            data = json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
            return

        repo_name = str(data.get("repository", {}).get("full_name", ""))
        ref = str(data.get("ref", ""))

        if EXPECT_REPO and repo_name != EXPECT_REPO:
            self._json(
                HTTPStatus.OK,
                {"ok": True, "message": f"ignored repo: {repo_name}", "expected": EXPECT_REPO},
            )
            return

        if ref != EXPECT_REF:
            self._json(HTTPStatus.OK, {"ok": True, "message": f"ignored ref: {ref}"})
            return

        append_log(f"收到部署请求 repo={repo_name} ref={ref}")
        code, output = run_deploy()
        append_log(f"部署结束 code={code}\n{output}")

        if code == 0:
            self._json(HTTPStatus.OK, {"ok": True, "message": "deploy success"})
        else:
            self._json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "message": "deploy failed", "exit_code": code},
            )

    def log_message(self, fmt: str, *args: object) -> None:
        append_log(fmt % args)


if __name__ == "__main__":
    if not SECRET:
        raise SystemExit("DEPLOY_HOOK_SECRET 未设置，拒绝启动")
    if not os.path.isfile(DEPLOY_SCRIPT):
        raise SystemExit(f"DEPLOY_SCRIPT 不存在: {DEPLOY_SCRIPT}")

    append_log(f"Webhook 服务启动于 {HOST}:{PORT} path={HOOK_PATH}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()
