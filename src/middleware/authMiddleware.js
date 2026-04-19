import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Không có token — vui lòng đăng nhập" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "barber_secret_key");
    req.user = decoded; // gắn user vào request để dùng ở route nếu cần
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token hết hạn — vui lòng đăng nhập lại" });
    }
    return res.status(401).json({ error: "Token không hợp lệ" });
  }
}
