import { Router } from "express";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

// ── GET /api/barbers ─────────────────────────────────────────
// Public — lấy tất cả thợ (kể cả inactive để admin quản lý)
// Query: ?active=true → chỉ lấy thợ đang active (dùng cho booking)
router.get("/", async (req, res) => {
  try {
    const onlyActive = req.query.active === "true";
    const result = await pool.query(
      `SELECT
         b.*,
         -- Kiểm tra có user account chưa
         EXISTS (
           SELECT 1 FROM users u WHERE u.barber_id = b.id AND u.is_active = true
         ) AS has_account,
         -- Username nếu có
         (SELECT u.username FROM users u WHERE u.barber_id = b.id AND u.is_active = true LIMIT 1) AS account_username
       FROM barbers b
       ${onlyActive ? "WHERE b.is_active = true" : ""}
       ORDER BY b.id ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ── POST /api/barbers ────────────────────────────────────────
// Admin only — tạo thợ mới
router.post("/", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }

  const { name, default_commission = 60 } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Thiếu tên thợ" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO barbers (name, default_commission)
       VALUES ($1, $2)
       RETURNING *`,
      [name.trim(), default_commission],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ── PATCH /api/barbers/:id ───────────────────────────────────
// Admin only — sửa thông tin thợ (tên, commission)
router.patch("/:id", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }

  const { name, default_commission } = req.body;

  try {
    const result = await pool.query(
      `UPDATE barbers SET
         name               = COALESCE($1, name),
         default_commission = COALESCE($2, default_commission)
       WHERE id = $3
       RETURNING *`,
      [name?.trim() || null, default_commission ?? null, req.params.id],
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Không tìm thấy thợ" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ── PATCH /api/barbers/:id/toggle ───────────────────────────
// Admin only — toggle is_active (ẩn/hiện thợ)
router.patch("/:id/toggle", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }

  try {
    const result = await pool.query(`UPDATE barbers SET is_active = NOT is_active WHERE id = $1 RETURNING *`, [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: "Không tìm thấy thợ" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
