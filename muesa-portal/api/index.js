const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // GET: Fetch records
  if (req.method === 'GET') {
    try {
      const [rows] = await pool.query('SELECT * FROM students ORDER BY id DESC');
      return res.status(200).json(rows);
    } catch (error) {
      console.error('Fetch error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // POST: Login & Student Registration
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { action, username, password } = body;

      // Authentication handling with role assignments
      if (action === 'login' || (username !== undefined && password !== undefined)) {
        if (username === 'admin' && password === 'HoD123') {
          return res.status(200).json({ success: true, user: username, role: 'admin' });
        } else if (username === 'president_muesa' && password === 'muesa2026') {
          return res.status(200).json({ success: true, user: username, role: 'user' });
        } else if (username === 'financial_muesa' && password === 'muesa2026') {
          return res.status(200).json({ success: true, user: username, role: 'user' });
        } else {
          return res.status(401).json({ error: 'Invalid username or password.' });
        }
      }

      const {
        student_name,
        reg_no,
        student_class,
        year,
        email,
        phone,
        payment_type,
        amount,
        registered_by
      } = body;

      if (!student_name || !reg_no || !amount) {
        return res.status(400).json({ error: 'Missing required fields.' });
      }

      // Insert record
      const query = `
        INSERT INTO students (student_name, reg_no, student_class, year, email, phone, payment_type, amount, registered_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        student_name,
        reg_no,
        student_class || '',
        year || '',
        email || null,
        phone || null,
        payment_type || 'Subscription',
        amount,
        registered_by || 'Admin'
      ];

      const [result] = await pool.query(query, values);

      // Email Dispatch
      let emailSent = false;
      let emailErrorDetails = null;

      if (email) {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
          emailErrorDetails = 'Vercel environment variables EMAIL_USER or EMAIL_PASS are missing.';
        } else {
          try {
            const transporter = nodemailer.createTransport({
              service: 'gmail',
              auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
              }
            });

            await transporter.sendMail({
              from: `"MUESA Official" <${process.env.EMAIL_USER}>`,
              to: email,
              subject: 'MUESA Official Payment Receipt',
              html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
                  <h2 style="color: #006633; margin-top: 0;">MUESA Official Receipt</h2>
                  <p>Mutesa I Royal University Education Students Association</p>
                  <hr style="border: 0; border-top: 1px solid #eee;" />
                  <p>Dear <strong>${student_name}</strong>,</p>
                  <p>Your payment has been successfully recorded on the MUESA Portal.</p>
                  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Reg / Student No:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${reg_no}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Class / Semester:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${student_class}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Year:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${year}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Payment Type:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${payment_type}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Amount Paid:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0; color: #006633; font-weight: bold;">UGX ${Number(amount).toLocaleString()}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Registered By:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${registered_by}</td></tr>
                  </table>
                </div>
              `
            });
            emailSent = true;
          } catch (mailErr) {
            console.error('Mail Dispatch Error:', mailErr);
            emailErrorDetails = mailErr.message;
          }
        }
      }

      return res.status(200).json({ 
        success: true, 
        insertId: result.insertId,
        emailSent: emailSent,
        emailError: emailErrorDetails 
      });

    } catch (error) {
      console.error('API Error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};