import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import pool from "../db/index.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "barber_secret_key";

// ── POST /api/auth/login ──────────────────────────────────────
// Admin login — trả về role + barber_id nếu là thợ
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password" });
  }

  const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
  const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH;

  if (username !== ADMIN_USER) {
    return res.status(401).json({ error: "Sai thông tin đăng nhập" });
  }

  let isValid = false;
  if (ADMIN_HASH) {
    isValid = await bcrypt.compare(password, ADMIN_HASH);
  } else {
    const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
    isValid = password === ADMIN_PASS;
    if (isValid) console.warn("⚠️  Đang dùng plaintext password — chỉ dùng cho dev!");
  }

  if (!isValid) {
    return res.status(401).json({ error: "Sai thông tin đăng nhập" });
  }

  const token = jwt.sign({ username, role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token, role: "admin", message: "Đăng nhập thành công" });
});

// ── POST /api/auth/verify ─────────────────────────────────────
router.post("/verify", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ valid: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch {
    res.status(401).json({ valid: false });
  }
});

// ── POST /api/auth/select-barber ─────────────────────────────
// Thợ đã login vào admin → chọn tên mình → lưu vào localStorage FE
// Route này chỉ validate barber_id hợp lệ không, không issue token mới
// FE tự lưu barber_id vào localStorage để gửi kèm các request tiếp theo
router.post("/select-barber", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Chưa đăng nhập" });

  try {
    jwt.verify(token, JWT_SECRET); // phải là admin đã login
  } catch {
    return res.status(401).json({ error: "Token không hợp lệ" });
  }

  const { barber_id } = req.body;
  if (!barber_id) return res.status(400).json({ error: "Thiếu barber_id" });

  try {
    const result = await pool.query(`SELECT id, name, is_active FROM barbers WHERE id = $1`, [barber_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy thợ" });
    }
    res.json({ barber: result.rows[0], message: "Đã chọn thợ thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
