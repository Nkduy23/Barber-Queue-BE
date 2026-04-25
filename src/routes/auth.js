import { Router } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import crypto from "crypto";
import pool from "../db/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "barber_secret_key";
const JWT_EXPIRES = "2h";
const REFRESH_EXPIRES_DAYS = 7;

// ── Helper: tạo refresh token random ─────────────────────────
function generateRefreshToken() {
  return crypto.randomBytes(64).toString("hex");
}

// ── Helper: lưu refresh token vào DB ─────────────────────────
async function saveRefreshToken(userId, token) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_EXPIRES_DAYS);
  await pool.query(`INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`, [userId, token, expiresAt]);
}

// ══════════════════════════════════════════════════════════════
// POST /api/auth/login
// Body: { username, password }
// ══════════════════════════════════════════════════════════════
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password" });
  }

  try {
    // Lookup user kèm thông tin barber (nếu có)
    const result = await pool.query(
      `SELECT u.*, b.name AS barber_name, b.is_active AS barber_active
       FROM users u
       LEFT JOIN barbers b ON b.id = u.barber_id
       WHERE u.username = $1`,
      [username],
    );

    const user = result.rows[0];
    console.log(user);

    if (!user) {
      return res.status(401).json({ error: "Sai thông tin đăng nhập" });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: "Tài khoản đã bị vô hiệu hóa" });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ error: "Sai thông tin đăng nhập" });
    }

    // Access token (ngắn hạn)
    const accessToken = jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        barber_id: user.barber_id ?? null,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES },
    );

    // Refresh token (dài hạn, lưu DB)
    const refreshToken = generateRefreshToken();
    await saveRefreshToken(user.id, refreshToken);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        barber_id: user.barber_id ?? null,
        barber_name: user.barber_name ?? null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/refresh
// Body: { refreshToken }
// → Cấp access token mới nếu refresh token còn hạn
// ══════════════════════════════════════════════════════════════
router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: "Thiếu refresh token" });
  }

  try {
    const result = await pool.query(
      `SELECT rt.*, u.username, u.role, u.barber_id, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token = $1`,
      [refreshToken],
    );

    const row = result.rows[0];

    if (!row) {
      return res.status(401).json({ error: "Refresh token không hợp lệ" });
    }
    if (row.revoked) {
      return res.status(401).json({ error: "Refresh token đã bị thu hồi" });
    }
    if (new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: "Refresh token hết hạn, vui lòng đăng nhập lại" });
    }
    if (!row.is_active) {
      return res.status(403).json({ error: "Tài khoản đã bị vô hiệu hóa" });
    }

    // Xoay refresh token (rotation) — thu hồi token cũ, cấp token mới
    await pool.query(`UPDATE refresh_tokens SET revoked = true WHERE token = $1`, [refreshToken]);
    const newRefreshToken = generateRefreshToken();
    await saveRefreshToken(row.user_id, newRefreshToken);

    const accessToken = jwt.sign(
      {
        userId: row.user_id,
        username: row.username,
        role: row.role,
        barber_id: row.barber_id ?? null,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES },
    );

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/logout
// Header: Authorization: Bearer <accessToken>
// Body: { refreshToken }
// ══════════════════════════════════════════════════════════════
router.post("/logout", authMiddleware, async (req, res) => {
  const { refreshToken } = req.body;

  try {
    if (refreshToken) {
      await pool.query(`UPDATE refresh_tokens SET revoked = true WHERE token = $1 AND user_id = $2`, [refreshToken, req.user.userId]);
    }
    res.json({ message: "Đăng xuất thành công" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/auth/verify
// Kiểm tra access token còn hợp lệ không
// ══════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════
// ADMIN ONLY — Quản lý users
// ══════════════════════════════════════════════════════════════

// GET /api/auth/users — lấy danh sách users
router.get("/users", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.is_active, u.created_at,
              b.id AS barber_id, b.name AS barber_name
       FROM users u
       LEFT JOIN barbers b ON b.id = u.barber_id
       ORDER BY u.created_at ASC`,
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// POST /api/auth/users — tạo user mới (admin tạo account cho thợ)
router.post("/users", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }

  const { username, password, role = "barber", barber_id = null } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Thiếu username hoặc password" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password phải có ít nhất 6 ký tự" });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password, role, barber_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, barber_id, is_active, created_at`,
      [username, hash, role, barber_id],
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Username đã tồn tại" });
    }
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// PATCH /api/auth/users/:id — cập nhật user (đổi password, toggle active...)
router.patch("/users/:id", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }

  const { password, is_active, barber_id, role } = req.body;
  const userId = req.params.id;

  try {
    let hashedPassword = null;
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: "Password phải có ít nhất 6 ký tự" });
      }
      hashedPassword = await bcrypt.hash(password, 10);
    }

    const result = await pool.query(
      `UPDATE users SET
         password   = COALESCE($1, password),
         is_active  = COALESCE($2, is_active),
         barber_id  = COALESCE($3, barber_id),
         role       = COALESCE($4, role),
         updated_at = now()
       WHERE id = $5
       RETURNING id, username, role, barber_id, is_active, updated_at`,
      [hashedPassword, is_active, barber_id, role, userId],
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Không tìm thấy user" });
    }

    // Nếu deactivate user → revoke tất cả refresh tokens
    if (is_active === false) {
      await pool.query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [userId]);
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// POST /api/auth/change-password — thợ tự đổi password của mình
router.post("/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Thiếu thông tin" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Mật khẩu mới phải có ít nhất 6 ký tự" });
  }

  try {
    const result = await pool.query(`SELECT * FROM users WHERE id = $1`, [req.user.userId]);
    const user = result.rows[0];

    if (!user) return res.status(404).json({ error: "Không tìm thấy user" });

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) return res.status(401).json({ error: "Mật khẩu hiện tại không đúng" });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password = $1, updated_at = now() WHERE id = $2`, [hash, user.id]);

    // Revoke tất cả refresh tokens → buộc đăng nhập lại trên các thiết bị khác
    await pool.query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [user.id]);

    res.json({ message: "Đổi mật khẩu thành công, vui lòng đăng nhập lại" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

// DELETE /api/auth/users/:id — xóa user (không xóa chính mình)
router.delete("/users/:id", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Không có quyền" });
  }

  const targetId = parseInt(req.params.id);

  if (targetId === req.user.userId) {
    return res.status(400).json({ error: "Không thể xóa tài khoản của chính mình" });
  }

  try {
    // Revoke refresh tokens trước
    await pool.query(`UPDATE refresh_tokens SET revoked = true WHERE user_id = $1`, [targetId]);

    const result = await pool.query(`DELETE FROM users WHERE id = $1 RETURNING id, username`, [targetId]);

    if (!result.rows.length) {
      return res.status(404).json({ error: "Không tìm thấy user" });
    }

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi server" });
  }
});

export default router;
