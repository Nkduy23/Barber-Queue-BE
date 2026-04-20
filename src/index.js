import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import pool from "./db/index.js";
import queueRoutes from "./routes/queue.js";
import authRoutes from "./routes/auth.js";
import serviceRoutes from "./routes/services.js";
import { registerSocketEvents } from "./socket/events.js";

const app = express();
const server = http.createServer(app);

// ── CORS CONFIG ──────────────────────────────────────────────
const allowedOrigins = ["http://localhost:5173", "https://barber-queue-fe.vercel.app"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);

      if (
        allowedOrigins.includes(origin) ||
        origin.includes("vercel.app") // 🔥 cho phép tất cả domain vercel
      ) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

// ── Middleware ───────────────────────────────────────────────
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.use(express.json());

// ── Socket.IO ────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

// ── Routes ──────────────────────────────────────────────────
app.get("/", (_req, res) => res.send("Barber Queue API 💈"));

app.use("/api/queue", queueRoutes(io));
app.use("/api/services", serviceRoutes);
app.use("/api/auth", authRoutes);

// ── Socket events ────────────────────────────────────────────
registerSocketEvents(io);

// ── Start server (async để check DB trước) ───────────────────
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    const r = await pool.query("SELECT NOW()");
    console.log("✅ DB connected:", r.rows[0].now);

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
    console.error("👉 Kiểm tra lại DATABASE_URL trong .env");
    process.exit(1); // 🔥 QUAN TRỌNG: fail fast
  }
}

startServer();
