import pkg from "pg";
const { Pool, types } = pkg;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL chưa được set trong .env!");
  process.exit(1);
}

// Fix: tắt auto-convert timestamp của pg driver
// pg mặc định convert timestamp → JS Date → serialize sai UTC offset
types.setTypeParser(1114, (val) => val + "Z"); // TIMESTAMP without tz → thêm Z
types.setTypeParser(1184, (val) => val); // TIMESTAMPTZ → giữ nguyên string

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

export default pool;
