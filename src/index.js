import "dotenv/config"; // ← phải import TRƯỚC tất cả, dùng cách này thay dotenv.config()
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import pool from "./db/index.js";
import queueRoutes from "./routes/queue.js";
import authRoutes from "./routes/auth.js";
import { registerSocketEvents } from "./socket/events.js";

const app = express();
const server = http.createServer(app);

// ── Socket.IO ────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: "*" },
});

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Routes ──────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Barber Queue API 💈"));
app.use("/api/queue", queueRoutes(io)); // truyền io vào để emit socket
app.use("/api/auth", authRoutes);

// ── Socket events ────────────────────────────────────────────
registerSocketEvents(io);

// ── DB health check ──────────────────────────────────────────
pool
  .query("SELECT NOW()")
  .then((r) => {
    console.log("✅ DB connected:", r.rows[0].now);
  })
  .catch((err) => {
    console.error("❌ DB connection failed:", err.message);
    console.error("👉 Kiểm tra lại DATABASE_URL trong file .env");
  });

// ── Start server ─────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
