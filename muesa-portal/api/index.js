const mysql = require('mysql2/promise');

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

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    // 1. User Authentication (Login)
    if (action === 'login' && req.method === 'POST') {
      const { username, password } = req.body;
      const [rows] = await pool.query(
        'SELECT id, username, role FROM users WHERE username = ? AND password_hash = ?',
        [username, password]
      );

      if (rows.length > 0) {
        return res.status(200).json({ success: true, user: rows[0] });
      } else {
        return res.status(401).json({ success: false, message: 'Invalid Username or Password' });
      }
    }

    // 2. Add New Student & Payment Record
    if (action === 'register' && req.method === 'POST') {
      const { 
        full_name, student_no, reg_no, year_of_study, 
        semester, email, phone, payment_type, amount, 
        academic_year, registered_by_role, registered_by_user 
      } = req.body;

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        // Insert or Get Existing Student
        let studentId;
        const [existing] = await connection.query(
          'SELECT id FROM students WHERE student_no = ? OR reg_no = ?',
          [student_no, reg_no]
        );

        if (existing.length > 0) {
          studentId = existing[0].id;
          // Update student info if existing
          await connection.query(
            'UPDATE students SET full_name=?, year_of_study=?, semester=?, email=?, phone=? WHERE id=?',
            [full_name, year_of_study, semester, email, phone, studentId]
          );
        } else {
          const [studentResult] = await connection.query(
            'INSERT INTO students (full_name, student_no, reg_no, year_of_study, semester, email, phone) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [full_name, student_no, reg_no, year_of_study, semester, email, phone]
          );
          studentId = studentResult.insertId;
        }

        // Insert Payment Transaction with Officer Audit Log
        const [transResult] = await connection.query(
          'INSERT INTO transactions (student_id, payment_type, amount, academic_year, registered_by_role, registered_by_user) VALUES (?, ?, ?, ?, ?, ?)',
          [studentId, payment_type, amount, academic_year, registered_by_role, registered_by_user]
        );

        await connection.commit();
        connection.release();

        return res.status(200).json({ 
          success: true, 
          message: 'Registration successful', 
          transaction_id: transResult.insertId 
        });
      } catch (err) {
        await connection.rollback();
        connection.release();
        throw err;
      }
    }

    // 3. Fetch Filtered Transactions & Dashboard Analytics
    if (action === 'get_records' && req.method === 'GET') {
      const { year, semester, payment_type, start_date, end_date } = req.query;

      let query = `
        SELECT 
          t.transaction_id, s.full_name, s.student_no, s.reg_no, 
          s.year_of_study, s.semester, s.email, t.payment_type, 
          t.amount, t.academic_year, t.registered_by_role, 
          t.registered_by_user, t.created_at
        FROM transactions t
        JOIN students s ON t.student_id = s.id
        WHERE 1=1
      `;
      const queryParams = [];

      if (year) { query += ' AND s.year_of_study = ?'; queryParams.push(year); }
      if (semester) { query += ' AND s.semester = ?'; queryParams.push(semester); }
      if (payment_type) { query += ' AND t.payment_type = ?'; queryParams.push(payment_type); }
      if (start_date) { query += ' AND DATE(t.created_at) >= ?'; queryParams.push(start_date); }
      if (end_date) { query += ' AND DATE(t.created_at) <= ?'; queryParams.push(end_date); }

      query += ' ORDER BY t.created_at DESC';

      const [records] = await pool.query(query, queryParams);
      return res.status(200).json({ success: true, records });
    }

    return res.status(404).json({ success: false, message: 'Invalid Endpoint' });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, error: error.message });
  }
};