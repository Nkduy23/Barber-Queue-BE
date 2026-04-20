import { Router } from "express";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

// GET /api/services — public, FE dùng để render danh sách dịch vụ
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM services WHERE is_active = true ORDER BY sort_order ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// PATCH /api/services/:id — admin toggle active / update
router.patch("/:id", authMiddleware, async (req, res) => {
  const { name, duration, price, description, is_active, sort_order } = req.body;
  try {
    const result = await pool.query(
      `UPDATE services SET
        name        = COALESCE($1, name),
        duration    = COALESCE($2, duration),
        price       = COALESCE($3, price),
        description = COALESCE($4, description),
        is_active   = COALESCE($5, is_active),
        sort_order  = COALESCE($6, sort_order)
       WHERE id = $7 RETURNING *`,
      [name, duration, price, description, is_active, sort_order, req.params.id],
    );
    if (!result.rows.length) return res.status(404).json({ error: "Không tìm thấy" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
