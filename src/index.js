import "dotenv/config";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import pool from "./db/index.js";
import queueRoutes from "./routes/queue.js";
import authRoutes from "./routes/auth.js";
import serviceRoutes from "./routes/services.js";
import schedulesRoutes from "./routes/schedules.js";
import dashboardRoutes from "./routes/dashboard.js";
import barberRoutes from "./routes/barbers.js";
import { registerSocketEvents } from "./socket/events.js";

const app = express();
const server = http.createServer(app);

const allowedOrigins = ["http://localhost:5173", "https://barber-queue-fe.vercel.app"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || origin.includes("vercel.app")) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json());

const io = new Server(server, {
  cors: { origin: allowedOrigins, methods: ["GET", "POST"] },
});

app.get("/", (_req, res) => res.send("Barber Queue API 💈"));

app.use("/api/queue", queueRoutes(io));
app.use("/api/services", serviceRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/schedules", schedulesRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/barbers", barberRoutes);

registerSocketEvents(io);

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    const r = await pool.query("SELECT NOW()");
    console.log("✅ DB connected:", r.rows[0].now);
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  }
}

startServer();
