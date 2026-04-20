import { Router } from "express";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const UTC_TO_VN_DATE = (col) => `DATE((${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Ho_Chi_Minh')`;

const NOW_VN = `NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

// Helper: lấy ngày VN hôm nay dạng string YYYY-MM-DD
function todayVN() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

export default function queueRoutes(io) {
  const router = Router();

  // ── HELPER: Broadcast ──────────────────────────────────────
  async function broadcastQueue(date = null) {
    const targetDate = date || todayVN();
    const result = await pool.query(
      `SELECT
         q.*,
         b.name AS barber_name,
         COALESCE(
           json_agg(
             json_build_object('id', s.id, 'name', s.name, 'duration', qs.duration, 'price', qs.price)
           ) FILTER (WHERE s.id IS NOT NULL),
           '[]'
         ) AS services,
         ROW_NUMBER() OVER (
           ORDER BY q.scheduled_time ASC NULLS LAST, q.id ASC
         ) AS display_position
       FROM queues q
       LEFT JOIN barbers b ON b.id = q.barber_id
       LEFT JOIN queue_services qs ON qs.queue_id = q.id
       LEFT JOIN services s ON s.id = qs.service_id
       WHERE q.status IN ('waiting', 'serving')
         AND q.booking_date = $1
       GROUP BY q.id, b.name
       ORDER BY q.scheduled_time ASC NULLS LAST, q.id ASC`,
      [targetDate],
    );
    io.emit("queue_updated", result.rows);
  }

  // ── HELPER: Settings ───────────────────────────────────────
  async function getTodaySettings(date = null) {
    const targetDate = date || todayVN();
    const result = await pool.query(`SELECT * FROM shop_settings WHERE setting_date = $1`, [targetDate]);
    return result.rows[0] || { open_time: "08:00", close_time: "19:00", slot_minutes: 30 };
  }

  // ── HELPER: Available slots (hỗ trợ ngày bất kỳ) ──────────
  async function getAvailableSlots(dateStr = null) {
    const targetDate = dateStr || todayVN();
    const settings = await getTodaySettings(targetDate);

    const barbersResult = await pool.query(`SELECT COUNT(*) FROM barbers WHERE is_active = true`);
    const activeBarbers = parseInt(barbersResult.rows[0].count) || 1;

    const bookedResult = await pool.query(
      `SELECT
         TO_CHAR(scheduled_time, 'HH24:MI') AS time_slot,
         COUNT(*) AS booked_count
       FROM queues
       WHERE status IN ('waiting', 'serving')
         AND scheduled_time IS NOT NULL
         AND booking_date = $1
       GROUP BY time_slot`,
      [targetDate],
    );

    const bookedMap = {};
    bookedResult.rows.forEach((r) => {
      bookedMap[r.time_slot] = parseInt(r.booked_count);
    });

    const slots = [];
    const [openH, openM] = settings.open_time.split(":").map(Number);
    const [closeH, closeM] = settings.close_time.split(":").map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;
    const slotMin = settings.slot_minutes;

    const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
    const nowMinutes = nowVN.getHours() * 60 + nowVN.getMinutes();
    const isToday = targetDate === todayVN();

    for (let m = openMinutes; m < closeMinutes - slotMin; m += slotMin) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const timeStr = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
      if (isToday && m < nowMinutes + 10) continue;
      const booked = bookedMap[timeStr] || 0;
      const available = activeBarbers - booked;
      slots.push({
        time: timeStr,
        label: timeStr,
        totalCapacity: activeBarbers,
        booked,
        available,
        isFull: available <= 0,
      });
    }

    return { slots, settings, activeBarbers };
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC ROUTES
  // ═══════════════════════════════════════════════════════════

  // GET /api/queue/slots?date=YYYY-MM-DD
  router.get("/slots", async (req, res) => {
    try {
      const data = await getAvailableSlots(req.query.date || null);
      res.json(data);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // GET /api/queue/stats
  router.get("/stats", async (_req, res) => {
    try {
      const settings = await getTodaySettings();
      const today = todayVN();

      const waiting = await pool.query(`SELECT COUNT(*) FROM queues WHERE status = 'waiting' AND booking_date = $1`, [today]);
      const serving = await pool.query(
        `SELECT q.*, b.name AS barber_name FROM queues q
         LEFT JOIN barbers b ON b.id = q.barber_id
         WHERE q.status = 'serving' AND q.booking_date = $1`,
        [today],
      );
      const barbersResult = await pool.query(`SELECT COUNT(*) FROM barbers WHERE is_active = true`);

      const activeBarbers = parseInt(barbersResult.rows[0].count) || 1;
      const waitingCount = parseInt(waiting.rows[0].count);

      // Ước tính wait dựa trên total_duration trung bình hoặc slot_minutes
      const avgDurResult = await pool.query(
        `SELECT AVG(total_duration) AS avg_dur FROM queues
         WHERE status = 'waiting' AND booking_date = $1 AND total_duration IS NOT NULL`,
        [today],
      );
      const avgDur = Math.round(avgDurResult.rows[0].avg_dur || settings.slot_minutes);
      const estimatedWait = Math.ceil(waitingCount / activeBarbers) * avgDur;

      res.json({
        waitingCount,
        currentServing: serving.rows,
        activeBarbers,
        estimatedWaitMinutes: estimatedWait,
        settings,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // GET /api/queue/barbers
  router.get("/barbers", async (_req, res) => {
    try {
      const result = await pool.query(`SELECT * FROM barbers ORDER BY id ASC`);
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // GET /api/queue/history?date=YYYY-MM-DD
  router.get("/history", authMiddleware, async (req, res) => {
    try {
      const targetDate = req.query.date || todayVN();
      const result = await pool.query(
        `SELECT
           q.*,
           b.name AS barber_name,
           ROUND(EXTRACT(EPOCH FROM (q.end_time - q.start_time)) / 60) AS service_minutes,
           COALESCE(
             json_agg(
               json_build_object('name', s.name, 'duration', qs.duration, 'price', qs.price)
             ) FILTER (WHERE s.id IS NOT NULL),
             '[]'
           ) AS services
         FROM queues q
         LEFT JOIN barbers b ON b.id = q.barber_id
         LEFT JOIN queue_services qs ON qs.queue_id = q.id
         LEFT JOIN services s ON s.id = qs.service_id
         WHERE q.booking_date = $1
         GROUP BY q.id, b.name
         ORDER BY q.created_at DESC`,
        [targetDate],
      );

      const entries = result.rows;
      const done = entries.filter((r) => r.status === "done");
      const avgMinutes = done.length > 0 ? Math.round(done.reduce((acc, r) => acc + parseFloat(r.service_minutes || 0), 0) / done.length) : 0;

      const byBarber = {};
      entries.forEach((r) => {
        const key = r.barber_name || "Chưa phân công";
        if (!byBarber[key]) byBarber[key] = { done: 0, total: 0 };
        byBarber[key].total++;
        if (r.status === "done") byBarber[key].done++;
      });

      // Doanh thu ngày
      const revenueResult = await pool.query(
        `SELECT COALESCE(SUM(qs.price), 0) AS total_revenue
         FROM queues q
         JOIN queue_services qs ON qs.queue_id = q.id
         WHERE q.booking_date = $1 AND q.status = 'done'`,
        [targetDate],
      );

      res.json({
        entries,
        summary: {
          total: entries.length,
          done: done.length,
          serving: entries.filter((r) => r.status === "serving").length,
          waiting: entries.filter((r) => r.status === "waiting").length,
          skipped: entries.filter((r) => r.status === "skipped").length,
          avgServiceMinutes: avgMinutes,
          totalRevenue: parseInt(revenueResult.rows[0].total_revenue),
          byBarber,
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // GET /api/queue?date=YYYY-MM-DD
  router.get("/", async (req, res) => {
    try {
      const targetDate = req.query.date || todayVN();
      const result = await pool.query(
        `SELECT
           q.*,
           b.name AS barber_name,
           COALESCE(
             json_agg(
               json_build_object('id', s.id, 'name', s.name, 'duration', qs.duration, 'price', qs.price)
             ) FILTER (WHERE s.id IS NOT NULL),
             '[]'
           ) AS services,
           ROW_NUMBER() OVER (
             ORDER BY q.scheduled_time ASC NULLS LAST, q.id ASC
           ) AS display_position
         FROM queues q
         LEFT JOIN barbers b ON b.id = q.barber_id
         LEFT JOIN queue_services qs ON qs.queue_id = q.id
         LEFT JOIN services s ON s.id = qs.service_id
         WHERE q.status IN ('waiting', 'serving')
           AND q.booking_date = $1
         GROUP BY q.id, b.name
         ORDER BY q.scheduled_time ASC NULLS LAST, q.id ASC`,
        [targetDate],
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // POST /api/queue — đặt lịch (có thể ngày bất kỳ)
  router.post("/", async (req, res) => {
    const { name, phone, scheduled_time, booking_date, note, service_ids = [] } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: "Thiếu tên hoặc số điện thoại" });
    }
    if (!service_ids.length) {
      return res.status(400).json({ error: "Vui lòng chọn ít nhất 1 dịch vụ" });
    }

    try {
      // Xác định booking_date
      let bDate = booking_date || todayVN();

      // Xây dựng scheduled datetime
      let scheduledDT = null;
      if (scheduled_time) {
        if (/^\d{2}:\d{2}$/.test(scheduled_time)) {
          scheduledDT = `${bDate} ${scheduled_time}:00`;
        } else {
          scheduledDT = scheduled_time;
          // Bóc date từ scheduled_time nếu không có booking_date
          if (!booking_date) {
            const m = String(scheduled_time).match(/(\d{4}-\d{2}-\d{2})/);
            if (m) bDate = m[1];
          }
        }

        // Kiểm tra slot đầy
        const barbersResult = await pool.query(`SELECT COUNT(*) FROM barbers WHERE is_active = true`);
        const activeBarbers = parseInt(barbersResult.rows[0].count) || 1;
        const slotCheck = await pool.query(
          `SELECT COUNT(*) FROM queues
           WHERE status IN ('waiting', 'serving')
             AND scheduled_time IS NOT NULL
             AND booking_date = $1
             AND TO_CHAR(scheduled_time, 'HH24:MI') = TO_CHAR($2::timestamp, 'HH24:MI')`,
          [bDate, scheduledDT],
        );
        if (parseInt(slotCheck.rows[0].count) >= activeBarbers) {
          return res.status(409).json({ error: "Slot giờ này đã đầy, vui lòng chọn giờ khác" });
        }
      }

      // Anti-cheat: trùng SĐT trong ngày
      const duplicate = await pool.query(
        `SELECT id FROM queues
         WHERE phone = $1 AND status IN ('waiting', 'serving') AND booking_date = $2`,
        [phone, bDate],
      );
      if (duplicate.rows.length > 0) {
        return res.status(409).json({ error: "Số điện thoại này đã có lịch ngày này" });
      }

      // Lấy thông tin services để tính total_duration
      const servicesResult = await pool.query(`SELECT id, duration, price FROM services WHERE id = ANY($1) AND is_active = true`, [service_ids]);
      if (!servicesResult.rows.length) {
        return res.status(400).json({ error: "Dịch vụ không hợp lệ" });
      }
      const totalDuration = servicesResult.rows.reduce((sum, s) => sum + s.duration, 0);

      // Tính position
      const posResult = await pool.query(`SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM queues WHERE booking_date = $1`, [bDate]);
      const position = parseInt(posResult.rows[0].next_pos);

      // Đếm người chờ trước
      const aheadResult = await pool.query(
        `SELECT COUNT(*) AS ahead FROM queues
         WHERE status = 'waiting' AND booking_date = $1
           AND (scheduled_time < $2::timestamp OR scheduled_time IS NULL)`,
        [bDate, scheduledDT || new Date().toISOString()],
      );
      const peopleAhead = parseInt(aheadResult.rows[0].ahead);

      // Insert queue entry
      const result = await pool.query(
        `INSERT INTO queues (name, phone, status, position, scheduled_time, booking_date, note, total_duration)
         VALUES ($1, $2, 'waiting', $3, $4, $5, $6, $7)
         RETURNING *`,
        [name, phone, position, scheduledDT, bDate, note || null, totalDuration],
      );
      const newEntry = result.rows[0];

      // Insert queue_services
      for (const svc of servicesResult.rows) {
        await pool.query(`INSERT INTO queue_services (queue_id, service_id, duration, price) VALUES ($1, $2, $3, $4)`, [newEntry.id, svc.id, svc.duration, svc.price]);
      }

      const settings = await getTodaySettings(bDate);
      const barbersResult2 = await pool.query(`SELECT COUNT(*) FROM barbers WHERE is_active = true`);
      const activeBarbers = parseInt(barbersResult2.rows[0].count) || 1;
      const estimatedWait = Math.ceil(peopleAhead / activeBarbers) * (totalDuration || settings.slot_minutes);

      await broadcastQueue(bDate);
      res.status(201).json({
        ...newEntry,
        services: servicesResult.rows,
        display_position: position,
        estimatedWaitMinutes: estimatedWait,
        peopleAhead,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // ADMIN ROUTES
  // ═══════════════════════════════════════════════════════════

  // POST /api/queue/walk-in — thêm khách vãng lai, start luôn
  router.post("/walk-in", authMiddleware, async (req, res) => {
    const { barber_id, name, service_ids = [] } = req.body;
    if (!barber_id) return res.status(400).json({ error: "Thiếu barber_id" });

    try {
      // Kiểm tra thợ đang bận không
      const busyCheck = await pool.query(`SELECT id FROM queues WHERE barber_id = $1 AND status = 'serving' AND booking_date = $2`, [barber_id, todayVN()]);
      if (busyCheck.rows.length > 0) {
        return res.status(409).json({ error: "Thợ đang phục vụ khách khác" });
      }

      // Lấy services nếu có
      let totalDuration = 25; // default
      let serviceRows = [];
      if (service_ids.length) {
        const svcRes = await pool.query(`SELECT id, duration, price FROM services WHERE id = ANY($1) AND is_active = true`, [service_ids]);
        serviceRows = svcRes.rows;
        totalDuration = serviceRows.reduce((sum, s) => sum + s.duration, 0);
      }

      const today = todayVN();
      const posResult = await pool.query(`SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM queues WHERE booking_date = $1`, [today]);
      const position = parseInt(posResult.rows[0].next_pos);
      const walkinName = name || `Khách ${position}`;

      const result = await pool.query(
        `INSERT INTO queues
           (name, phone, status, position, booking_date, walk_in, total_duration, barber_id, start_time)
         VALUES ($1, 'walk-in', 'serving', $2, $3, true, $4, $5, NOW())
         RETURNING *`,
        [walkinName, position, today, totalDuration, barber_id],
      );
      const newEntry = result.rows[0];

      for (const svc of serviceRows) {
        await pool.query(`INSERT INTO queue_services (queue_id, service_id, duration, price) VALUES ($1, $2, $3, $4)`, [newEntry.id, svc.id, svc.duration, svc.price]);
      }

      await broadcastQueue(today);
      res.status(201).json({ ...newEntry, services: serviceRows });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // PATCH /api/queue/settings
  router.patch("/settings", authMiddleware, async (req, res) => {
    const { open_time, close_time, slot_minutes, date } = req.body;
    try {
      const targetDate = date || todayVN();
      const result = await pool.query(
        `INSERT INTO shop_settings (setting_date, open_time, close_time, slot_minutes, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (setting_date) DO UPDATE SET
           open_time    = EXCLUDED.open_time,
           close_time   = EXCLUDED.close_time,
           slot_minutes = EXCLUDED.slot_minutes,
           updated_at   = NOW()
         RETURNING *`,
        [targetDate, open_time || "08:00", close_time || "19:00", slot_minutes || 30],
      );
      io.emit("settings_updated", result.rows[0]);
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // PATCH /api/queue/barbers/:id/toggle
  router.patch("/barbers/:id/toggle", authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(`UPDATE barbers SET is_active = NOT is_active WHERE id = $1 RETURNING *`, [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: "Không tìm thấy thợ" });
      io.emit("barbers_updated", result.rows[0]);
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // PATCH /api/queue/:id/start
  router.patch("/:id/start", authMiddleware, async (req, res) => {
    const { barber_id } = req.body;
    if (!barber_id) return res.status(400).json({ error: "Thiếu barber_id" });
    try {
      const busyCheck = await pool.query(`SELECT id FROM queues WHERE barber_id = $1 AND status = 'serving' AND booking_date = $2`, [barber_id, todayVN()]);
      if (busyCheck.rows.length > 0) {
        return res.status(409).json({ error: "Thợ đang phục vụ khách khác, hãy bấm Xong trước" });
      }
      const result = await pool.query(
        `UPDATE queues SET status = 'serving', start_time = NOW(), barber_id = $1
         WHERE id = $2 AND status = 'waiting' RETURNING *`,
        [barber_id, req.params.id],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Không tìm thấy hoặc đã xử lý" });
      await broadcastQueue(result.rows[0].booking_date);
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // PATCH /api/queue/:id/done
  router.patch("/:id/done", authMiddleware, async (req, res) => {
    const { barber_id } = req.body;
    try {
      const doneResult = await pool.query(
        `UPDATE queues SET status = 'done', end_time = NOW()
         WHERE id = $1 AND status = 'serving' RETURNING *`,
        [req.params.id],
      );
      if (!doneResult.rows.length) {
        return res.status(404).json({ error: "Không tìm thấy hoặc không đang serving" });
      }
      const doneEntry = doneResult.rows[0];

      let nextEntry = null;
      if (barber_id) {
        const nextResult = await pool.query(
          `UPDATE queues SET status = 'serving', start_time = NOW(), barber_id = $1
           WHERE id = (
             SELECT id FROM queues
             WHERE status = 'waiting' AND booking_date = $2
             ORDER BY scheduled_time ASC NULLS LAST, id ASC
             LIMIT 1
           ) RETURNING *`,
          [barber_id, doneEntry.booking_date],
        );
        nextEntry = nextResult.rows[0] || null;
      }

      await broadcastQueue(doneEntry.booking_date);
      res.json({
        done: doneEntry,
        next: nextEntry,
        message: nextEntry ? `Đã chuyển sang khách: ${nextEntry.name}` : "Hết khách trong hàng chờ",
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // PATCH /api/queue/:id/skip
  router.patch("/:id/skip", authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE queues SET status = 'skipped'
         WHERE id = $1 AND status IN ('waiting', 'serving') RETURNING *`,
        [req.params.id],
      );
      if (!result.rows.length) return res.status(404).json({ error: "Không tìm thấy hoặc đã xử lý" });
      await broadcastQueue(result.rows[0].booking_date);
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Lỗi server" });
    }
  });

  // Deprecated
  router.patch("/next", authMiddleware, async (_req, res) => {
    res.status(410).json({ error: "API deprecated. Dùng PATCH /:id/start và PATCH /:id/done" });
  });

  return router;
}
