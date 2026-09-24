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

      const [rows] = await pool.query('SELECT id, course_code, title, paper_year, file_name, image_data, created_at FROM past_papers ORDER BY course_code ASC, created_at DESC');
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body.action === 'upload_past_paper') {
        const fields = ['course_code', 'title', 'paper_year', 'file_name', 'image_data'];
        const pageImages = Array.isArray(body.image_data) ? body.image_data : [body.image_data];
        const pageNames = Array.isArray(body.file_name) ? body.file_name : pageImages.map(() => body.file_name);
        if (fields.slice(0, 3).some(field => !requiredText(body[field])) || !pageImages.length || pageImages.some(image => !requiredText(image)) || pageNames.some(name => !requiredText(name))) {
          return res.status(400).json({ error: 'Subject, title, academic year, file name, and an image are required.' });
        }
        if (pageImages.some(image => !/^data:image\/[a-z0-9.+-]+;base64,/.test(image))) {
          return res.status(400).json({ error: 'Every selected file must be a valid image.' });
        }
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const ids = [];
          for (let index = 0; index < pageImages.length; index += 1) {
            const [result] = await connection.query(
              'INSERT INTO past_papers (course_code, title, paper_year, file_name, image_data) VALUES (?, ?, ?, ?, ?)',
              [body.course_code.trim(), body.title.trim(), body.paper_year.trim(), String(pageNames[index]).trim(), pageImages[index]]
            );
            ids.push(result.insertId);
          }
          await connection.commit();
          return res.status(201).json({ success: true, ids, pages: ids.length });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
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
