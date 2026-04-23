import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Không có token — vui lòng đăng nhập" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "barber_secret_key");
    // decoded: { userId, username, role, barber_id }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token hết hạn — vui lòng đăng nhập lại", code: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "Token không hợp lệ" });
  }
}

// Middleware chỉ cho admin
export function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Chỉ admin mới có quyền thực hiện" });
  }
  next();
}
