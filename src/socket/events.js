export function registerSocketEvents(io) {
  io.on("connection", (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // ── Join room (phân role hoặc nhóm) ───────────────────────
    socket.on("join_room", (room) => {
      socket.join(room);
      console.log(`📌 ${socket.id} joined room: ${room}`);
    });

    // ── Disconnect ────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });
}

/*
📡 EVENTS EMIT TỪ queueRoutes:

io.emit("queue_updated", rows)
→ Gửi tới tất cả client

👉 Gợi ý nâng cấp sau:
io.to("barber").emit(...)
io.to("client").emit(...)

Frontend:
socket.on("queue_updated", (data) => {
  // update UI
});
*/
