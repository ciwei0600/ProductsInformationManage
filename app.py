from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from flask import Flask, g, jsonify, render_template, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "pim.db"
DEFAULT_ZIP_PATH = BASE_DIR / "目录图片.zip"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
PRODUCT_CODE_PATTERN = re.compile(r"^[A-Za-z]{1,10}\d[\w-]*$")
NATURAL_TOKEN_PATTERN = re.compile(r"(\d+(?:\.\d+)?)")


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    init_db()

    @app.route("/")
    def index() -> str:
        return render_template("index.html", default_zip=str(DEFAULT_ZIP_PATH.name))

    @app.route("/media/<path:filename>")
    def media(filename: str):
        return send_from_directory(MEDIA_DIR, filename)

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True, "time": utc_now()})

    @app.route("/api/stats")
    def stats():
        conn = get_db()
        category_count = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
        product_count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        image_count = conn.execute("SELECT COUNT(*) FROM product_images").fetchone()[0]
        return jsonify(
            {
                "categories": category_count,
                "products": product_count,
                "images": image_count,
            }
        )

    @app.route("/api/categories", methods=["GET"])
    def list_categories():
        conn = get_db()
        rows = conn.execute(
            """
            SELECT id, name, parent_id, created_at
            FROM categories
            ORDER BY COALESCE(parent_id, 0), id
            """
        ).fetchall()
        items = [dict(row) for row in rows]
        tree = build_category_tree(items)
        return jsonify({"items": items, "tree": tree})

    @app.route("/api/categories", methods=["POST"])
    def create_category():
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        parent_id = payload.get("parent_id")

        if not name:
            return jsonify({"error": "目录名称不能为空"}), 400

        conn = get_db()
        if parent_id is not None:
            parent_exists = conn.execute(
                "SELECT 1 FROM categories WHERE id = ?", (parent_id,)
            ).fetchone()
            if parent_exists is None:
                return jsonify({"error": "父级目录不存在"}), 400

        category_id = get_or_create_category(conn, name, parent_id)
        conn.commit()
        return jsonify({"id": category_id, "name": name, "parent_id": parent_id})

    @app.route("/api/categories/<int:category_id>", methods=["PUT"])
    def update_category(category_id: int):
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()

        if not name:
            return jsonify({"error": "目录名称不能为空"}), 400

        conn = get_db()
        current = conn.execute(
            "SELECT id, parent_id FROM categories WHERE id = ?", (category_id,)
        ).fetchone()
        if current is None:
            return jsonify({"error": "目录不存在"}), 404

        parent_id = current["parent_id"]
        if parent_id is None:
            duplicate = conn.execute(
                "SELECT 1 FROM categories WHERE id != ? AND parent_id IS NULL AND name = ?",
                (category_id, name),
            ).fetchone()
        else:
            duplicate = conn.execute(
                "SELECT 1 FROM categories WHERE id != ? AND parent_id = ? AND name = ?",
                (category_id, parent_id, name),
            ).fetchone()

        if duplicate is not None:
            return jsonify({"error": "同级目录下已存在同名目录"}), 400

        conn.execute("UPDATE categories SET name = ? WHERE id = ?", (name, category_id))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/categories/<int:category_id>", methods=["DELETE"])
    def delete_category(category_id: int):
        conn = get_db()
        exists = conn.execute(
            "SELECT 1 FROM categories WHERE id = ?", (category_id,)
        ).fetchone()
        if exists is None:
            return jsonify({"error": "目录不存在"}), 404

        child_count = conn.execute(
            "SELECT COUNT(*) FROM categories WHERE parent_id = ?", (category_id,)
        ).fetchone()[0]
        if child_count > 0:
            return jsonify({"error": "请先删除子目录"}), 400

        product_count = conn.execute(
            "SELECT COUNT(*) FROM products WHERE category_id = ?", (category_id,)
        ).fetchone()[0]
        if product_count > 0:
            return jsonify({"error": "目录下还有产品，无法删除"}), 400

        conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/products", methods=["GET"])
    def list_products():
        conn = get_db()
        category_id = request.args.get("category_id", type=int)
        keyword = (request.args.get("q") or "").strip()
        page = max(request.args.get("page", default=1, type=int), 1)
        page_size = min(max(request.args.get("page_size", default=20, type=int), 1), 100)

        where_clauses = []
        params: list[Any] = []

        if category_id:
            ids = get_descendant_category_ids(conn, category_id)
            if not ids:
                return jsonify({"items": [], "total": 0, "page": page, "page_size": page_size})
            placeholders = ",".join("?" for _ in ids)
            where_clauses.append(f"p.category_id IN ({placeholders})")
            params.extend(ids)

        if keyword:
            where_clauses.append(
                """
                (
                    p.code LIKE ?
                    OR p.name LIKE ?
                    OR p.chinese_name LIKE ?
                    OR p.effect LIKE ?
                    OR p.description LIKE ?
                )
                """
            )
            like = f"%{keyword}%"
            params.extend([like, like, like, like, like])

        where_sql = ""
        if where_clauses:
            where_sql = "WHERE " + " AND ".join(where_clauses)

        total = conn.execute(
            f"SELECT COUNT(*) FROM products p {where_sql}", params
        ).fetchone()[0]

        offset = (page - 1) * page_size
        rows = conn.execute(
            f"""
            SELECT
                p.id,
                p.code,
                p.name,
                COALESCE(NULLIF(p.chinese_name, ''), p.name) AS chinese_name,
                p.effect,
                p.description,
                p.spray_radius,
                p.unit_weight,
                p.package_quantity,
                p.package_size,
                p.gross_weight,
                p.category_id,
                p.created_at,
                p.updated_at,
                c.name AS category_name,
                (
                    SELECT image_path
                    FROM product_images pi
                    WHERE pi.product_id = p.id
                    ORDER BY pi.sort_order, pi.id
                    LIMIT 1
                ) AS first_image,
                (
                    SELECT COUNT(*)
                    FROM product_images pi
                    WHERE pi.product_id = p.id
                ) AS image_count
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            {where_sql}
            ORDER BY
                COALESCE(p.category_id, 0) ASC,
                COALESCE(NULLIF(p.chinese_name, ''), p.name, p.code) COLLATE NATURAL_ZH_NUM ASC,
                p.id ASC
            LIMIT ? OFFSET ?
            """,
            [*params, page_size, offset],
        ).fetchall()

        items = [dict(row) for row in rows]
        return jsonify({"items": items, "total": total, "page": page, "page_size": page_size})

    @app.route("/api/products/<int:product_id>", methods=["GET"])
    def get_product(product_id: int):
        conn = get_db()
        product = conn.execute(
            """
            SELECT
                p.id,
                p.code,
                p.name,
                COALESCE(NULLIF(p.chinese_name, ''), p.name) AS chinese_name,
                p.effect,
                p.description,
                p.spray_radius,
                p.unit_weight,
                p.package_quantity,
                p.package_size,
                p.gross_weight,
                p.category_id,
                p.created_at,
                p.updated_at,
                c.name AS category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.id = ?
            """,
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        images = conn.execute(
            """
            SELECT id, image_path, sort_order, created_at
            FROM product_images
            WHERE product_id = ?
            ORDER BY sort_order, id
            """,
            (product_id,),
        ).fetchall()
        return jsonify({"product": dict(product), "images": [dict(row) for row in images]})

    @app.route("/api/products", methods=["POST"])
    def create_product():
        payload = request.get_json(silent=True) or {}
        try:
            product_id = save_product(None, payload)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except sqlite3.IntegrityError:
            return jsonify({"error": "产品编码已存在"}), 400
        return jsonify({"id": product_id})

    @app.route("/api/products/<int:product_id>", methods=["PUT"])
    def update_product(product_id: int):
        payload = request.get_json(silent=True) or {}
        try:
            save_product(product_id, payload)
        except LookupError as exc:
            return jsonify({"error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except sqlite3.IntegrityError:
            return jsonify({"error": "产品编码已存在"}), 400
        return jsonify({"ok": True})

    @app.route("/api/products/<int:product_id>", methods=["DELETE"])
    def delete_product(product_id: int):
        conn = get_db()
        product = conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        image_rows = conn.execute(
            "SELECT image_path FROM product_images WHERE product_id = ?", (product_id,)
        ).fetchall()

        conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
        conn.commit()

        for row in image_rows:
            delete_media_file(row["image_path"])

        return jsonify({"ok": True})

    @app.route("/api/products/<int:product_id>/images", methods=["POST"])
    def upload_product_image(product_id: int):
        conn = get_db()
        product = conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        uploaded = request.files.get("image")
        if uploaded is None or uploaded.filename is None:
            return jsonify({"error": "请选择图片文件"}), 400

        ext = Path(uploaded.filename).suffix.lower()
        if ext not in IMAGE_EXTENSIONS:
            return jsonify({"error": "不支持的图片格式"}), 400

        digest = hashlib.md5(
            f"{product_id}:{uploaded.filename}:{datetime.utcnow().timestamp()}".encode("utf-8")
        ).hexdigest()
        rel_path = f"{product_id}/{digest}{ext}"
        abs_path = MEDIA_DIR / rel_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        uploaded.save(abs_path)

        image_id = insert_product_image(conn, product_id, rel_path)
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (utc_now(), product_id))
        conn.commit()

        return jsonify({"id": image_id, "image_path": rel_path})

    @app.route("/api/product-images/<int:image_id>", methods=["DELETE"])
    def delete_product_image(image_id: int):
        conn = get_db()
        row = conn.execute(
            "SELECT id, product_id, image_path FROM product_images WHERE id = ?", (image_id,)
        ).fetchone()
        if row is None:
            return jsonify({"error": "图片不存在"}), 404

        conn.execute("DELETE FROM product_images WHERE id = ?", (image_id,))
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (utc_now(), row["product_id"]))
        conn.commit()

        delete_media_file(row["image_path"])
        return jsonify({"ok": True})

    @app.route("/api/import", methods=["POST"])
    def import_zip_data():
        payload = request.get_json(silent=True) or {}
        zip_path = (payload.get("zip_path") or str(DEFAULT_ZIP_PATH)).strip()
        reset = bool(payload.get("reset"))

        zip_file = Path(zip_path)
        if not zip_file.is_absolute():
            zip_file = BASE_DIR / zip_file

        if not zip_file.exists():
            return jsonify({"error": f"找不到 zip 文件: {zip_file}"}), 404

        try:
            result = import_from_zip(zip_file, reset=reset)
        except zipfile.BadZipFile:
            return jsonify({"error": "zip 文件格式不正确"}), 400
        except Exception as exc:  # noqa: BLE001
            return jsonify({"error": f"导入失败: {exc}"}), 500

        return jsonify(result)

    @app.teardown_appcontext
    def close_connection(_: Optional[BaseException]):
        conn = g.pop("db", None)
        if conn is not None:
            conn.close()

    return app


def utc_now() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def get_db() -> sqlite3.Connection:
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.create_collation("NATURAL_ZH_NUM", natural_collation)
        g.db = conn
    return g.db


def natural_collation(left: str | None, right: str | None) -> int:
    left_key = natural_sort_key(left)
    right_key = natural_sort_key(right)

    for left_part, right_part in zip(left_key, right_key):
        left_type, left_value = left_part
        right_type, right_value = right_part

        if left_type != right_type:
            return -1 if left_type < right_type else 1

        if left_value != right_value:
            return -1 if left_value < right_value else 1

    if len(left_key) != len(right_key):
        return -1 if len(left_key) < len(right_key) else 1
    return 0


def natural_sort_key(value: str | None) -> list[tuple[int, Any]]:
    text = (value or "").strip()
    if not text:
        return [(1, "")]

    key: list[tuple[int, Any]] = []
    for token in NATURAL_TOKEN_PATTERN.split(text):
        if token == "":
            continue
        if NATURAL_TOKEN_PATTERN.fullmatch(token):
            key.append((0, float(token)))
        else:
            key.append((1, token.lower()))
    return key


def init_db() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name_parent
        ON categories(name, COALESCE(parent_id, -1));

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '',
            chinese_name TEXT NOT NULL DEFAULT '',
            effect TEXT NOT NULL DEFAULT '',
            category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
            description TEXT NOT NULL DEFAULT '',
            spray_radius TEXT NOT NULL DEFAULT '',
            unit_weight TEXT NOT NULL DEFAULT '',
            package_quantity TEXT NOT NULL DEFAULT '',
            package_size TEXT NOT NULL DEFAULT '',
            gross_weight TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            image_path TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_unique
        ON product_images(product_id, image_path);
        """
    )
    ensure_product_columns(conn)
    conn.commit()
    conn.close()


def ensure_product_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(products)").fetchall()
    }
    required_columns = {
        "name": "TEXT NOT NULL DEFAULT ''",
        "chinese_name": "TEXT NOT NULL DEFAULT ''",
        "effect": "TEXT NOT NULL DEFAULT ''",
        "spray_radius": "TEXT NOT NULL DEFAULT ''",
        "unit_weight": "TEXT NOT NULL DEFAULT ''",
        "package_quantity": "TEXT NOT NULL DEFAULT ''",
        "package_size": "TEXT NOT NULL DEFAULT ''",
        "gross_weight": "TEXT NOT NULL DEFAULT ''",
    }

    for column_name, column_type in required_columns.items():
        if column_name not in existing_columns:
            conn.execute(f"ALTER TABLE products ADD COLUMN {column_name} {column_type}")

    conn.execute(
        """
        UPDATE products
        SET chinese_name = name
        WHERE TRIM(COALESCE(chinese_name, '')) = ''
        """
    )
    conn.execute(
        """
        UPDATE products
        SET name = chinese_name
        WHERE TRIM(COALESCE(name, '')) = ''
        """
    )


def build_category_tree(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    node_map: dict[int, dict[str, Any]] = {}
    roots: list[dict[str, Any]] = []

    for item in items:
        node_map[item["id"]] = {**item, "children": []}

    for item in items:
        node = node_map[item["id"]]
        parent_id = item["parent_id"]
        if parent_id is None:
            roots.append(node)
        else:
            parent = node_map.get(parent_id)
            if parent is None:
                roots.append(node)
            else:
                parent["children"].append(node)

    return roots


def get_descendant_category_ids(conn: sqlite3.Connection, category_id: int) -> list[int]:
    rows = conn.execute(
        """
        WITH RECURSIVE tree(id) AS (
            SELECT id FROM categories WHERE id = ?
            UNION ALL
            SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
        )
        SELECT id FROM tree
        """,
        (category_id,),
    ).fetchall()
    return [row["id"] for row in rows]


def save_product(product_id: Optional[int], payload: dict[str, Any]) -> int:
    conn = get_db()
    code = (payload.get("code") or "").strip()
    chinese_name = (payload.get("chinese_name") or payload.get("name") or "").strip()
    effect = (payload.get("effect") or "").strip()
    description = (payload.get("description") or "").strip()
    spray_radius = (payload.get("spray_radius") or "").strip()
    unit_weight = (payload.get("unit_weight") or "").strip()
    package_quantity = (payload.get("package_quantity") or "").strip()
    package_size = (payload.get("package_size") or "").strip()
    gross_weight = (payload.get("gross_weight") or "").strip()
    category_id = payload.get("category_id")

    if not code:
        raise ValueError("产品编码不能为空")
    if not chinese_name:
        raise ValueError("产品中文名不能为空")
    if not effect:
        raise ValueError("产品作用不能为空")
    if not description:
        raise ValueError("产品描述不能为空")
    if not unit_weight:
        raise ValueError("单个重量不能为空")
    if not package_quantity:
        raise ValueError("包装数量不能为空")
    if not package_size:
        raise ValueError("包装尺寸不能为空")
    if not gross_weight:
        raise ValueError("总重量不能为空")

    if category_id in ("", None):
        category_id = None
    else:
        category = conn.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,)).fetchone()
        if category is None:
            raise ValueError("目录不存在")

    now = utc_now()

    if product_id is None:
        cursor = conn.execute(
            """
            INSERT INTO products(
                code, name, chinese_name, effect, category_id, description, spray_radius,
                unit_weight, package_quantity, package_size, gross_weight, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                code,
                chinese_name,
                chinese_name,
                effect,
                category_id,
                description,
                spray_radius,
                unit_weight,
                package_quantity,
                package_size,
                gross_weight,
                now,
                now,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid)

    current = conn.execute("SELECT id FROM products WHERE id = ?", (product_id,)).fetchone()
    if current is None:
        raise LookupError("产品不存在")

    conn.execute(
        """
        UPDATE products
        SET
            code = ?,
            name = ?,
            chinese_name = ?,
            effect = ?,
            category_id = ?,
            description = ?,
            spray_radius = ?,
            unit_weight = ?,
            package_quantity = ?,
            package_size = ?,
            gross_weight = ?,
            updated_at = ?
        WHERE id = ?
        """,
        (
            code,
            chinese_name,
            chinese_name,
            effect,
            category_id,
            description,
            spray_radius,
            unit_weight,
            package_quantity,
            package_size,
            gross_weight,
            now,
            product_id,
        ),
    )
    conn.commit()
    return product_id


def get_or_create_category(conn: sqlite3.Connection, name: str, parent_id: Optional[int]) -> int:
    name = name.strip()
    if not name:
        raise ValueError("目录名称不能为空")

    if parent_id is None:
        row = conn.execute(
            "SELECT id FROM categories WHERE parent_id IS NULL AND name = ?",
            (name,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT id FROM categories WHERE parent_id = ? AND name = ?",
            (parent_id, name),
        ).fetchone()

    if row is not None:
        return int(row["id"])

    cursor = conn.execute(
        "INSERT INTO categories(name, parent_id, created_at) VALUES (?, ?, ?)",
        (name, parent_id, utc_now()),
    )
    return int(cursor.lastrowid)


def parse_product_folder(folder_name: str) -> tuple[str, str]:
    raw = folder_name.strip()
    if not raw:
        return "UNNAMED", "未命名产品"

    pieces = raw.split()
    if pieces and PRODUCT_CODE_PATTERN.match(pieces[0]):
        code = pieces[0]
        name = " ".join(pieces[1:]).strip() or code
        return code, name

    compact = raw.replace(" ", "")
    match = re.match(r"^([A-Za-z]{1,10}\d[\w-]*)(.*)$", compact)
    if match:
        code = match.group(1)
        name = match.group(2).strip() or raw
        return code, name

    synthetic = hashlib.md5(raw.encode("utf-8")).hexdigest()[:10].upper()
    return f"P{synthetic}", raw


def decode_zip_name(name: str) -> str:
    try:
        return name.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name


def insert_product_image(conn: sqlite3.Connection, product_id: int, image_path: str) -> int:
    exists = conn.execute(
        "SELECT id FROM product_images WHERE product_id = ? AND image_path = ?",
        (product_id, image_path),
    ).fetchone()
    if exists is not None:
        return int(exists["id"])

    sort_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM product_images WHERE product_id = ?",
        (product_id,),
    ).fetchone()[0]

    cursor = conn.execute(
        """
        INSERT INTO product_images(product_id, image_path, sort_order, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (product_id, image_path, int(sort_order), utc_now()),
    )
    return int(cursor.lastrowid)


def upsert_product(
    conn: sqlite3.Connection,
    code: str,
    chinese_name: str,
    category_id: Optional[int],
) -> int:
    row = conn.execute("SELECT id FROM products WHERE code = ?", (code,)).fetchone()
    if row is not None:
        product_id = int(row["id"])
        conn.execute(
            """
            UPDATE products
            SET
                name = ?,
                chinese_name = ?,
                category_id = COALESCE(?, category_id),
                updated_at = ?
            WHERE id = ?
            """,
            (chinese_name, chinese_name, category_id, utc_now(), product_id),
        )
        return product_id

    now = utc_now()
    cursor = conn.execute(
        """
        INSERT INTO products(
            code, name, chinese_name, effect, category_id, description, spray_radius,
            unit_weight, package_quantity, package_size, gross_weight, created_at, updated_at
        )
        VALUES (?, ?, ?, '', ?, '', '', '', '', '', '', ?, ?)
        """,
        (code, chinese_name, chinese_name, category_id, now, now),
    )
    return int(cursor.lastrowid)


def import_from_zip(zip_file: Path, reset: bool = False) -> dict[str, Any]:
    conn = get_db()
    conn.execute("BEGIN")

    if reset:
        conn.execute("DELETE FROM product_images")
        conn.execute("DELETE FROM products")
        clear_categories_bottom_up(conn)
        shutil.rmtree(MEDIA_DIR, ignore_errors=True)
        MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    imported_images = 0
    imported_products: set[int] = set()
    imported_categories: set[int] = set()
    skipped_files = 0

    with zipfile.ZipFile(zip_file, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue

            decoded = decode_zip_name(info.filename).replace("\\", "/")
            parts = [part.strip() for part in decoded.split("/") if part.strip()]
            if len(parts) < 3:
                skipped_files += 1
                continue

            file_name = parts[-1]
            if file_name.lower() == "thumbs.db":
                continue

            ext = Path(file_name).suffix.lower()
            if ext not in IMAGE_EXTENSIONS:
                skipped_files += 1
                continue

            category_parts = parts[1:-2]
            product_folder = parts[-2]
            if not category_parts:
                category_parts = ["未分类"]

            parent_id: Optional[int] = None
            for category_name in category_parts:
                parent_id = get_or_create_category(conn, category_name, parent_id)
                imported_categories.add(parent_id)

            code, product_name = parse_product_folder(product_folder)
            product_id = upsert_product(conn, code, product_name, parent_id)
            imported_products.add(product_id)

            digest = hashlib.md5(decoded.encode("utf-8")).hexdigest()
            rel_path = f"{product_id}/{digest}{ext}"
            abs_path = MEDIA_DIR / rel_path

            if not abs_path.exists():
                abs_path.parent.mkdir(parents=True, exist_ok=True)
                data = zf.read(info)
                abs_path.write_bytes(data)

            insert_product_image(conn, product_id, rel_path)
            imported_images += 1

    conn.commit()

    return {
        "ok": True,
        "zip_path": str(zip_file),
        "imported_categories": len(imported_categories),
        "imported_products": len(imported_products),
        "imported_images": imported_images,
        "skipped_files": skipped_files,
        "reset": reset,
    }


def delete_media_file(image_path: str) -> None:
    abs_path = MEDIA_DIR / image_path
    if abs_path.exists() and abs_path.is_file():
        abs_path.unlink(missing_ok=True)


def clear_categories_bottom_up(conn: sqlite3.Connection) -> None:
    while True:
        removed = conn.execute(
            """
            DELETE FROM categories
            WHERE id IN (
                SELECT c.id
                FROM categories c
                LEFT JOIN categories child ON child.parent_id = c.id
                WHERE child.id IS NULL
            )
            """
        ).rowcount
        if removed == 0:
            break


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
