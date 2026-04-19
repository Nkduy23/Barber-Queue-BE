import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const router = Router();

// ── POST /api/auth/login ──────────────────────────────────────
// Đăng nhập admin — hardcode 1 tài khoản (đủ cho demo/CV)
// Muốn xịn hơn thì lưu vào DB sau
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password" });
  }

  // Lấy từ .env
  const ADMIN_USER = process.env.ADMIN_USERNAME || "admin";
  const ADMIN_HASH = process.env.ADMIN_PASSWORD_HASH; // bcrypt hash

  if (username !== ADMIN_USER) {
    return res.status(401).json({ error: "Sai thông tin đăng nhập" });
  }

  // Nếu chưa set ADMIN_PASSWORD_HASH thì fallback về password plaintext (dev only)
  let isValid = false;
  if (ADMIN_HASH) {
    isValid = await bcrypt.compare(password, ADMIN_HASH);
  } else {
    // Dev mode: so sánh thẳng với ADMIN_PASSWORD
    const ADMIN_PASS = process.env.ADMIN_PASSWORD || "admin123";
    isValid = password === ADMIN_PASS;
    if (isValid) {
      console.warn("⚠️  Đang dùng plaintext password — chỉ dùng cho dev!");
    }
  }

  if (!isValid) {
    return res.status(401).json({ error: "Sai thông tin đăng nhập" });
  }

  const token = jwt.sign({ username, role: "admin" }, process.env.JWT_SECRET || "barber_secret_key", { expiresIn: "8h" });

  res.json({ token, message: "Đăng nhập thành công" });
});

// ── POST /api/auth/verify ─────────────────────────────────────
// FE gọi để check token còn hợp lệ không
router.post("/verify", (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ valid: false });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "barber_secret_key");
    res.json({ valid: true, user: decoded });
  } catch {
    res.status(401).json({ valid: false });
  }
});

export default router;
