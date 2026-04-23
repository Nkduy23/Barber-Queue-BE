import { Router } from "express";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();

function todayVN() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}

// Middleware: chỉ admin xem toàn bộ, staff chỉ xem data của mình
function resolveBarberFilter(req) {
  if (req.user.role === "admin") {
    // Admin có thể filter theo barber_id query param, hoặc xem tất cả
    return req.query.barber_id ? parseInt(req.query.barber_id) : null;
  }
  // Staff chỉ xem data của chính mình
  return req.user.barber_id;
}

// ══════════════════════════════════════════════════════════════
// GET /api/dashboard/revenue?from=&to=&barber_id=
// Doanh thu theo ngày, breakdown theo dịch vụ
// ══════════════════════════════════════════════════════════════
router.get("/revenue", authMiddleware, async (req, res) => {
  const from = req.query.from || todayVN();
  const to = req.query.to || todayVN();
  const barberId = resolveBarberFilter(req);

  try {
    // Tổng doanh thu theo ngày
    const dailyResult = await pool.query(
      `SELECT
         q.booking_date,
         COUNT(DISTINCT q.id)          AS total_customers,
         SUM(qs.price)                 AS revenue,
         COUNT(DISTINCT q.barber_id)   AS active_barbers
       FROM queues q
       JOIN queue_services qs ON qs.queue_id = q.id
       WHERE q.status = 'done'
         AND q.booking_date BETWEEN $1 AND $2
         ${barberId ? "AND q.barber_id = $3" : ""}
       GROUP BY q.booking_date
       ORDER BY q.booking_date DESC`,
      barberId ? [from, to, barberId] : [from, to],
    );

    // Breakdown doanh thu theo dịch vụ trong khoảng ngày
    const serviceResult = await pool.query(
      `SELECT
         s.name                AS service_name,
         COUNT(qs.id)          AS count,
         SUM(qs.price)         AS revenue,
         AVG(qs.duration)      AS avg_duration
       FROM queues q
       JOIN queue_services qs ON qs.queue_id = q.id
       JOIN services s ON s.id = qs.service_id
       WHERE q.status = 'done'
         AND q.booking_date BETWEEN $1 AND $2
         ${barberId ? "AND q.barber_id = $3" : ""}
       GROUP BY s.id, s.name
       ORDER BY revenue DESC`,
      barberId ? [from, to, barberId] : [from, to],
    );

    // Tổng cộng
    const totalRevenue = dailyResult.rows.reduce((sum, r) => sum + parseInt(r.revenue || 0), 0);
    const totalCustomers = dailyResult.rows.reduce((sum, r) => sum + parseInt(r.total_customers || 0), 0);

    res.json({
      from,
      to,
      totalRevenue,
      totalCustomers,
      daily: dailyResult.rows,
      byService: serviceResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/dashboard/barbers?from=&to=
// Thống kê hiệu suất từng thợ — admin only
// ══════════════════════════════════════════════════════════════
router.get("/barbers", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Chỉ admin mới có quyền xem" });
  }

  const from = req.query.from || todayVN();
  const to = req.query.to || todayVN();

  try {
    const result = await pool.query(
      `SELECT
         b.id                                          AS barber_id,
         b.name                                        AS barber_name,
         b.default_commission,
         COUNT(DISTINCT q.id)                          AS total_customers,
         COUNT(DISTINCT q.id) FILTER (WHERE q.status = 'done') AS done_customers,
         COALESCE(SUM(qs.price) FILTER (WHERE q.status = 'done'), 0) AS gross_revenue,
         ROUND(AVG(
           EXTRACT(EPOCH FROM (q.end_time - q.start_time)) / 60
         ) FILTER (WHERE q.status = 'done' AND q.end_time IS NOT NULL), 1) AS avg_service_minutes
       FROM barbers b
       LEFT JOIN queues q
         ON q.barber_id = b.id AND q.booking_date BETWEEN $1 AND $2
       LEFT JOIN queue_services qs ON qs.queue_id = q.id
       GROUP BY b.id, b.name, b.default_commission
       ORDER BY gross_revenue DESC`,
      [from, to],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/dashboard/salary?from=&to=&barber_id=
// Tính lương = gross_revenue * commission%
// Admin xem tất cả, staff xem mình
// ══════════════════════════════════════════════════════════════
router.get("/salary", authMiddleware, async (req, res) => {
  const from = req.query.from || todayVN();
  const to = req.query.to || todayVN();
  const barberId = resolveBarberFilter(req);

  try {
    // Lấy từng lượt service đã hoàn thành, kèm commission tương ứng
    // Priority: commission theo service_id cụ thể > commission default (service_id IS NULL)
    const result = await pool.query(
      `SELECT
         b.id                  AS barber_id,
         b.name                AS barber_name,
         q.booking_date,
         q.id                  AS queue_id,
         q.name                AS customer_name,
         s.name                AS service_name,
         qs.price,
         qs.duration,
         COALESCE(
           -- Commission theo service cụ thể
           (SELECT bc.percent FROM barber_commissions bc
            WHERE bc.barber_id = b.id AND bc.service_id = s.id LIMIT 1),
           -- Commission default của thợ đó
           (SELECT bc.percent FROM barber_commissions bc
            WHERE bc.barber_id = b.id AND bc.service_id IS NULL LIMIT 1),
           -- Fallback: default_commission từ barbers table
           b.default_commission
         )                     AS commission_percent,
         ROUND(
           qs.price * COALESCE(
             (SELECT bc.percent FROM barber_commissions bc
              WHERE bc.barber_id = b.id AND bc.service_id = s.id LIMIT 1),
             (SELECT bc.percent FROM barber_commissions bc
              WHERE bc.barber_id = b.id AND bc.service_id IS NULL LIMIT 1),
             b.default_commission
           ) / 100
         )                     AS commission_amount
       FROM queues q
       JOIN barbers b ON b.id = q.barber_id
       JOIN queue_services qs ON qs.queue_id = q.id
       JOIN services s ON s.id = qs.service_id
       WHERE q.status = 'done'
         AND q.booking_date BETWEEN $1 AND $2
         ${barberId ? "AND b.id = $3" : ""}
       ORDER BY b.id, q.booking_date, q.id`,
      barberId ? [from, to, barberId] : [from, to],
    );

    // Group by barber → tính tổng
    const barberMap = {};
    for (const row of result.rows) {
      const key = row.barber_id;
      if (!barberMap[key]) {
        barberMap[key] = {
          barber_id: row.barber_id,
          barber_name: row.barber_name,
          gross_revenue: 0,
          total_commission: 0,
          total_customers: new Set(),
          transactions: [],
        };
      }
      barberMap[key].gross_revenue += parseInt(row.price || 0);
      barberMap[key].total_commission += parseInt(row.commission_amount || 0);
      barberMap[key].total_customers.add(row.queue_id);
      barberMap[key].transactions.push({
        date: row.booking_date,
        customer: row.customer_name,
        service: row.service_name,
        price: row.price,
        commission_percent: row.commission_percent,
        commission_amount: row.commission_amount,
      });
    }

    const salaries = Object.values(barberMap).map((b) => ({
      ...b,
      total_customers: b.total_customers.size,
    }));

    res.json({ from, to, salaries });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/dashboard/commissions
// Lấy cấu hình hoa hồng — admin xem tất cả, staff xem mình
// ══════════════════════════════════════════════════════════════
router.get("/commissions", authMiddleware, async (req, res) => {
  const barberId = resolveBarberFilter(req);
  try {
    const result = await pool.query(
      `SELECT
         bc.*,
         b.name  AS barber_name,
         s.name  AS service_name
       FROM barber_commissions bc
       JOIN barbers b ON b.id = bc.barber_id
       LEFT JOIN services s ON s.id = bc.service_id
       ${barberId ? "WHERE bc.barber_id = $1" : ""}
       ORDER BY bc.barber_id, bc.service_id NULLS FIRST`,
      barberId ? [barberId] : [],
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// PATCH /api/dashboard/commissions — admin cấu hình hoa hồng
// Body: { barber_id, service_id (null = default), percent }
// ══════════════════════════════════════════════════════════════
router.patch("/commissions", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Chỉ admin mới có quyền" });
  }

  const { barber_id, service_id = null, percent } = req.body;
  if (!barber_id || percent == null) {
    return res.status(400).json({ error: "Thiếu barber_id hoặc percent" });
  }
  if (percent < 0 || percent > 100) {
    return res.status(400).json({ error: "Percent phải từ 0-100" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO barber_commissions (barber_id, service_id, percent, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (barber_id, service_id) DO UPDATE SET
         percent    = EXCLUDED.percent,
         updated_at = now()
       RETURNING *`,
      [barber_id, service_id, percent],
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
