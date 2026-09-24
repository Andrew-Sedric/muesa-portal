const mysql = require('mysql2/promise');

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

async function ensurePastPapersTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS past_papers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      course_code VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      paper_year VARCHAR(50) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      image_data LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function parseBody(req) {
  return typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
}

function requiredText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await ensurePastPapersTable();

    if (req.method === 'GET') {
      const { action, reg_no: regNo } = req.query || {};
      if (action !== 'get_past_papers') return res.status(400).json({ error: 'A valid action is required.' });

      if (regNo) {
        const [students] = await pool.query(
          'SELECT subscribed FROM students WHERE LOWER(reg_no) = LOWER(?) LIMIT 1',
          [String(regNo).trim()]
        );
        if (!students.length || !Number(students[0].subscribed)) {
          return res.status(403).json({ error: 'Access denied. Only subscribed association members can view past papers.' });
        }
      }

      const [rows] = await pool.query('SELECT id, course_code, title, paper_year, file_name, image_data, created_at FROM past_papers ORDER BY course_code ASC, created_at DESC');
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body.action === 'upload_past_paper') {
        const fields = ['course_code', 'title', 'paper_year', 'file_name', 'image_data'];
        if (fields.some(field => !requiredText(body[field]))) {
          return res.status(400).json({ error: 'Subject, title, academic year, file name, and an image are required.' });
        }
        if (!/^data:image\/[a-z0-9.+-]+;base64,/.test(body.image_data)) {
          return res.status(400).json({ error: 'The selected file must be a valid image.' });
        }
        const [result] = await pool.query(
          'INSERT INTO past_papers (course_code, title, paper_year, file_name, image_data) VALUES (?, ?, ?, ?, ?)',
          [body.course_code.trim(), body.title.trim(), body.paper_year.trim(), body.file_name.trim(), body.image_data]
        );
        return res.status(201).json({ success: true, id: result.insertId });
      }
      if (body.action === 'delete_past_paper') {
        if (!body.id) return res.status(400).json({ error: 'Document ID is required.' });
        const [result] = await pool.query('DELETE FROM past_papers WHERE id = ?', [body.id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Document not found.' });
        return res.status(200).json({ success: true });
      }
    }

    return res.status(400).json({ error: 'Unsupported request.' });
  } catch (error) {
    console.error('Past papers API error:', error);
    return res.status(500).json({ error: 'Unable to process past papers request.' });
  }
};
