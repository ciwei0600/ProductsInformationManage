from __future__ import annotations

import hashlib
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from flask import Flask, g, jsonify, render_template, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "pim.db"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
NATURAL_TOKEN_PATTERN = re.compile(r"(\d+(?:\.\d+)?)")


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    init_db()

    @app.route("/")
    def index() -> str:
        return render_template("index.html")

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

        subtree_ids = get_descendant_category_ids(conn, category_id)
        placeholders = ",".join("?" for _ in subtree_ids)

        product_count = conn.execute(
            f"SELECT COUNT(*) FROM products WHERE category_id IN ({placeholders})",
            subtree_ids,
        ).fetchone()[0]
        if product_count > 0:
            return jsonify({"error": "目录下有产品，只有空目录才能删除"}), 400

        if len(subtree_ids) > 1:
            return jsonify({"error": "目录下有子目录，只有空目录才能删除"}), 400

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
        except DuplicateProductCodeError as exc:
            return (
                jsonify(
                    {
                        "error": "产品编码已存在",
                        "conflict": {
                            "id": exc.conflict_id,
                            "code": exc.code,
                            "chinese_name": exc.conflict_name,
                        },
                    }
                ),
                400,
            )
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
        except DuplicateProductCodeError as exc:
            return (
                jsonify(
                    {
                        "error": "产品编码已存在",
                        "conflict": {
                            "id": exc.conflict_id,
                            "code": exc.code,
                            "chinese_name": exc.conflict_name,
                        },
                    }
                ),
                400,
            )
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


class DuplicateProductCodeError(ValueError):
    def __init__(self, code: str, conflict_id: int, conflict_name: str):
        super().__init__("产品编码已存在")
        self.code = code
        self.conflict_id = conflict_id
        self.conflict_name = conflict_name


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

    if category_id in ("", None):
        category_id = None
    else:
        category = conn.execute("SELECT 1 FROM categories WHERE id = ?", (category_id,)).fetchone()
        if category is None:
            raise ValueError("目录不存在")

    duplicate = conn.execute(
        """
        SELECT id, code, COALESCE(NULLIF(chinese_name, ''), name, '') AS chinese_name
        FROM products
        WHERE code = ?
        """,
        (code,),
    ).fetchone()
    if duplicate is not None:
        duplicate_id = int(duplicate["id"])
        if product_id is None or duplicate_id != int(product_id):
            conflict_name = (duplicate["chinese_name"] or "").strip() or "未命名产品"
            raise DuplicateProductCodeError(code, duplicate_id, conflict_name)

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


def delete_media_file(image_path: str) -> None:
    abs_path = MEDIA_DIR / image_path
    if abs_path.exists() and abs_path.is_file():
        abs_path.unlink(missing_ok=True)


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
