from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from PIL import Image, ImageOps, UnidentifiedImageError
from flask import Flask, abort, g, jsonify, render_template, request, send_from_directory

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
MEDIA_DIR = DATA_DIR / "media"
THUMB_DIR = MEDIA_DIR / ".thumbs"
DB_PATH = DATA_DIR / "pim.db"

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
NATURAL_TOKEN_PATTERN = re.compile(r"(\d+(?:\.\d+)?)")
UPLOAD_WEBP_QUALITY = 80
UPLOAD_WEBP_MAX_EDGE = 1800
IMAGE_MIGRATION_THREAD_STARTED = False
IMAGE_MIGRATION_THREAD_LOCK = threading.Lock()


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    init_db()
    start_image_migration_thread()

    @app.route("/")
    def index() -> str:
        return render_template("index.html")

    @app.route("/media/<path:filename>")
    def media(filename: str):
        return send_from_directory(MEDIA_DIR, filename)

    @app.route("/media-thumb/<path:filename>")
    def media_thumb(filename: str):
        size = request.args.get("size", default=160, type=int)
        size = max(32, min(size, 512))
        try:
            thumb_rel_path = ensure_thumbnail(filename, size)
        except FileNotFoundError:
            abort(404)
        return send_from_directory(MEDIA_DIR, thumb_rel_path)

    @app.route("/api/health")
    def health():
        return jsonify({"ok": True, "time": utc_now()})

    @app.route("/api/stats")
    def stats():
        conn = get_db()
        category_count = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
        product_count = conn.execute(
            "SELECT COUNT(*) FROM products WHERE COALESCE(is_deleted, 0) = 0"
        ).fetchone()[0]
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
            f"""
            SELECT COUNT(*)
            FROM products
            WHERE category_id IN ({placeholders}) AND COALESCE(is_deleted, 0) = 0
            """,
            subtree_ids,
        ).fetchone()[0]
        if product_count > 0:
            return jsonify({"error": "目录下有产品，只有空目录才能删除"}), 400

        if len(subtree_ids) > 1:
            return jsonify({"error": "目录下有子目录，只有空目录才能删除"}), 400

        conn.execute("DELETE FROM categories WHERE id = ?", (category_id,))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/boom-categories", methods=["GET"])
    def list_boom_categories():
        conn = get_db()
        rows = conn.execute(
            """
            SELECT id, name, parent_id, created_at
            FROM boom_categories
            ORDER BY COALESCE(parent_id, 0), id
            """
        ).fetchall()
        items = [dict(row) for row in rows]
        tree = build_category_tree(items)
        return jsonify({"items": items, "tree": tree})

    @app.route("/api/boom-categories", methods=["POST"])
    def create_boom_category():
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        parent_id = payload.get("parent_id")

        if not name:
            return jsonify({"error": "目录名称不能为空"}), 400

        conn = get_db()
        if parent_id is not None:
            parent_exists = conn.execute(
                "SELECT 1 FROM boom_categories WHERE id = ?", (parent_id,)
            ).fetchone()
            if parent_exists is None:
                return jsonify({"error": "父级目录不存在"}), 400

        category_id = get_or_create_boom_category(conn, name, parent_id)
        conn.commit()
        return jsonify({"id": category_id, "name": name, "parent_id": parent_id})

    @app.route("/api/boom-categories/<int:category_id>", methods=["PUT"])
    def update_boom_category(category_id: int):
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()

        if not name:
            return jsonify({"error": "目录名称不能为空"}), 400

        conn = get_db()
        current = conn.execute(
            "SELECT id, parent_id FROM boom_categories WHERE id = ?", (category_id,)
        ).fetchone()
        if current is None:
            return jsonify({"error": "目录不存在"}), 404

        parent_id = current["parent_id"]
        if parent_id is None:
            duplicate = conn.execute(
                "SELECT 1 FROM boom_categories WHERE id != ? AND parent_id IS NULL AND name = ?",
                (category_id, name),
            ).fetchone()
        else:
            duplicate = conn.execute(
                "SELECT 1 FROM boom_categories WHERE id != ? AND parent_id = ? AND name = ?",
                (category_id, parent_id, name),
            ).fetchone()

        if duplicate is not None:
            return jsonify({"error": "同级目录下已存在同名目录"}), 400

        conn.execute("UPDATE boom_categories SET name = ? WHERE id = ?", (name, category_id))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/boom-categories/<int:category_id>", methods=["DELETE"])
    def delete_boom_category(category_id: int):
        conn = get_db()
        exists = conn.execute(
            "SELECT 1 FROM boom_categories WHERE id = ?", (category_id,)
        ).fetchone()
        if exists is None:
            return jsonify({"error": "目录不存在"}), 404

        subtree_ids = get_descendant_boom_category_ids(conn, category_id)
        placeholders = ",".join("?" for _ in subtree_ids)

        item_count = conn.execute(
            f"""
            SELECT COUNT(*)
            FROM category_boom_base_items
            WHERE boom_category_id IN ({placeholders})
            """,
            subtree_ids,
        ).fetchone()[0]
        if item_count > 0:
            return jsonify({"error": "目录下有BOOM基础项，只有空目录才能删除"}), 400

        if len(subtree_ids) > 1:
            return jsonify({"error": "目录下有子目录，只有空目录才能删除"}), 400

        conn.execute("DELETE FROM boom_categories WHERE id = ?", (category_id,))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/config-units", methods=["GET"])
    def list_config_units():
        conn = get_db()
        rows = conn.execute(
            """
            SELECT id, name, sort_order, created_at, updated_at
            FROM config_units
            ORDER BY sort_order, id
            """
        ).fetchall()
        return jsonify({"items": [dict(row) for row in rows]})

    @app.route("/api/config-units", methods=["POST"])
    def create_config_unit():
        conn = get_db()
        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        if not name:
            return jsonify({"error": "单位名称不能为空"}), 400

        duplicate = conn.execute("SELECT id FROM config_units WHERE name = ?", (name,)).fetchone()
        if duplicate is not None:
            return jsonify({"error": "单位名称已存在"}), 400

        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM config_units"
        ).fetchone()[0]
        now = utc_now()
        cursor = conn.execute(
            """
            INSERT INTO config_units(name, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (name, int(sort_order), now, now),
        )
        conn.commit()
        return jsonify({"id": int(cursor.lastrowid)})

    @app.route("/api/config-units/<int:unit_id>", methods=["PUT"])
    def update_config_unit(unit_id: int):
        conn = get_db()
        existing = conn.execute("SELECT id, name FROM config_units WHERE id = ?", (unit_id,)).fetchone()
        if existing is None:
            return jsonify({"error": "单位不存在"}), 404

        payload = request.get_json(silent=True) or {}
        name = (payload.get("name") or "").strip()
        if not name:
            return jsonify({"error": "单位名称不能为空"}), 400

        duplicate = conn.execute(
            "SELECT id FROM config_units WHERE id != ? AND name = ?",
            (unit_id, name),
        ).fetchone()
        if duplicate is not None:
            return jsonify({"error": "单位名称已存在"}), 400

        old_name = (existing["name"] or "").strip()
        now = utc_now()
        conn.execute(
            "UPDATE config_units SET name = ?, updated_at = ? WHERE id = ?",
            (name, now, unit_id),
        )
        if old_name and old_name != name:
            conn.execute(
                """
                UPDATE category_boom_base_items
                SET unit = ?, updated_at = ?
                WHERE unit = ?
                """,
                (name, now, old_name),
            )
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/config-units/<int:unit_id>", methods=["DELETE"])
    def delete_config_unit(unit_id: int):
        conn = get_db()
        existing = conn.execute("SELECT id, name FROM config_units WHERE id = ?", (unit_id,)).fetchone()
        if existing is None:
            return jsonify({"error": "单位不存在"}), 404

        unit_name = (existing["name"] or "").strip()
        in_use_count = conn.execute(
            "SELECT COUNT(*) FROM category_boom_base_items WHERE unit = ?",
            (unit_name,),
        ).fetchone()[0]
        if in_use_count > 0:
            return jsonify({"error": "该单位正在被BOOM基础信息使用，无法删除"}), 400

        conn.execute("DELETE FROM config_units WHERE id = ?", (unit_id,))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/products", methods=["GET"])
    def list_products():
        conn = get_db()
        category_id = request.args.get("category_id", type=int)
        keyword = (request.args.get("q") or "").strip()
        page = max(request.args.get("page", default=1, type=int), 1)
        page_size = min(max(request.args.get("page_size", default=20, type=int), 1), 100)

        where_clauses = ["COALESCE(p.is_deleted, 0) = 0"]
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
                p.is_purchased,
                p.purchase_price,
                p.effect,
                p.description,
                p.spray_radius,
                p.unit_weight,
                p.package_quantity,
                p.package_size,
                p.gross_weight,
                p.packaging_machine_name,
                p.packaging_machine_quantity,
                p.packaging_machine_pack_count,
                p.packaging_machine_box_size,
                p.packaging_machine_bag_length,
                p.packaging_machine_amplitude,
                p.packaging_machine_program,
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
                ) AS image_count,
                (
                    SELECT COALESCE(SUM(pbi.quantity * pbi.unit_cost), 0)
                    FROM product_bom_items pbi
                    WHERE pbi.product_id = p.id
                ) AS bom_unit_cost
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            {where_sql}
            ORDER BY
                COALESCE(p.category_id, 0) ASC,
                p.code COLLATE NATURAL_ZH_NUM ASC,
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
                p.is_purchased,
                p.purchase_price,
                p.effect,
                p.description,
                p.spray_radius,
                p.unit_weight,
                p.package_quantity,
                p.package_size,
                p.gross_weight,
                p.packaging_machine_name,
                p.packaging_machine_quantity,
                p.packaging_machine_pack_count,
                p.packaging_machine_box_size,
                p.packaging_machine_bag_length,
                p.packaging_machine_amplitude,
                p.packaging_machine_program,
                p.category_id,
                p.boom_category_id,
                p.created_at,
                p.updated_at,
                c.name AS category_name,
                bc.name AS boom_category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            LEFT JOIN boom_categories bc ON bc.id = p.boom_category_id
            WHERE p.id = ? AND COALESCE(p.is_deleted, 0) = 0
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
        bom_items = conn.execute(
            """
            SELECT
                id,
                product_id,
                base_item_id,
                item_name,
                item_spec,
                unit,
                quantity,
                unit_cost,
                (quantity * unit_cost) AS line_total,
                remark,
                sort_order,
                created_at,
                updated_at
            FROM product_bom_items
            WHERE product_id = ?
            ORDER BY sort_order, id
            """,
            (product_id,),
        ).fetchall()
        specs = conn.execute(
            """
            SELECT
                id,
                product_id,
                spec_name,
                sort_order,
                created_at,
                updated_at
            FROM product_specs
            WHERE product_id = ?
            ORDER BY sort_order, id
            """,
            (product_id,),
        ).fetchall()
        bom_total_cost = conn.execute(
            """
            SELECT COALESCE(SUM(quantity * unit_cost), 0)
            FROM product_bom_items
            WHERE product_id = ?
            """,
            (product_id,),
        ).fetchone()[0]
        return jsonify(
            {
                "product": dict(product),
                "images": [dict(row) for row in images],
                "specs": [dict(row) for row in specs],
                "bom_items": [dict(row) for row in bom_items],
                "bom_total_cost": float(bom_total_cost or 0),
            }
        )

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
        product = conn.execute(
            "SELECT id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        conn.execute(
            "UPDATE products SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ?",
            (utc_now(), utc_now(), product_id),
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/products/<int:product_id>/move-category", methods=["PUT"])
    def move_product_category(product_id: int):
        conn = get_db()
        product = conn.execute(
            "SELECT id, category_id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        payload = request.get_json(silent=True) or {}
        try:
            target_category_id = int(payload.get("category_id"))
        except (TypeError, ValueError):
            return jsonify({"error": "请选择目标目录"}), 400

        category = conn.execute(
            "SELECT id, name FROM categories WHERE id = ?",
            (target_category_id,),
        ).fetchone()
        if category is None:
            return jsonify({"error": "目标目录不存在"}), 400

        current_category_id = product["category_id"]
        if current_category_id is not None and int(current_category_id) == target_category_id:
            return jsonify({"ok": True, "category_id": target_category_id, "unchanged": True})

        now = utc_now()
        conn.execute(
            "UPDATE products SET category_id = ?, updated_at = ? WHERE id = ?",
            (target_category_id, now, product_id),
        )
        conn.commit()
        return jsonify({"ok": True, "category_id": target_category_id, "category_name": category["name"]})

    @app.route("/api/products/<int:product_id>/packaging-machine", methods=["PUT"])
    def update_product_packaging_machine(product_id: int):
        conn = get_db()
        product = conn.execute(
            "SELECT id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        payload = request.get_json(silent=True) or {}
        machine_name = (payload.get("packaging_machine_name") or "").strip()
        machine_quantity = (payload.get("packaging_machine_quantity") or "").strip()
        pack_count = (payload.get("packaging_machine_pack_count") or "").strip()
        box_size = (payload.get("packaging_machine_box_size") or "").strip()
        bag_length = (payload.get("packaging_machine_bag_length") or "").strip()
        amplitude = (payload.get("packaging_machine_amplitude") or "").strip()
        program = (payload.get("packaging_machine_program") or "").strip()

        conn.execute(
            """
            UPDATE products
            SET
                packaging_machine_name = ?,
                packaging_machine_quantity = ?,
                packaging_machine_pack_count = ?,
                packaging_machine_box_size = ?,
                packaging_machine_bag_length = ?,
                packaging_machine_amplitude = ?,
                packaging_machine_program = ?,
                updated_at = ?
            WHERE id = ?
            """,
            (
                machine_name,
                machine_quantity,
                pack_count,
                box_size,
                bag_length,
                amplitude,
                program,
                utc_now(),
                product_id,
            ),
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/recycle-bin/products", methods=["GET"])
    def list_recycle_bin_products():
        conn = get_db()
        rows = conn.execute(
            """
            SELECT
                p.id,
                p.code,
                p.name,
                COALESCE(NULLIF(p.chinese_name, ''), p.name) AS chinese_name,
                p.is_purchased,
                p.purchase_price,
                p.effect,
                p.description,
                p.spray_radius,
                p.unit_weight,
                p.package_quantity,
                p.package_size,
                p.gross_weight,
                p.category_id,
                p.deleted_at,
                p.updated_at,
                c.name AS category_name,
                (
                    SELECT image_path
                    FROM product_images pi
                    WHERE pi.product_id = p.id
                    ORDER BY pi.sort_order, pi.id
                    LIMIT 1
                ) AS first_image
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
            WHERE COALESCE(p.is_deleted, 0) = 1
            ORDER BY
                COALESCE(p.category_id, 0) ASC,
                p.code COLLATE NATURAL_ZH_NUM ASC,
                p.id ASC
            """
        ).fetchall()
        return jsonify({"items": [dict(row) for row in rows]})

    @app.route("/api/recycle-bin/products/<int:product_id>/restore", methods=["POST"])
    def restore_recycle_bin_product(product_id: int):
        conn = get_db()
        product = conn.execute(
            """
            SELECT
                id,
                code,
                category_id,
                COALESCE(NULLIF(chinese_name, ''), name, '') AS chinese_name
            FROM products
            WHERE id = ? AND COALESCE(is_deleted, 0) = 1
            """,
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "回收站中不存在该产品"}), 404

        restore_category_id = product["category_id"]
        if restore_category_id is not None:
            category_exists = conn.execute(
                "SELECT id FROM categories WHERE id = ?", (restore_category_id,)
            ).fetchone()
            if category_exists is None:
                restore_category_id = None

        duplicate = conn.execute(
            """
            SELECT id, COALESCE(NULLIF(chinese_name, ''), name, '') AS chinese_name
            FROM products
            WHERE code = ? AND id != ? AND COALESCE(is_deleted, 0) = 0
            """,
            (product["code"], product_id),
        ).fetchone()
        if duplicate is not None:
            return (
                jsonify(
                    {
                        "error": "恢复失败，产品编码已被占用",
                        "conflict": {
                            "id": int(duplicate["id"]),
                            "code": product["code"],
                            "chinese_name": duplicate["chinese_name"] or "未命名产品",
                        },
                    }
                ),
                400,
            )

        conn.execute(
            """
            UPDATE products
            SET is_deleted = 0, deleted_at = NULL, category_id = ?, updated_at = ?
            WHERE id = ?
            """,
            (restore_category_id, utc_now(), product_id),
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/recycle-bin/products/<int:product_id>", methods=["DELETE"])
    def purge_recycle_bin_product(product_id: int):
        conn = get_db()
        product = conn.execute(
            "SELECT id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 1",
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "回收站中不存在该产品"}), 404

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
        product = conn.execute(
            "SELECT id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
            (product_id,),
        ).fetchone()
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
        rel_path = f"{product_id}/{digest}.webp"
        abs_path = MEDIA_DIR / rel_path
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            save_uploaded_image_as_webp(uploaded, abs_path)
        except (UnidentifiedImageError, OSError, ValueError):
            return jsonify({"error": "图片处理失败，请上传有效图片"}), 400

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

    @app.route("/api/product-images/<int:image_id>/cover", methods=["PUT"])
    def set_product_image_cover(image_id: int):
        conn = get_db()
        row = conn.execute(
            "SELECT id, product_id FROM product_images WHERE id = ?",
            (image_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "图片不存在"}), 404

        set_product_cover_image(conn, int(row["product_id"]), image_id)
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (utc_now(), row["product_id"]))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/products/<int:product_id>/specs", methods=["POST"])
    def create_product_spec(product_id: int):
        conn = get_db()
        product = conn.execute(
            "SELECT id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0", (product_id,)
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404

        payload = request.get_json(silent=True) or {}
        spec_name = (payload.get("spec_name") or "").strip()
        if not spec_name:
            return jsonify({"error": "规格名称不能为空"}), 400

        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM product_specs WHERE product_id = ?",
            (product_id,),
        ).fetchone()[0]
        now = utc_now()
        cursor = conn.execute(
            """
            INSERT INTO product_specs(product_id, spec_name, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (product_id, spec_name, int(sort_order), now, now),
        )
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (now, product_id))
        conn.commit()
        return jsonify({"id": int(cursor.lastrowid)})

    @app.route("/api/product-specs/<int:spec_id>", methods=["PUT"])
    def update_product_spec(spec_id: int):
        conn = get_db()
        existing = conn.execute(
            "SELECT id, product_id FROM product_specs WHERE id = ?", (spec_id,)
        ).fetchone()
        if existing is None:
            return jsonify({"error": "规格不存在"}), 404

        payload = request.get_json(silent=True) or {}
        spec_name = (payload.get("spec_name") or "").strip()
        if not spec_name:
            return jsonify({"error": "规格名称不能为空"}), 400

        now = utc_now()
        conn.execute(
            "UPDATE product_specs SET spec_name = ?, updated_at = ? WHERE id = ?",
            (spec_name, now, spec_id),
        )
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (now, existing["product_id"]))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/product-specs/<int:spec_id>", methods=["DELETE"])
    def delete_product_spec(spec_id: int):
        conn = get_db()
        existing = conn.execute(
            "SELECT id, product_id FROM product_specs WHERE id = ?", (spec_id,)
        ).fetchone()
        if existing is None:
            return jsonify({"error": "规格不存在"}), 404

        now = utc_now()
        conn.execute("DELETE FROM product_specs WHERE id = ?", (spec_id,))
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (now, existing["product_id"]))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/products/<int:product_id>/bom-items", methods=["POST"])
    def create_product_bom_item(product_id: int):
        conn = get_db()
        product = conn.execute(
            "SELECT id, category_id, is_purchased FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
            (product_id,),
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404
        if int(product["is_purchased"] or 0) == 1:
            return jsonify({"error": "采购商品不能维护BOM清单"}), 400

        payload = request.get_json(silent=True) or {}
        try:
            base_item_id = parse_optional_int(payload.get("base_item_id"), "BOOM基础项")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            base_item = resolve_boom_base_item_for_product(conn, product_id, base_item_id)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        item_name = (payload.get("item_name") or "").strip()
        item_spec = (payload.get("item_spec") or "").strip()
        unit = (payload.get("unit") or "").strip()
        remark = (payload.get("remark") or "").strip()

        if base_item is not None:
            if not item_name:
                item_name = (base_item["item_name"] or "").strip()
            if not item_spec:
                item_spec = (base_item["item_spec"] or "").strip()
            if not unit:
                unit = (base_item["unit"] or "").strip()

        if not item_name:
            return jsonify({"error": "BOM项目名称不能为空"}), 400

        raw_unit_cost = payload.get("unit_cost")
        try:
            quantity = float(payload.get("quantity") or 0)
            if raw_unit_cost in (None, "") and base_item is not None:
                unit_cost = float(base_item["default_unit_cost"] or 0)
            else:
                unit_cost = float(raw_unit_cost or 0)
        except (TypeError, ValueError):
            return jsonify({"error": "数量或单价格式不正确"}), 400

        if quantity < 0 or unit_cost < 0:
            return jsonify({"error": "数量和单价不能小于0"}), 400

        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM product_bom_items WHERE product_id = ?",
            (product_id,),
        ).fetchone()[0]

        now = utc_now()
        cursor = conn.execute(
            """
            INSERT INTO product_bom_items(
                product_id, base_item_id, item_name, item_spec, unit, quantity, unit_cost, remark, sort_order,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                product_id,
                base_item_id,
                item_name,
                item_spec,
                unit,
                quantity,
                unit_cost,
                remark,
                int(sort_order),
                now,
                now,
            ),
        )
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (now, product_id))
        conn.commit()
        return jsonify({"id": int(cursor.lastrowid)})

    @app.route("/api/bom-items/<int:bom_item_id>", methods=["PUT"])
    def update_bom_item(bom_item_id: int):
        conn = get_db()
        existing = conn.execute(
            "SELECT id, product_id FROM product_bom_items WHERE id = ?", (bom_item_id,)
        ).fetchone()
        if existing is None:
            return jsonify({"error": "BOM项目不存在"}), 404

        product = conn.execute(
            "SELECT id, is_purchased FROM products WHERE id = ?",
            (int(existing["product_id"]),),
        ).fetchone()
        if product is None:
            return jsonify({"error": "产品不存在"}), 404
        if int(product["is_purchased"] or 0) == 1:
            return jsonify({"error": "采购商品不能维护BOM清单"}), 400

        payload = request.get_json(silent=True) or {}
        try:
            base_item_id = parse_optional_int(payload.get("base_item_id"), "BOOM基础项")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        try:
            base_item = resolve_boom_base_item_for_product(
                conn, int(existing["product_id"]), base_item_id
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        item_name = (payload.get("item_name") or "").strip()
        item_spec = (payload.get("item_spec") or "").strip()
        unit = (payload.get("unit") or "").strip()
        remark = (payload.get("remark") or "").strip()

        if base_item is not None:
            if not item_name:
                item_name = (base_item["item_name"] or "").strip()
            if not item_spec:
                item_spec = (base_item["item_spec"] or "").strip()
            if not unit:
                unit = (base_item["unit"] or "").strip()

        if not item_name:
            return jsonify({"error": "BOM项目名称不能为空"}), 400

        raw_unit_cost = payload.get("unit_cost")
        try:
            quantity = float(payload.get("quantity") or 0)
            if raw_unit_cost in (None, "") and base_item is not None:
                unit_cost = float(base_item["default_unit_cost"] or 0)
            else:
                unit_cost = float(raw_unit_cost or 0)
        except (TypeError, ValueError):
            return jsonify({"error": "数量或单价格式不正确"}), 400

        if quantity < 0 or unit_cost < 0:
            return jsonify({"error": "数量和单价不能小于0"}), 400

        now = utc_now()
        conn.execute(
            """
            UPDATE product_bom_items
            SET base_item_id = ?, item_name = ?, item_spec = ?, unit = ?, quantity = ?, unit_cost = ?, remark = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                base_item_id,
                item_name,
                item_spec,
                unit,
                quantity,
                unit_cost,
                remark,
                now,
                bom_item_id,
            ),
        )
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (now, existing["product_id"]))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/bom-items/<int:bom_item_id>", methods=["DELETE"])
    def delete_bom_item(bom_item_id: int):
        conn = get_db()
        existing = conn.execute(
            "SELECT id, product_id FROM product_bom_items WHERE id = ?", (bom_item_id,)
        ).fetchone()
        if existing is None:
            return jsonify({"error": "BOM项目不存在"}), 404

        now = utc_now()
        conn.execute("DELETE FROM product_bom_items WHERE id = ?", (bom_item_id,))
        conn.execute("UPDATE products SET updated_at = ? WHERE id = ?", (now, existing["product_id"]))
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/category-boom-base-items", methods=["GET"])
    def list_category_boom_base_items():
        conn = get_db()
        boom_category_id = request.args.get("boom_category_id", type=int) or request.args.get(
            "category_id", type=int
        )
        if not boom_category_id:
            return jsonify({"items": []})

        rows = conn.execute(
            """
            SELECT
                cbi.id,
                cbi.boom_category_id,
                bc.name AS boom_category_name,
                cbi.item_name,
                cbi.unit,
                cbi.default_unit_cost,
                cbi.remark AS description,
                cbi.sort_order,
                cbi.created_at,
                cbi.updated_at
            FROM category_boom_base_items cbi
            LEFT JOIN boom_categories bc ON bc.id = cbi.boom_category_id
            WHERE cbi.boom_category_id = ?
            ORDER BY cbi.sort_order, cbi.id
            """,
            (boom_category_id,),
        ).fetchall()
        return jsonify({"items": [dict(row) for row in rows]})

    @app.route("/api/category-boom-base-items", methods=["POST"])
    def create_category_boom_base_item():
        conn = get_db()
        payload = request.get_json(silent=True) or {}
        try:
            boom_category_id = int(payload.get("boom_category_id") or payload.get("category_id"))
        except (TypeError, ValueError):
            return jsonify({"error": "请选择BOOM目录"}), 400

        category = conn.execute(
            "SELECT id FROM boom_categories WHERE id = ?", (boom_category_id,)
        ).fetchone()
        if category is None:
            return jsonify({"error": "BOOM目录不存在"}), 400

        item_name = (payload.get("item_name") or "").strip()
        unit = (payload.get("unit") or "").strip()
        description = (payload.get("description") or payload.get("remark") or "").strip()
        if not item_name:
            return jsonify({"error": "项目名称不能为空"}), 400
        if unit:
            unit_row = conn.execute("SELECT id FROM config_units WHERE name = ?", (unit,)).fetchone()
            if unit_row is None:
                return jsonify({"error": "请选择配置页面中已存在的单位"}), 400

        try:
            default_unit_cost = float(payload.get("default_unit_cost") or 0)
        except (TypeError, ValueError):
            return jsonify({"error": "默认单价格式不正确"}), 400
        if default_unit_cost < 0:
            return jsonify({"error": "默认单价不能小于0"}), 400

        duplicate = conn.execute(
            """
            SELECT id
            FROM category_boom_base_items
            WHERE boom_category_id = ? AND item_name = ? AND unit = ?
            """,
            (boom_category_id, item_name, unit),
        ).fetchone()
        if duplicate is not None:
            return jsonify({"error": "当前BOOM目录已存在同名基础项"}), 400

        sort_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM category_boom_base_items WHERE boom_category_id = ?",
            (boom_category_id,),
        ).fetchone()[0]
        now = utc_now()
        cursor = conn.execute(
            """
            INSERT INTO category_boom_base_items(
                boom_category_id, item_name, item_spec, unit, default_unit_cost, remark, sort_order, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                boom_category_id,
                item_name,
                "",
                unit,
                default_unit_cost,
                description,
                int(sort_order),
                now,
                now,
            ),
        )
        conn.commit()
        return jsonify({"id": int(cursor.lastrowid)})

    @app.route("/api/category-boom-base-items/<int:base_item_id>", methods=["PUT"])
    def update_category_boom_base_item(base_item_id: int):
        conn = get_db()
        existing = conn.execute(
            "SELECT id, boom_category_id FROM category_boom_base_items WHERE id = ?",
            (base_item_id,),
        ).fetchone()
        if existing is None:
            return jsonify({"error": "BOOM基础项不存在"}), 404

        payload = request.get_json(silent=True) or {}
        item_name = (payload.get("item_name") or "").strip()
        unit = (payload.get("unit") or "").strip()
        description = (payload.get("description") or payload.get("remark") or "").strip()
        if not item_name:
            return jsonify({"error": "项目名称不能为空"}), 400
        if unit:
            unit_row = conn.execute("SELECT id FROM config_units WHERE name = ?", (unit,)).fetchone()
            if unit_row is None:
                return jsonify({"error": "请选择配置页面中已存在的单位"}), 400

        try:
            default_unit_cost = float(payload.get("default_unit_cost") or 0)
        except (TypeError, ValueError):
            return jsonify({"error": "默认单价格式不正确"}), 400
        if default_unit_cost < 0:
            return jsonify({"error": "默认单价不能小于0"}), 400

        boom_category_id = int(existing["boom_category_id"])
        duplicate = conn.execute(
            """
            SELECT id
            FROM category_boom_base_items
            WHERE id != ? AND boom_category_id = ? AND item_name = ? AND unit = ?
            """,
            (base_item_id, boom_category_id, item_name, unit),
        ).fetchone()
        if duplicate is not None:
            return jsonify({"error": "当前BOOM目录已存在同名基础项"}), 400

        now = utc_now()
        conn.execute(
            """
            UPDATE category_boom_base_items
            SET item_name = ?, item_spec = ?, unit = ?, default_unit_cost = ?, remark = ?, updated_at = ?
            WHERE id = ?
            """,
            (item_name, "", unit, default_unit_cost, description, now, base_item_id),
        )
        conn.commit()
        return jsonify({"ok": True})

    @app.route("/api/category-boom-base-items/<int:base_item_id>", methods=["DELETE"])
    def delete_category_boom_base_item(base_item_id: int):
        conn = get_db()
        existing = conn.execute(
            "SELECT id FROM category_boom_base_items WHERE id = ?",
            (base_item_id,),
        ).fetchone()
        if existing is None:
            return jsonify({"error": "BOOM基础项不存在"}), 404

        conn.execute("DELETE FROM category_boom_base_items WHERE id = ?", (base_item_id,))
        conn.commit()
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

        CREATE TABLE IF NOT EXISTS boom_categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            parent_id INTEGER REFERENCES boom_categories(id) ON DELETE RESTRICT,
            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_boom_categories_name_parent
        ON boom_categories(name, COALESCE(parent_id, -1));

        CREATE TABLE IF NOT EXISTS config_units (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_config_units_order
        ON config_units(sort_order, id);

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '',
            chinese_name TEXT NOT NULL DEFAULT '',
            is_purchased INTEGER NOT NULL DEFAULT 0,
            purchase_price REAL NOT NULL DEFAULT 0,
            effect TEXT NOT NULL DEFAULT '',
            category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
            description TEXT NOT NULL DEFAULT '',
            spray_radius TEXT NOT NULL DEFAULT '',
            unit_weight TEXT NOT NULL DEFAULT '',
            package_quantity TEXT NOT NULL DEFAULT '',
            package_size TEXT NOT NULL DEFAULT '',
            gross_weight TEXT NOT NULL DEFAULT '',
            packaging_machine_name TEXT NOT NULL DEFAULT '',
            packaging_machine_quantity TEXT NOT NULL DEFAULT '',
            packaging_machine_pack_count TEXT NOT NULL DEFAULT '',
            packaging_machine_box_size TEXT NOT NULL DEFAULT '',
            packaging_machine_bag_length TEXT NOT NULL DEFAULT '',
            packaging_machine_amplitude TEXT NOT NULL DEFAULT '',
            packaging_machine_program TEXT NOT NULL DEFAULT '',
            is_deleted INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT,
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

        CREATE TABLE IF NOT EXISTS product_specs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            spec_name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_product_specs_product_order
        ON product_specs(product_id, sort_order, id);

        CREATE TABLE IF NOT EXISTS category_boom_base_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            boom_category_id INTEGER NOT NULL REFERENCES boom_categories(id) ON DELETE CASCADE,
            item_name TEXT NOT NULL,
            item_spec TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL DEFAULT '',
            default_unit_cost REAL NOT NULL DEFAULT 0,
            remark TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS product_bom_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            base_item_id INTEGER REFERENCES category_boom_base_items(id) ON DELETE SET NULL,
            item_name TEXT NOT NULL,
            item_spec TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL DEFAULT '',
            quantity REAL NOT NULL DEFAULT 0,
            unit_cost REAL NOT NULL DEFAULT 0,
            remark TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_product_bom_items_product_order
        ON product_bom_items(product_id, sort_order, id);

        """
    )
    ensure_product_columns(conn)
    migrate_boom_tables_if_needed(conn)
    ensure_product_bom_columns(conn)
    ensure_boom_base_columns(conn)
    backfill_config_units_from_boom_base(conn)
    seed_boom_categories_from_product_categories(conn)
    backfill_boom_base_categories(conn)
    backfill_product_boom_categories(conn)
    conn.commit()
    conn.close()


def ensure_product_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(products)").fetchall()
    }
    required_columns = {
        "name": "TEXT NOT NULL DEFAULT ''",
        "chinese_name": "TEXT NOT NULL DEFAULT ''",
        "is_purchased": "INTEGER NOT NULL DEFAULT 0",
        "purchase_price": "REAL NOT NULL DEFAULT 0",
        "effect": "TEXT NOT NULL DEFAULT ''",
        "spray_radius": "TEXT NOT NULL DEFAULT ''",
        "unit_weight": "TEXT NOT NULL DEFAULT ''",
        "package_quantity": "TEXT NOT NULL DEFAULT ''",
        "package_size": "TEXT NOT NULL DEFAULT ''",
        "gross_weight": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_name": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_quantity": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_pack_count": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_box_size": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_bag_length": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_amplitude": "TEXT NOT NULL DEFAULT ''",
        "packaging_machine_program": "TEXT NOT NULL DEFAULT ''",
        "boom_category_id": "INTEGER REFERENCES boom_categories(id) ON DELETE SET NULL",
        "is_deleted": "INTEGER NOT NULL DEFAULT 0",
        "deleted_at": "TEXT",
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
    conn.execute(
        """
        UPDATE products
        SET purchase_price = 0
        WHERE purchase_price IS NULL
        """
    )


def migrate_boom_tables_if_needed(conn: sqlite3.Connection) -> None:
    boom_columns = conn.execute("PRAGMA table_info(category_boom_base_items)").fetchall()
    boom_column_names = {row[1] for row in boom_columns}
    legacy_boom_schema = "category_id" in boom_column_names

    if not legacy_boom_schema:
        return

    base_item_expr = "COALESCE(boom_category_id, category_id)" if "boom_category_id" in boom_column_names else "category_id"

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE product_bom_items RENAME TO product_bom_items_legacy")
    conn.execute("ALTER TABLE category_boom_base_items RENAME TO category_boom_base_items_legacy")
    conn.executescript(
        """
        CREATE TABLE category_boom_base_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            boom_category_id INTEGER NOT NULL REFERENCES boom_categories(id) ON DELETE CASCADE,
            item_name TEXT NOT NULL,
            item_spec TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL DEFAULT '',
            default_unit_cost REAL NOT NULL DEFAULT 0,
            remark TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE product_bom_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
            base_item_id INTEGER REFERENCES category_boom_base_items(id) ON DELETE SET NULL,
            item_name TEXT NOT NULL,
            item_spec TEXT NOT NULL DEFAULT '',
            unit TEXT NOT NULL DEFAULT '',
            quantity REAL NOT NULL DEFAULT 0,
            unit_cost REAL NOT NULL DEFAULT 0,
            remark TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        f"""
        INSERT INTO category_boom_base_items(
            id, boom_category_id, item_name, item_spec, unit, default_unit_cost, remark, sort_order, created_at, updated_at
        )
        SELECT
            id,
            {base_item_expr},
            item_name,
            item_spec,
            unit,
            default_unit_cost,
            remark,
            sort_order,
            created_at,
            updated_at
        FROM category_boom_base_items_legacy
        """,
    )
    conn.execute(
        """
        INSERT INTO product_bom_items(
            id, product_id, base_item_id, item_name, item_spec, unit, quantity, unit_cost, remark, sort_order,
            created_at, updated_at
        )
        SELECT
            id, product_id, base_item_id, item_name, item_spec, unit, quantity, unit_cost, remark, sort_order,
            created_at, updated_at
        FROM product_bom_items_legacy
        """
    )
    conn.executescript(
        """
        DROP TABLE category_boom_base_items_legacy;
        DROP TABLE product_bom_items_legacy;
        """
    )
    conn.execute("PRAGMA foreign_keys = ON")


def ensure_product_bom_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(product_bom_items)").fetchall()
    }
    if "base_item_id" not in existing_columns:
        conn.execute(
            """
            ALTER TABLE product_bom_items
            ADD COLUMN base_item_id INTEGER REFERENCES category_boom_base_items(id) ON DELETE SET NULL
            """
        )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_product_bom_items_base_item
        ON product_bom_items(base_item_id)
        """
    )


def ensure_boom_base_columns(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(category_boom_base_items)").fetchall()
    }
    if "boom_category_id" not in existing_columns:
        conn.execute(
            """
            ALTER TABLE category_boom_base_items
            ADD COLUMN boom_category_id INTEGER REFERENCES boom_categories(id) ON DELETE CASCADE
            """
        )

    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_category_boom_base_items_boom_category_order
        ON category_boom_base_items(boom_category_id, sort_order, id)
        """
    )


def backfill_config_units_from_boom_base(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT DISTINCT TRIM(COALESCE(unit, '')) AS unit_name
        FROM category_boom_base_items
        WHERE TRIM(COALESCE(unit, '')) != ''
        ORDER BY unit_name
        """
    ).fetchall()
    if not rows:
        return

    existing = {(row[0] or "").strip() for row in conn.execute("SELECT name FROM config_units").fetchall()}
    next_sort_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM config_units"
    ).fetchone()[0]
    now = utc_now()
    for row in rows:
        unit_name = (row[0] or "").strip()
        if not unit_name or unit_name in existing:
            continue
        conn.execute(
            """
            INSERT INTO config_units(name, sort_order, created_at, updated_at)
            VALUES (?, ?, ?, ?)
            """,
            (unit_name, int(next_sort_order), now, now),
        )
        existing.add(unit_name)
        next_sort_order += 1


def seed_boom_categories_from_product_categories(conn: sqlite3.Connection) -> None:
    boom_count = conn.execute("SELECT COUNT(*) FROM boom_categories").fetchone()[0]
    if boom_count:
        return

    rows = conn.execute(
        "SELECT id, name, parent_id, created_at FROM categories ORDER BY COALESCE(parent_id, 0), id"
    ).fetchall()
    for row in rows:
        conn.execute(
            """
            INSERT INTO boom_categories(id, name, parent_id, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (
                row[0],
                row[1],
                row[2],
                row[3] or utc_now(),
            ),
        )


def backfill_product_boom_categories(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        UPDATE products
        SET boom_category_id = category_id
        WHERE boom_category_id IS NULL
          AND COALESCE(is_purchased, 0) = 0
          AND category_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM boom_categories bc WHERE bc.id = products.category_id)
        """
    )


def backfill_boom_base_categories(conn: sqlite3.Connection) -> None:
    existing_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(category_boom_base_items)").fetchall()
    }
    if "category_id" not in existing_columns:
        return

    conn.execute(
        """
        UPDATE category_boom_base_items
        SET boom_category_id = category_id
        WHERE boom_category_id IS NULL
          AND category_id IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM boom_categories bc WHERE bc.id = category_boom_base_items.category_id
          )
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


def get_descendant_boom_category_ids(conn: sqlite3.Connection, category_id: int) -> list[int]:
    rows = conn.execute(
        """
        WITH RECURSIVE tree(id) AS (
            SELECT id FROM boom_categories WHERE id = ?
            UNION ALL
            SELECT c.id FROM boom_categories c JOIN tree t ON c.parent_id = t.id
        )
        SELECT id FROM tree
        """,
        (category_id,),
    ).fetchall()
    return [row["id"] for row in rows]


def parse_optional_int(value: Any, field_name: str) -> Optional[int]:
    if value in ("", None):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name}格式不正确") from exc
    if parsed <= 0:
        raise ValueError(f"{field_name}格式不正确")
    return parsed


def resolve_boom_base_item_for_product(
    conn: sqlite3.Connection, product_id: int, base_item_id: Optional[int]
) -> Optional[sqlite3.Row]:
    if base_item_id is None:
        return None

    product = conn.execute(
        "SELECT id, boom_category_id, is_purchased FROM products WHERE id = ?",
        (product_id,),
    ).fetchone()
    if product is None:
        raise ValueError("产品不存在")
    if int(product["is_purchased"] or 0) == 1:
        raise ValueError("采购商品不能维护BOOM基础项")

    product_boom_category_id = product["boom_category_id"]
    if product_boom_category_id is None:
        raise ValueError("产品未设置BOOM目录，不能选择BOOM基础项")

    base_item = conn.execute(
        """
        SELECT id, boom_category_id, item_name, item_spec, unit, default_unit_cost
        FROM category_boom_base_items
        WHERE id = ?
        """,
        (base_item_id,),
    ).fetchone()
    if base_item is None:
        raise ValueError("BOOM基础项不存在")

    if base_item["boom_category_id"] is None:
        raise ValueError("BOOM基础项未设置目录")

    if int(base_item["boom_category_id"]) != int(product_boom_category_id):
        raise ValueError("只能选择同BOOM目录下的BOOM基础项")

    return base_item


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
    is_purchased = 1 if payload.get("is_purchased") in (True, 1, "1", "true", "True", "on") else 0
    effect = (payload.get("effect") or "").strip()
    description = (payload.get("description") or "").strip()
    spray_radius = (payload.get("spray_radius") or "").strip()
    unit_weight = (payload.get("unit_weight") or "").strip()
    package_quantity = (payload.get("package_quantity") or "").strip()
    package_size = (payload.get("package_size") or "").strip()
    gross_weight = (payload.get("gross_weight") or "").strip()
    category_id = payload.get("category_id")
    boom_category_id = payload.get("boom_category_id")
    try:
        purchase_price = float(payload.get("purchase_price") or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("采购价格格式不正确") from exc
    if purchase_price < 0:
        raise ValueError("采购价格不能小于0")

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

    if boom_category_id in ("", None):
        boom_category_id = None
    else:
        boom_category = conn.execute(
            "SELECT 1 FROM boom_categories WHERE id = ?", (boom_category_id,)
        ).fetchone()
        if boom_category is None:
            raise ValueError("BOOM目录不存在")
    if is_purchased:
        boom_category_id = None

    duplicate = conn.execute(
        """
        SELECT id, code, COALESCE(NULLIF(chinese_name, ''), name, '') AS chinese_name
        FROM products
        WHERE code = ? AND COALESCE(is_deleted, 0) = 0
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
                code, name, chinese_name, is_purchased, purchase_price, effect, category_id, boom_category_id, description, spray_radius,
                unit_weight, package_quantity, package_size, gross_weight, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                code,
                chinese_name,
                chinese_name,
                is_purchased,
                purchase_price,
                effect,
                category_id,
                boom_category_id,
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

    current = conn.execute(
        "SELECT id FROM products WHERE id = ? AND COALESCE(is_deleted, 0) = 0",
        (product_id,),
    ).fetchone()
    if current is None:
        raise LookupError("产品不存在")

    conn.execute(
        """
        UPDATE products
        SET
            code = ?,
            name = ?,
            chinese_name = ?,
            is_purchased = ?,
            purchase_price = ?,
            effect = ?,
            category_id = ?,
            boom_category_id = ?,
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
            is_purchased,
            purchase_price,
            effect,
            category_id,
            boom_category_id,
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


def get_or_create_boom_category(
    conn: sqlite3.Connection, name: str, parent_id: Optional[int]
) -> int:
    name = name.strip()
    if not name:
        raise ValueError("目录名称不能为空")

    if parent_id is None:
        row = conn.execute(
            "SELECT id FROM boom_categories WHERE parent_id IS NULL AND name = ?",
            (name,),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT id FROM boom_categories WHERE parent_id = ? AND name = ?",
            (parent_id, name),
        ).fetchone()

    if row is not None:
        return int(row["id"])

    cursor = conn.execute(
        "INSERT INTO boom_categories(name, parent_id, created_at) VALUES (?, ?, ?)",
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


def set_product_cover_image(conn: sqlite3.Connection, product_id: int, image_id: int) -> None:
    rows = conn.execute(
        """
        SELECT id
        FROM product_images
        WHERE product_id = ?
        ORDER BY
            CASE WHEN id = ? THEN 0 ELSE 1 END,
            sort_order ASC,
            id ASC
        """,
        (product_id, image_id),
    ).fetchall()
    if not rows:
        return

    for index, row in enumerate(rows):
        conn.execute(
            "UPDATE product_images SET sort_order = ? WHERE id = ?",
            (index, int(row["id"])),
        )


def save_uploaded_image_as_webp(uploaded_file, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        uploaded_file.stream.seek(0)
        with Image.open(uploaded_file.stream) as image:
            save_image_as_webp(image, destination)
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def save_image_as_webp(image: Image.Image, destination: Path) -> None:
    image = ImageOps.exif_transpose(image)
    if image.mode == "P":
        image = image.convert("RGBA")
    elif image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")

    image.thumbnail((UPLOAD_WEBP_MAX_EDGE, UPLOAD_WEBP_MAX_EDGE), Image.Resampling.LANCZOS)
    image.save(
        destination,
        format="WEBP",
        quality=UPLOAD_WEBP_QUALITY,
        method=6,
        optimize=True,
    )


def build_webp_image_path(image_path: str, image_id: int, has_conflict: bool = False) -> str:
    original = Path(image_path)
    if has_conflict:
        return str(original.with_name(f"{original.stem}-{image_id}.webp"))
    return str(original.with_suffix(".webp"))


def migrate_existing_product_images_to_webp(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        """
        SELECT id, product_id, image_path
        FROM product_images
        WHERE lower(image_path) NOT LIKE '%.webp'
        ORDER BY id
        """
    ).fetchall()
    if not rows:
        return

    changed_product_ids: set[int] = set()
    for row in rows:
        image_id = int(row[0])
        product_id = int(row[1])
        image_path = str(row[2] or "").strip()
        if not image_path:
            continue

        source_path = MEDIA_DIR / image_path
        if not source_path.exists() or not source_path.is_file():
            continue

        target_rel_path = build_webp_image_path(image_path, image_id)
        conflict = conn.execute(
            "SELECT id FROM product_images WHERE product_id = ? AND image_path = ? AND id != ?",
            (product_id, target_rel_path, image_id),
        ).fetchone()
        if conflict is not None:
            target_rel_path = build_webp_image_path(image_path, image_id, has_conflict=True)

        target_abs_path = MEDIA_DIR / target_rel_path
        if not target_abs_path.exists():
            target_abs_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                with Image.open(source_path) as image:
                    save_image_as_webp(image, target_abs_path)
            except (UnidentifiedImageError, OSError):
                target_abs_path.unlink(missing_ok=True)
                continue

        conn.execute(
            "UPDATE product_images SET image_path = ? WHERE id = ?",
            (target_rel_path, image_id),
        )
        changed_product_ids.add(product_id)

    if changed_product_ids:
        now = utc_now()
        conn.executemany(
            "UPDATE products SET updated_at = ? WHERE id = ?",
            [(now, product_id) for product_id in changed_product_ids],
        )


def run_image_migration_job() -> None:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        migrate_existing_product_images_to_webp(conn)
        conn.commit()
    except Exception as exc:
        conn.rollback()
        print(f"[image-migration] failed: {exc}")
    finally:
        conn.close()


def start_image_migration_thread() -> None:
    global IMAGE_MIGRATION_THREAD_STARTED
    with IMAGE_MIGRATION_THREAD_LOCK:
        if IMAGE_MIGRATION_THREAD_STARTED:
            return
        IMAGE_MIGRATION_THREAD_STARTED = True
        thread = threading.Thread(
            target=run_image_migration_job,
            name="product-image-webp-migration",
            daemon=True,
        )
        thread.start()


def delete_media_file(image_path: str) -> None:
    abs_path = MEDIA_DIR / image_path
    if abs_path.exists() and abs_path.is_file():
        abs_path.unlink(missing_ok=True)
    delete_thumbnail_cache(image_path)


def thumbnail_relative_path(image_path: str, size: int) -> Path:
    original = Path(image_path)
    return Path(".thumbs") / str(size) / original.parent / f"{original.name}.jpg"


def ensure_thumbnail(image_path: str, size: int) -> str:
    source_path = MEDIA_DIR / image_path
    if not source_path.exists() or not source_path.is_file():
        raise FileNotFoundError(image_path)

    thumb_rel_path = thumbnail_relative_path(image_path, size)
    thumb_abs_path = MEDIA_DIR / thumb_rel_path
    thumb_abs_path.parent.mkdir(parents=True, exist_ok=True)

    source_mtime = source_path.stat().st_mtime
    thumb_mtime = thumb_abs_path.stat().st_mtime if thumb_abs_path.exists() else -1
    if thumb_abs_path.exists() and thumb_mtime >= source_mtime:
        return str(thumb_rel_path)

    try:
        with Image.open(source_path) as image:
            image = ImageOps.exif_transpose(image)
            if image.mode not in ("RGB", "L"):
                background = Image.new("RGB", image.size, "#ffffff")
                alpha_source = image.convert("RGBA")
                background.paste(alpha_source, mask=alpha_source.getchannel("A"))
                image = background
            elif image.mode == "L":
                image = image.convert("RGB")

            image.thumbnail((size, size))
            image.save(thumb_abs_path, format="JPEG", quality=82, optimize=True)
    except (UnidentifiedImageError, OSError):
        # Fallback to original file if thumbnail generation fails.
        return image_path

    return str(thumb_rel_path)


def delete_thumbnail_cache(image_path: str) -> None:
    if not THUMB_DIR.exists():
        return
    original = Path(image_path)
    for size_dir in THUMB_DIR.iterdir():
        if not size_dir.is_dir():
            continue
        cached = size_dir / original.parent / f"{original.name}.jpg"
        if cached.exists() and cached.is_file():
            cached.unlink(missing_ok=True)


app = create_app()


if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
