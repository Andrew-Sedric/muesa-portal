const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

// Setup TiDB MySQL Database Connection Pool
const pool = mysql.createPool({
  host: process.env.TIDB_HOST,
  user: process.env.TIDB_USER,
  password: process.env.TIDB_PASSWORD,
  database: process.env.TIDB_DATABASE || 'muesa_db',
  port: process.env.TIDB_PORT || 4000,
  ssl: { rejectUnauthorized: true },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Create Nodemailer Transporter for Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Handle Fetching Records
  if (req.method === 'GET') {
    try {
      const [rows] = await pool.query('SELECT * FROM students ORDER BY id DESC');
      return res.status(200).json(rows);
    } catch (error) {
      console.error('Database Fetch Error:', error);
      return res.status(500).json({ error: 'Failed to fetch student records.' });
    }
  }

  // Handle POST Requests (Login or Student Registration)
  if (req.method === 'POST') {
    try {
      const {
        action,
        username,
        password,
        student_name,
        reg_no,
        student_class,
        year,
        payment_type,
        amount,
        registered_by,
        student_email
      } = req.body || {};

      // Handle Login Verification
      if (action === 'login' || (username && password)) {
        if (username === 'financial_muesa' && password === 'muesa2026') {
          return res.status(200).json({ success: true, message: 'Login successful' });
        } else {
          return res.status(401).json({ error: 'Invalid username or password.' });
        }
      }

      // Handle New Student Registration
      if (!student_name || !reg_no || !amount) {
        return res.status(400).json({ error: 'Missing required student fields.' });
      }

      // Insert record into TiDB MySQL
      const [result] = await pool.query(
        `INSERT INTO students (student_name, reg_no, student_class, year, payment_type, amount, registered_by, student_email, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [student_name, reg_no, student_class, year, payment_type, amount, registered_by, student_email || null]
      );

      // Send Receipt Email if recipient address and credentials are present
      if (student_email && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        try {
          await transporter.sendMail({
            from: `"MUESA Official" <${process.env.EMAIL_USER}>`,
            to: student_email,
            subject: 'MUESA Payment & Registration Receipt',
            html: `
              <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
                <h2 style="color: #0d6efd; margin-top: 0;">MUESA Official Receipt</h2>
                <p>Mutesa I Royal University Education Students Association</p>
                <hr style="border: 0; border-top: 1px solid #eee;" />
                <p>Dear <strong>${student_name}</strong>,</p>
                <p>Your payment has been successfully recorded on the MUESA Portal.</p>
                
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                  <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Reg / Student No:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${reg_no}</td></tr>
                  <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Class / Semester:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${student_class || 'N/A'}</td></tr>
                  <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Payment Type:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${payment_type}</td></tr>
                  <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Amount Paid:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0; color: #198754; font-weight: bold;">UGX ${Number(amount).toLocaleString()}</td></tr>
                  <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Registered By:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${registered_by || 'Administrator'}</td></tr>
                  <tr><td style="padding: 8px 0;"><strong>Date:</strong></td><td style="padding: 8px 0;">${new Date().toLocaleDateString()}</td></tr>
                </table>

                <hr style="border: 0; border-top: 1px solid #eee;" />
                <p style="font-size: 12px; color: #6c757d;">This is an automated receipt generated by the MUESA Portal system.</p>
              </div>
            `
          });
        } catch (emailError) {
          console.error('Email dispatch failed:', emailError);
        }
      }

      return res.status(200).json({ success: true, insertId: result.insertId });
    } catch (error) {
      console.error('Database Request Error:', error);
      return res.status(500).json({ error: 'An unexpected error occurred.' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};