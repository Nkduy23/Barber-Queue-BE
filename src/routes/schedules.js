import { Router } from "express";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

function todayVN() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

// ══════════════════════════════════════════════════════════════
// GET /api/schedules?date=YYYY-MM-DD
// Public — FE dùng để biết thợ nào đang làm hôm nay
// ══════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const date = req.query.date || todayVN();
  try {
    // Lấy tất cả thợ active, kèm trạng thái làm việc ngày đó
    // Nếu không có row trong barber_schedules → mặc định is_working = true
    const result = await pool.query(
      `SELECT
         b.id,
         b.name,
         b.is_active,
         b.default_commission,
         COALESCE(bs.is_working, true)  AS is_working,
         COALESCE(bs.note, '')          AS schedule_note
       FROM barbers b
       LEFT JOIN barber_schedules bs
         ON bs.barber_id = b.id AND bs.work_date = $1
       WHERE b.is_active = true
       ORDER BY b.id ASC`,
      [date],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/schedules/range?from=YYYY-MM-DD&to=YYYY-MM-DD
// Admin — xem lịch tổng quan nhiều ngày
// ══════════════════════════════════════════════════════════════
router.get("/range", authMiddleware, async (req, res) => {
  const from = req.query.from || todayVN();
  const to = req.query.to || todayVN();
  try {
    const result = await pool.query(
      `SELECT
         b.id AS barber_id,
         b.name,
         bs.work_date,
         COALESCE(bs.is_working, true) AS is_working,
         COALESCE(bs.note, '')         AS note
       FROM barbers b
       CROSS JOIN generate_series($1::date, $2::date, '1 day') AS gs(work_date)
       LEFT JOIN barber_schedules bs
         ON bs.barber_id = b.id AND bs.work_date = gs.work_date
       WHERE b.is_active = true
       ORDER BY gs.work_date ASC, b.id ASC`,
      [from, to],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/schedules
// Admin — cập nhật trạng thái làm việc của thợ ngày cụ thể
// Body: { barber_id, work_date, is_working, note }
// ══════════════════════════════════════════════════════════════
router.patch("/", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Chỉ admin mới có quyền" });
  }

  const { barber_id, work_date, is_working, note = "" } = req.body;
  if (!barber_id || !work_date) {
    return res.status(400).json({ error: "Thiếu barber_id hoặc work_date" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO barber_schedules (barber_id, work_date, is_working, note, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (barber_id, work_date) DO UPDATE SET
         is_working = EXCLUDED.is_working,
         note       = EXCLUDED.note,
         updated_at = now()
       RETURNING *`,
      [barber_id, work_date, is_working ?? true, note],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/schedules/bulk
// Admin — cập nhật nhiều thợ cùng lúc (VD: cả tiệm nghỉ Tết)
// Body: { work_date, barber_ids: [1,2], is_working, note }
// ══════════════════════════════════════════════════════════════
router.patch("/bulk", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Chỉ admin mới có quyền" });
  }

  const { work_date, barber_ids = [], is_working, note = "" } = req.body;
  if (!work_date || !barber_ids.length) {
    return res.status(400).json({ error: "Thiếu work_date hoặc barber_ids" });
  }

  try {
    const rows = [];
    for (const bid of barber_ids) {
      const r = await pool.query(
        `INSERT INTO barber_schedules (barber_id, work_date, is_working, note, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (barber_id, work_date) DO UPDATE SET
           is_working = EXCLUDED.is_working,
           note       = EXCLUDED.note,
           updated_at = now()
         RETURNING *`,
        [bid, work_date, is_working ?? true, note],
      );
      rows.push(r.rows[0]);
    }
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
