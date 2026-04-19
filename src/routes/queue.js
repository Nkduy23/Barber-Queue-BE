import { Router } from "express";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const AVG_SERVICE_TIME = 25;

// Helper: so sánh ngày theo timezone VN thay vì UTC
const VN_DATE_FILTER = `DATE(created_at AT TIME ZONE 'Asia/Ho_Chi_Minh') = (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

export default function queueRoutes(io) {
  const router = Router();

  async function broadcastQueue() {
    const result = await pool.query(
      `SELECT * FROM queues
       WHERE status IN ('waiting', 'serving')
       ORDER BY position ASC`,
    );
    io.emit("queue_updated", result.rows);
  }

  // ── GET /api/queue ────────────────────────────────────────
  router.get("/", async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT * FROM queues
         WHERE status IN ('waiting', 'serving')
         ORDER BY position ASC`,
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ── GET /api/queue/stats ──────────────────────────────────
  router.get("/stats", async (_req, res) => {
    try {
      const waiting = await pool.query(`SELECT COUNT(*) FROM queues WHERE status = 'waiting'`);
      const serving = await pool.query(`SELECT * FROM queues WHERE status = 'serving' LIMIT 1`);
      res.json({
        waitingCount: parseInt(waiting.rows[0].count),
        currentServing: serving.rows[0] || null,
        estimatedWaitMinutes: parseInt(waiting.rows[0].count) * AVG_SERVICE_TIME,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ── POST /api/queue ───────────────────────────────────────
  router.post("/", async (req, res) => {
    const { name, phone } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: "Thiếu tên hoặc số điện thoại" });
    }

    try {
      // Anti-cheat: chặn trùng SĐT trong ngày — dùng VN timezone
      const duplicate = await pool.query(
        `SELECT id FROM queues
         WHERE phone = $1
           AND status IN ('waiting', 'serving')
           AND ${VN_DATE_FILTER}`,
        [phone],
      );
      if (duplicate.rows.length > 0) {
        return res.status(409).json({
          error: "Số điện thoại này đã có trong hàng chờ hôm nay",
        });
      }

      // Position tiếp theo — tính trong ngày VN
      const posResult = await pool.query(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
         FROM queues
         WHERE ${VN_DATE_FILTER}`,
      );
      const position = posResult.rows[0].next_pos;

      const waitingResult = await pool.query(`SELECT COUNT(*) FROM queues WHERE status = 'waiting'`);
      const waitingCount = parseInt(waitingResult.rows[0].count);

      const result = await pool.query(
        `INSERT INTO queues (name, phone, status, position)
         VALUES ($1, $2, 'waiting', $3)
         RETURNING *`,
        [name, phone, position],
      );

      const newEntry = {
        ...result.rows[0],
        estimatedWaitMinutes: waitingCount * AVG_SERVICE_TIME,
        peopleAhead: waitingCount,
      };

      await broadcastQueue();
      res.status(201).json(newEntry);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ── PATCH /api/queue/next ─────────────────────────────────
  router.patch("/next", authMiddleware, async (_req, res) => {
    try {
      await pool.query(
        `UPDATE queues SET status = 'done', end_time = NOW()
         WHERE status = 'serving'`,
      );

      const result = await pool.query(
        `UPDATE queues
         SET status = 'serving', start_time = NOW()
         WHERE id = (
           SELECT id FROM queues
           WHERE status = 'waiting'
           ORDER BY position ASC
           LIMIT 1
         )
         RETURNING *`,
      );

      if (result.rows.length === 0) {
        io.emit("queue_updated", []);
        return res.json({ message: "Không còn ai trong hàng chờ" });
      }

      await broadcastQueue();
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ── PATCH /api/queue/:id/skip ─────────────────────────────
  router.patch("/:id/skip", authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE queues SET status = 'skipped'
         WHERE id = $1 AND status = 'waiting'
         RETURNING *`,
        [req.params.id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Không tìm thấy hoặc đã xử lý" });
      }

      await broadcastQueue();
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ── PATCH /api/queue/done ─────────────────────────────────
  router.patch("/done", authMiddleware, async (_req, res) => {
    try {
      const result = await pool.query(
        `UPDATE queues SET status = 'done', end_time = NOW()
         WHERE status = 'serving'
         RETURNING *`,
      );

      await broadcastQueue();
      res.json(result.rows[0] || { message: "Không có ai đang serving" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ── GET /api/queue/history ────────────────────────────────
  router.get("/history", authMiddleware, async (_req, res) => {
    try {
      const result = await pool.query(
        `SELECT *,
           EXTRACT(EPOCH FROM (end_time - start_time))/60 AS service_minutes
         FROM queues
         WHERE ${VN_DATE_FILTER}
         ORDER BY created_at DESC`,
      );

      const total = result.rows.length;
      const done = result.rows.filter((r) => r.status === "done").length;
      const avgMinutes = result.rows.filter((r) => r.service_minutes).reduce((acc, r) => acc + parseFloat(r.service_minutes), 0) / (done || 1);

      res.json({
        entries: result.rows,
        summary: {
          total,
          done,
          skipped: result.rows.filter((r) => r.status === "skipped").length,
          avgServiceMinutes: Math.round(avgMinutes),
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  return router;
}
