export function registerSocketEvents(io) {
  io.on("connection", (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Client join room theo role (tuỳ chọn, để sau mở rộng)
    socket.on("join_room", (room) => {
      socket.join(room);
      console.log(`📌 ${socket.id} joined room: ${room}`);
    });

    socket.on("disconnect", () => {
      console.log(`❌ Client disconnected: ${socket.id}`);
    });
  });
}

// ── Danh sách events được emit từ routes/queue.js ────────────
//
// io.emit("queue_updated", rows)
//   → emit tới TẤT CẢ client mỗi khi queue thay đổi
//   → payload: mảng các queue entry đang waiting/serving
//
// Các event này được handle ở FE:
//   socket.on("queue_updated", (data) => { ... })
