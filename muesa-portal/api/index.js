const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const {
  applySecurityHeaders,
  authenticate,
  checkLoginLimit,
  clearLoginFailures,
  createSession,
  hashPassword,
  isPasswordHash,
  recordFailedLogin,
  revokeStudentSessions,
  staffCredential,
  verifyPassword
} = require('./security');

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

let passwordMigration;
let cardNumberMigration;
let genderMigration;
async function ensurePasswordColumn() {
  if (!passwordMigration) {
    passwordMigration = (async () => {
      const [columns] = await pool.query(`
        SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'password'
      `);
      if (!columns.length) {
        try {
          await pool.query('ALTER TABLE students ADD COLUMN password VARCHAR(255) NULL');
        } catch (error) {
          if (error.code !== 'ER_DUP_FIELDNAME' && error.errno !== 1060) throw error;
        }
      }
      const [students] = await pool.query("SELECT id, password FROM students WHERE password IS NULL OR password NOT LIKE 'scrypt$%'");
      for (const student of students) {
        if (!isPasswordHash(student.password)) {
          await pool.query('UPDATE students SET password = ? WHERE id = ? AND password <=> ?', [hashPassword(student.password || '123'), student.id, student.password]);
        }
      }
      if (!columns.length || columns[0].IS_NULLABLE === 'YES' || columns[0].COLUMN_DEFAULT != null) {
        await pool.query('ALTER TABLE students MODIFY COLUMN password VARCHAR(255) NOT NULL');
      }
    })();
  }
  return passwordMigration;
}

async function ensureCardNumberColumn() {
  if (!cardNumberMigration) {
    cardNumberMigration = (async () => {
      const [columns] = await pool.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'card_number'
      `);
      if (!columns.length) {
        try {
          await pool.query("ALTER TABLE students ADD COLUMN card_number VARCHAR(20) NULL");
        } catch (error) {
          if (error.code !== 'ER_DUP_FIELDNAME' && error.errno !== 1060) throw error;
        }
      }

      const [students] = await pool.query("SELECT id FROM students WHERE card_number IS NULL OR TRIM(card_number) = '' ORDER BY id ASC");
      for (let index = 0; index < students.length; index += 1) {
        await pool.query('UPDATE students SET card_number = ? WHERE id = ?', [`26/${String(index + 1).padStart(3, '0')}`, students[index].id]);
      }
    })();
  }
  return cardNumberMigration;
}

async function ensureGenderColumn() {
  if (!genderMigration) {
    genderMigration = (async () => {
      const [columns] = await pool.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'gender'
      `);
      if (!columns.length) {
        try {
          await pool.query("ALTER TABLE students ADD COLUMN gender VARCHAR(30) NULL");
        } catch (error) {
          if (error.code !== 'ER_DUP_FIELDNAME' && error.errno !== 1060) throw error;
        }
      }
    })();
  }
  return genderMigration;
}

async function ensurePhotoTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_photos (
      student_id BIGINT NOT NULL,
      reg_no VARCHAR(100) NOT NULL,
      photo_data LONGTEXT NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      photo_status VARCHAR(20) NOT NULL DEFAULT 'No Picture',
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (student_id),
      UNIQUE KEY unique_student_photo_reg_no (reg_no)
    )
  `);
  const [columns] = await pool.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'student_photos' AND COLUMN_NAME = 'photo_status'
  `);
  if (!columns.length) {
    try {
      await pool.query("ALTER TABLE student_photos ADD COLUMN photo_status VARCHAR(20) NOT NULL DEFAULT 'No Picture'");
    } catch (error) {
      if (error.code !== 'ER_DUP_FIELDNAME' && error.errno !== 1060) throw error;
    }
  }

  await pool.query(`
    UPDATE student_photos
    SET photo_status = 'Approved'
    WHERE photo_data IS NOT NULL
      AND TRIM(photo_data) <> ''
      AND photo_status IN ('No Picture', '')
  `);
}

function normalizePhotoStatus(photoData, photoStatus) {
  const status = String(photoStatus || '').trim();
  if (!photoData) return 'No Picture';
  if (['Approved', 'Pending', 'Rejected'].includes(status)) return status;
  if (status === 'No Picture' || !status) return 'Approved';
  return 'Approved';
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function validRasterImage(dataUrl, maxBytes = 3 * 1024 * 1024) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxBytes * 4 / 3) + 32) return false;
  const match = typeof dataUrl === 'string'
    && dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) return false;
  if (match[1] === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

async function ensureIdCollectionTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS id_card_collection_otps (
      student_id BIGINT NOT NULL PRIMARY KEY,
      otp_hash CHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      verified_at DATETIME NULL,
      attempts INT NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS id_card_collections (
      student_id BIGINT NOT NULL PRIMARY KEY,
      reg_no VARCHAR(100) NOT NULL,
      card_number VARCHAR(20) NOT NULL,
      collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      collected_by VARCHAR(100) NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS id_card_collection_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      student_id BIGINT NOT NULL,
      reg_no VARCHAR(100) NOT NULL,
      card_number VARCHAR(20) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      actor VARCHAR(100) NOT NULL,
      occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS id_card_collection_staff_limits (
      staff_username VARCHAR(100) NOT NULL PRIMARY KEY,
      attempts INT NOT NULL DEFAULT 0,
      window_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function hashCollectionOtp(code) {
  const secret = process.env.ID_COLLECTION_OTP_SECRET || process.env.TIDB_PASSWORD;
  if (!secret) throw new Error('ID_COLLECTION_OTP_SECRET must be configured.');
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

async function collectionOtpRateLimit(username) {
  const [rows] = await pool.query(`SELECT attempts, TIMESTAMPDIFF(SECOND, window_started_at, CURRENT_TIMESTAMP) AS seconds_in_window FROM id_card_collection_staff_limits WHERE staff_username = ?`, [username]);
  if (rows.length && Number(rows[0].attempts) >= 10 && Number(rows[0].seconds_in_window) < 300) {
    return { limited: true, retryAfter: 300 - Number(rows[0].seconds_in_window) };
  }
  return { limited: false };
}

async function recordFailedCollectionOtp(username) {
  await pool.query(`
    INSERT INTO id_card_collection_staff_limits (staff_username, attempts, window_started_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      attempts = IF(TIMESTAMPDIFF(SECOND, window_started_at, CURRENT_TIMESTAMP) >= 300, 1, attempts + 1),
      window_started_at = IF(TIMESTAMPDIFF(SECOND, window_started_at, CURRENT_TIMESTAMP) >= 300, CURRENT_TIMESTAMP, window_started_at)
  `, [username]);
}

module.exports = async (req, res) => {
  applySecurityHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  try {
    await ensurePasswordColumn();
    await ensureCardNumberColumn();
    await ensureGenderColumn();
  } catch (error) {
    console.error('Student password migration error:', error);
    return res.status(500).json({ error: 'Unable to prepare student accounts.' });
  }

  // GET: Fetch records
  if (req.method === 'GET') {
    const session = await authenticate(req, pool);
    if (!session) return res.status(401).json({ error: 'Sign in is required to view student records.' });
    if (session.must_change_password) return res.status(403).json({ error: 'Change your temporary password before accessing the portal.' });
    if (session.role === 'student' && !session.student_id) return res.status(403).json({ error: 'Invalid student session.' });
    if (!['student', 'admin', 'staff'].includes(session.role)) return res.status(403).json({ error: 'This account cannot view student records.' });

    if (req.query.action === 'photos') {
      try {
        await ensurePhotoTable();
        await pool.query(`
          CREATE TABLE IF NOT EXISTS student_card_prints (
            student_id BIGINT NOT NULL PRIMARY KEY,
            printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        const [rows] = session.role === 'student'
          ? await pool.query(`
            SELECT photos.student_id, photos.reg_no, photos.photo_data, photos.file_name, photos.photo_status, photos.updated_at, prints.printed_at
            FROM student_photos photos
            LEFT JOIN student_card_prints prints ON prints.student_id = photos.student_id
            WHERE photos.student_id = ?
          `, [session.student_id])
          : await pool.query(`
            SELECT photos.student_id, photos.reg_no, photos.photo_data, photos.file_name, photos.photo_status, photos.updated_at, prints.printed_at
            FROM student_photos photos
            LEFT JOIN student_card_prints prints ON prints.student_id = photos.student_id
          `);
        return res.status(200).json(rows.map(photo => {
          const photoData = validRasterImage(photo.photo_data) ? photo.photo_data : '';
          return {
            ...photo,
            photo_data: photoData,
            photo_status: normalizePhotoStatus(photoData, photo.photo_status)
          };
        }));
      } catch (error) {
        if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_TABLE_ERROR') {
          return res.status(200).json([]);
        }
        console.error('Photo fetch error:', error);
        return res.status(500).json({ error: error.message });
      }
    }

    try {
      // Selects all columns including created_at timestamp
      const [rows] = session.role === 'student'
        ? await pool.query('SELECT *, DATE(created_at) as reg_date FROM students WHERE id = ? ORDER BY id DESC', [session.student_id])
        : await pool.query('SELECT *, DATE(created_at) as reg_date FROM students ORDER BY id DESC');
      return res.status(200).json(rows.map(({ password, ...student }) => ({
        ...student,
        ...(student.photo_data ? { photo_data: validRasterImage(student.photo_data) ? student.photo_data : '' } : {})
      })));
    } catch (error) {
      console.error('Fetch error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // DELETE: Remove record (Admin action)
  if (req.method === 'DELETE') {
    try {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'Record ID is required.' });
      }
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const session = await authenticate(req, pool);
      if (!session) return res.status(401).json({ error: 'Admin sign-in is required to delete records.' });
      if (session.role !== 'admin') return res.status(403).json({ error: 'Only an admin can delete records.' });
      if (body.permission_code !== 'DELETE WITH hod') {
        return res.status(403).json({ error: 'The HOD permission code is incorrect. The record was not deleted.' });
      }
      await revokeStudentSessions(pool, id);
      await pool.query('DELETE FROM students WHERE id = ?', [id]);
      return res.status(200).json({ success: true, message: 'Record deleted successfully.' });
    } catch (error) {
      console.error('Delete error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // POST: Login & Student Registration
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const { action, username, password } = body;

      if (action === 'student_login') {
        const regNo = String(body.reg_no || '').trim();
        if (!regNo || regNo.length > 100 || typeof password !== 'string' || !password || password.length > 256) {
          return res.status(400).json({ error: 'Registration number and password are required.' });
        }
        const limit = await checkLoginLimit(pool, `student:${regNo}`);
        if (limit.limited) return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.', retry_after: limit.retryAfter });
        await ensurePhotoTable();
        const [rows] = await pool.query(`
          SELECT students.*,
            COALESCE(p_id.photo_data, p_reg.photo_data) AS photo_data,
            COALESCE(p_id.file_name, p_reg.file_name) AS file_name,
            COALESCE(p_id.photo_status, p_reg.photo_status) AS photo_status,
            COALESCE(p_id.updated_at, p_reg.updated_at) AS photo_updated_at
          FROM students
          LEFT JOIN student_photos p_id ON p_id.student_id = students.id
          LEFT JOIN student_photos p_reg ON LOWER(p_reg.reg_no) = LOWER(students.reg_no)
          WHERE LOWER(students.reg_no) = LOWER(?)
          LIMIT 1
        `, [regNo]);
        if (!rows.length || !verifyPassword(password, rows[0].password)) {
          await recordFailedLogin(pool, limit.accountKey);
          return res.status(401).json({ error: !rows.length ? 'This registration number is not registered by the administration.' : 'Incorrect password.' });
        }
        await clearLoginFailures(pool, limit.accountKey);
        const mustChangePassword = verifyPassword('123', rows[0].password);
        const { password: ignoredPassword, ...student } = rows[0];
        if (student.photo_data && !validRasterImage(student.photo_data)) student.photo_data = '';
        student.photo_status = normalizePhotoStatus(student.photo_data, student.photo_status);
        const token = await createSession(pool, {
          role: 'student',
          studentId: student.id,
          mustChangePassword
        });
        return res.status(200).json({ success: true, token, student, must_change_password: mustChangePassword });
      }

      if (action === 'login' || (username !== undefined && password !== undefined)) {
        if (typeof username !== 'string' || username.length > 100 || typeof password !== 'string' || password.length > 256) {
          return res.status(400).json({ error: 'Username and password are required.' });
        }
        const limit = await checkLoginLimit(pool, `staff:${username}`);
        if (limit.limited) return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.', retry_after: limit.retryAfter });
        const credential = staffCredential(username, password);
        if (!credential) {
          await recordFailedLogin(pool, limit.accountKey);
          return res.status(401).json({ error: 'Invalid username or password.' });
        }
        await clearLoginFailures(pool, limit.accountKey);
        const token = await createSession(pool, { role: credential.role, username: credential.username });
        return res.status(200).json({ success: true, user: credential.username, role: credential.role, token });
      }

      const session = await authenticate(req, pool);
      if (!session) return res.status(401).json({ error: 'Sign in is required for this action.' });
      if (action === 'logout') {
        await pool.query('DELETE FROM portal_sessions WHERE token_hash = ?', [session.tokenHash]);
        return res.status(200).json({ success: true });
      }
      if (session.must_change_password && !['change_password', 'student_session'].includes(action)) {
        return res.status(403).json({ error: 'Change your temporary password before accessing the portal.' });
      }
      const adminActions = new Set([
        'admin_photo_review', 'confirm_photo_batch', 'mark_card_printed',
        'update_record', 'admin_reset_password'
      ]);
      const studentActions = new Set([
        'get_id_collection_status', 'request_id_collection_otp',
        'student_upload_photo', 'change_password'
      ]);
      const staffActions = new Set([
        'get_id_collection_records', 'lookup_id_collection_otp', 'confirm_id_collection_otp'
      ]);
      if (adminActions.has(action) && session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin sign-in is required for this action.' });
      }
      if (studentActions.has(action) && session.role !== 'student') {
        return res.status(403).json({ error: 'Student sign-in is required for this action.' });
      }
      if (staffActions.has(action) && !['admin', 'staff'].includes(session.role)) {
        return res.status(403).json({ error: 'Staff sign-in is required for this action.' });
      }
      if (!action && !['admin', 'staff'].includes(session.role)) {
        return res.status(403).json({ error: 'Staff sign-in is required to register students.' });
      }

      if (action === 'get_id_collection_status') {
        await ensureIdCollectionTables();
        await pool.query(`CREATE TABLE IF NOT EXISTS student_card_prints (student_id BIGINT NOT NULL PRIMARY KEY, printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        const [rows] = await pool.query(`
          SELECT students.id, students.reg_no, students.card_number, prints.printed_at,
            collections.collected_at, collections.collected_by, challenges.status AS otp_status,
            challenges.requested_at AS otp_requested_at, challenges.expires_at AS otp_expires_at,
            TIMESTAMPDIFF(SECOND, challenges.requested_at, CURRENT_TIMESTAMP) AS otp_seconds_since_request,
            TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, challenges.expires_at) AS otp_seconds_to_expiry
          FROM students
          LEFT JOIN student_card_prints prints ON prints.student_id = students.id
          LEFT JOIN id_card_collections collections ON collections.student_id = students.id
          LEFT JOIN id_card_collection_otps challenges ON challenges.student_id = students.id
          WHERE students.id = ?
          LIMIT 1
        `, [session.student_id]);
        if (!rows.length) return res.status(401).json({ error: 'Student account is no longer available.' });
        const { id, ...status } = rows[0];
        return res.status(200).json({ success: true, ...status });
      }

      if (action === 'request_id_collection_otp') {
        await ensureIdCollectionTables();
        await pool.query(`CREATE TABLE IF NOT EXISTS student_card_prints (student_id BIGINT NOT NULL PRIMARY KEY, printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        const [students] = await pool.query(`
          SELECT students.id, students.reg_no, students.card_number, prints.printed_at, collections.collected_at
          FROM students
          LEFT JOIN student_card_prints prints ON prints.student_id = students.id
          LEFT JOIN id_card_collections collections ON collections.student_id = students.id
          WHERE students.id = ?
          LIMIT 1
        `, [session.student_id]);
        if (!students.length) return res.status(401).json({ error: 'Student account is no longer available.' });
        const student = students[0];
        if (student.collected_at) return res.status(409).json({ error: 'This ID card has already been collected.', collected_at: student.collected_at });
        if (!student.printed_at) return res.status(409).json({ error: 'Your ID card is not ready for collection yet.' });

        const [challenges] = await pool.query(`SELECT status, TIMESTAMPDIFF(SECOND, requested_at, CURRENT_TIMESTAMP) AS seconds_since_request FROM id_card_collection_otps WHERE student_id = ?`, [student.id]);
        if (challenges.length && challenges[0].status === 'PENDING' && Number(challenges[0].seconds_since_request) < 30) {
          return res.status(429).json({ error: 'A code was just generated. Please wait before requesting another one.', retry_after: 30 - Number(challenges[0].seconds_since_request) });
        }

        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query('SELECT id FROM students WHERE id = ? FOR UPDATE', [student.id]);
          const [lockedChallenges] = await connection.query(`SELECT status, TIMESTAMPDIFF(SECOND, requested_at, CURRENT_TIMESTAMP) AS seconds_since_request FROM id_card_collection_otps WHERE student_id = ? FOR UPDATE`, [student.id]);
          if (lockedChallenges.length && lockedChallenges[0].status === 'PENDING' && Number(lockedChallenges[0].seconds_since_request) < 30) {
            await connection.rollback();
            return res.status(429).json({ error: 'A code was just generated. Please wait before requesting another one.', retry_after: 30 - Number(lockedChallenges[0].seconds_since_request) });
          }
          if (lockedChallenges.length && lockedChallenges[0].status === 'PENDING') {
            await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor) VALUES (?, ?, ?, 'OTP_REPLACED', ?)` , [student.id, student.reg_no, student.card_number, student.reg_no]);
          }
          await connection.query(`
            INSERT INTO id_card_collection_otps (student_id, otp_hash, status, requested_at, expires_at, verified_at, attempts)
            VALUES (?, ?, 'PENDING', CURRENT_TIMESTAMP, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE), NULL, 0)
            ON DUPLICATE KEY UPDATE otp_hash = VALUES(otp_hash), status = 'PENDING', requested_at = CURRENT_TIMESTAMP,
              expires_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 5 MINUTE), verified_at = NULL, attempts = 0
          `, [student.id, hashCollectionOtp(code)]);
          await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor, expires_at) SELECT ?, ?, ?, 'OTP_REQUESTED', ?, expires_at FROM id_card_collection_otps WHERE student_id = ?`, [student.id, student.reg_no, student.card_number, student.reg_no, student.id]);
          await connection.commit();
          return res.status(200).json({ success: true, code, expires_in_seconds: 300 });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }

      if (action === 'get_id_collection_records') {
        await ensureIdCollectionTables();
        await pool.query(`CREATE TABLE IF NOT EXISTS student_card_prints (student_id BIGINT NOT NULL PRIMARY KEY, printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        const [rows] = await pool.query(`
          SELECT students.id, students.student_name, students.reg_no, students.card_number,
            prints.printed_at, collections.collected_at, collections.collected_by
          FROM students
          INNER JOIN student_card_prints prints ON prints.student_id = students.id
          LEFT JOIN id_card_collections collections ON collections.student_id = students.id
          ORDER BY collections.collected_at DESC, students.student_name ASC
        `);
        return res.status(200).json(rows);
      }

      if (action === 'lookup_id_collection_otp' || action === 'confirm_id_collection_otp') {
        if (!/^\d{6}$/.test(String(body.code || ''))) return res.status(400).json({ error: 'A six-digit code is required.' });
        await ensureIdCollectionTables();
        await pool.query(`CREATE TABLE IF NOT EXISTS student_card_prints (student_id BIGINT NOT NULL PRIMARY KEY, printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        const rateLimit = await collectionOtpRateLimit(session.username);
        if (rateLimit.limited) return res.status(429).json({ error: 'Too many incorrect code attempts. Please wait before trying again.', retry_after: rateLimit.retryAfter });
        const submittedHash = hashCollectionOtp(String(body.code));
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [matches] = await connection.query(`
            SELECT students.id, students.student_name, students.reg_no, students.card_number,
              students.student_class, students.year, prints.printed_at,
              challenges.status AS otp_status,
              TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, challenges.expires_at) AS seconds_left,
              collections.collected_at
            FROM id_card_collection_otps challenges
            INNER JOIN students ON students.id = challenges.student_id
            LEFT JOIN student_card_prints prints ON prints.student_id = students.id
            LEFT JOIN id_card_collections collections ON collections.student_id = students.id
            WHERE challenges.otp_hash = ? AND challenges.status = 'PENDING'
            LIMIT 2 FOR UPDATE
          `, [submittedHash]);
          if (!matches.length) {
            await connection.rollback();
            await recordFailedCollectionOtp(session.username);
            return res.status(400).json({ error: 'No active student collection matches that code.' });
          }
          if (matches.length > 1) {
            await connection.rollback();
            return res.status(409).json({ error: 'This code is ambiguous. Ask the student to generate a new code.' });
          }
          const student = matches[0];
          if (Number(student.seconds_left) <= 0) {
            await connection.query(`UPDATE id_card_collection_otps SET status = 'EXPIRED' WHERE student_id = ?`, [student.id]);
            await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor) VALUES (?, ?, ?, 'OTP_EXPIRED', ?)`, [student.id, student.reg_no, student.card_number, session.username]);
            await connection.commit();
            return res.status(410).json({ error: 'The collection code has expired. Ask the student to generate a new one.' });
          }
          if (student.collected_at) { await connection.rollback(); return res.status(409).json({ error: 'This ID card has already been collected.', collected_at: student.collected_at }); }
          if (!student.printed_at) { await connection.rollback(); return res.status(409).json({ error: "This student's ID card has not been marked ready for collection." }); }

          if (action === 'lookup_id_collection_otp') {
            await connection.commit();
            return res.status(200).json({ success: true, student: { student_name: student.student_name, reg_no: student.reg_no, card_number: student.card_number, student_class: student.student_class, year: student.year, printed_at: student.printed_at } });
          }

          await connection.query(`UPDATE id_card_collection_otps SET status = 'VERIFIED', verified_at = CURRENT_TIMESTAMP WHERE student_id = ?`, [student.id]);
          await connection.query(`INSERT INTO id_card_collections (student_id, reg_no, card_number, collected_by) VALUES (?, ?, ?, ?)`, [student.id, student.reg_no, student.card_number, session.username]);
          await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor) VALUES (?, ?, ?, 'COLLECTED', ?)`, [student.id, student.reg_no, student.card_number, session.username]);
          const [result] = await connection.query('SELECT collected_at FROM id_card_collections WHERE student_id = ?', [student.id]);
          await connection.commit();
          return res.status(200).json({ success: true, collected_at: result[0].collected_at, collected_by: session.username, student_name: student.student_name, reg_no: student.reg_no, card_number: student.card_number });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }

      if (action === 'student_upload_photo') {
        if (!body.photo_data || !body.file_name) return res.status(400).json({ error: 'A photo and file name are required.' });
        if (!validRasterImage(body.photo_data)) return res.status(400).json({ error: 'Upload a valid JPG, PNG, or WebP image up to 3 MB.' });
        await ensurePhotoTable();
        const [students] = await pool.query('SELECT id, reg_no FROM students WHERE id = ? LIMIT 1', [session.student_id]);
        if (!students.length) return res.status(401).json({ error: 'Student authentication failed.' });
        await pool.query(`
          INSERT INTO student_photos (student_id, reg_no, photo_data, file_name, photo_status)
          VALUES (?, ?, ?, ?, 'Pending')
          ON DUPLICATE KEY UPDATE photo_data = VALUES(photo_data), file_name = VALUES(file_name), photo_status = 'Pending'
        `, [students[0].id, students[0].reg_no, body.photo_data, String(body.file_name).slice(0, 255)]);
        return res.status(200).json({ success: true, photo_status: 'Pending', message: 'Photo submitted for approval.' });
      }

      if (action === 'admin_photo_review') {
        if (!body.student_id || !['Approved', 'Rejected'].includes(body.photo_status)) {
          return res.status(400).json({ error: 'Student and valid photo status are required.' });
        }
        await ensurePhotoTable();
        const [result] = await pool.query('UPDATE student_photos SET photo_status = ? WHERE student_id = ?', [body.photo_status, body.student_id]);
        if (!result.affectedRows) return res.status(404).json({ error: 'Photo submission not found.' });
        return res.status(200).json({ success: true, photo_status: body.photo_status });
      }

      if (action === 'change_password') {
        if (typeof body.current_password !== 'string' || typeof body.new_password !== 'string') {
          return res.status(400).json({ error: 'Current and new passwords are required.' });
        }
        if (body.new_password.length < 8 || body.new_password.length > 256) {
          return res.status(400).json({ error: 'New password must be between 8 and 256 characters.' });
        }
        if (body.new_password === '123') {
          return res.status(400).json({ error: 'Choose a password other than the default password 123.' });
        }
        const [students] = await pool.query('SELECT id, password FROM students WHERE id = ? LIMIT 1', [session.student_id]);
        if (!students.length || (!session.must_change_password && !verifyPassword(body.current_password, students[0].password))) {
          return res.status(401).json({ error: 'Current password is incorrect.' });
        }
        await pool.query('UPDATE students SET password = ? WHERE id = ?', [hashPassword(body.new_password), session.student_id]);
        await revokeStudentSessions(pool, session.student_id);
        const token = await createSession(pool, { role: 'student', studentId: session.student_id });
        return res.status(200).json({ success: true, token, message: 'Password updated successfully.' });
      }

      if (action === 'admin_reset_password') {
        if (!body.student_id && !body.reg_no) {
          return res.status(400).json({ error: 'Student ID or registration number is required.' });
        }
        const [students] = await pool.query(
          body.student_id ? 'SELECT id FROM students WHERE id = ? LIMIT 1' : 'SELECT id FROM students WHERE LOWER(reg_no) = LOWER(?) LIMIT 1',
          [body.student_id || body.reg_no]
        );
        if (!students.length) return res.status(404).json({ error: 'Student not found.' });
        const [result] = await pool.query(
          'UPDATE students SET password = ? WHERE id = ?',
          [hashPassword('123'), students[0].id]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Student not found.' });
        await revokeStudentSessions(pool, students[0].id);
        return res.status(200).json({ success: true, message: 'Student password reset to 123.' });
      }

      if (action === 'confirm_photo_batch') {
        if (!Array.isArray(body.photos) || body.photos.length === 0) {
          return res.status(400).json({ error: 'At least one photo mapping is required.' });
        }

        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query(`
            CREATE TABLE IF NOT EXISTS student_photos (
              student_id BIGINT NOT NULL,
              reg_no VARCHAR(100) NOT NULL,
              photo_data LONGTEXT NOT NULL,
              file_name VARCHAR(255) NOT NULL,
              photo_status VARCHAR(20) NOT NULL DEFAULT 'No Picture',
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (student_id),
              UNIQUE KEY unique_student_photo_reg_no (reg_no)
            )
          `);

          for (const photo of body.photos) {
            if (!photo.student_id || !photo.reg_no || !photo.photo_data || !photo.file_name) {
              throw new Error('Each photo mapping requires a student, registration number, file name, and image.');
            }
            if (!validRasterImage(photo.photo_data)) {
              throw new Error(`Unsupported or oversized raster image for ${photo.file_name} (maximum 3 MB).`);
            }
            await connection.query(`
              INSERT INTO student_photos (student_id, reg_no, photo_data, file_name, photo_status)
              VALUES (?, ?, ?, ?, 'Pending')
              ON DUPLICATE KEY UPDATE
                reg_no = VALUES(reg_no), photo_data = VALUES(photo_data), file_name = VALUES(file_name), photo_status = 'Pending'
            `, [photo.student_id, photo.reg_no, photo.photo_data, photo.file_name]);
          }

          await connection.commit();
          return res.status(200).json({ success: true, saved: body.photos.length });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }

      if (action === 'mark_card_printed') {
        if (!body.student_id) {
          return res.status(400).json({ error: 'Student ID is required.' });
        }
        await pool.query(`
          CREATE TABLE IF NOT EXISTS student_card_prints (
            student_id BIGINT NOT NULL PRIMARY KEY,
            printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        await pool.query(`
          INSERT INTO student_card_prints (student_id) VALUES (?)
          ON DUPLICATE KEY UPDATE printed_at = CURRENT_TIMESTAMP
        `, [body.student_id]);
        const [rows] = await pool.query('SELECT printed_at FROM student_card_prints WHERE student_id = ?', [body.student_id]);
        return res.status(200).json({ success: true, printed_at: rows[0].printed_at });
      }

      if (action === 'update_record') {
        const { id, student_name, reg_no, email, gender } = body;
        if (!id || !student_name || !reg_no || !['Male', 'Female', 'Other', 'Prefer not to say'].includes(gender)) {
          return res.status(400).json({ error: 'Record ID, student name, student number, and a valid gender are required.' });
        }
        const [result] = await pool.query(
          'UPDATE students SET student_name = ?, reg_no = ?, email = ?, gender = ? WHERE id = ?',
          [student_name.trim(), reg_no.trim(), email ? email.trim() : null, gender, id]
        );
        if (!result.affectedRows) {
          return res.status(404).json({ error: 'Record not found.' });
        }
        return res.status(200).json({ success: true, message: 'Record updated successfully.' });
      }

      if (action === 'student_session') {
        if (session.role !== 'student') return res.status(403).json({ error: 'Student sign-in is required.' });
        if (session.must_change_password) {
          return res.status(200).json({ success: true, must_change_password: true });
        }
        const [rows] = await pool.query(`
          SELECT students.id, students.student_name, students.reg_no, students.student_class, students.year,
            students.gender, students.payment_type, students.card_number,
            COALESCE(p_id.photo_data, p_reg.photo_data) AS photo_data,
            COALESCE(p_id.photo_status, p_reg.photo_status) AS photo_status
          FROM students
          LEFT JOIN student_photos p_id ON p_id.student_id = students.id
          LEFT JOIN student_photos p_reg ON LOWER(p_reg.reg_no) = LOWER(students.reg_no)
          WHERE students.id = ? LIMIT 1
        `, [session.student_id]);
        if (!rows.length) return res.status(401).json({ error: 'Student account is no longer available.' });
        if (rows[0].photo_data && !validRasterImage(rows[0].photo_data)) rows[0].photo_data = '';
        rows[0].photo_status = normalizePhotoStatus(rows[0].photo_data, rows[0].photo_status);
        return res.status(200).json({ success: true, student: rows[0], must_change_password: false });
      }

      const {
        student_name,
        reg_no,
        student_class,
        year,
        gender,
        email,
        phone,
        payment_type,
        custom_payment_note,
        amount,
        registered_by
      } = body;

      if (!student_name || !reg_no || !amount || !['Male', 'Female', 'Other', 'Prefer not to say'].includes(gender)) {
        return res.status(400).json({ error: 'Student name, student number, amount, and a valid gender are required.' });
      }

      // Format final payment type text
      const finalPaymentType = (payment_type === 'Others' && custom_payment_note) 
        ? `Others (${custom_payment_note})` 
        : (payment_type || 'Subscription');

      // Insert record
      const query = `
        INSERT INTO students (student_name, reg_no, student_class, year, gender, email, phone, payment_type, amount, registered_by, password)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const values = [
        student_name,
        reg_no,
        student_class || '',
        year || '',
        gender,
        email || null,
        phone || null,
        finalPaymentType,
        amount,
        registered_by || session.username || 'Admin',
        hashPassword('123')
      ];

      const [result] = await pool.query(query, values);
      const [latestCard] = await pool.query(`
        SELECT MAX(CAST(SUBSTRING_INDEX(card_number, '/', -1) AS UNSIGNED)) AS latest_number
        FROM students
        WHERE card_number IS NOT NULL AND card_number <> ''
      `);
      const nextCardNumber = Number(latestCard[0]?.latest_number || 0) + 1;
      const cardNumber = `26/${String(nextCardNumber).padStart(3, '0')}`;
      await pool.query('UPDATE students SET card_number = ? WHERE id = ?', [cardNumber, result.insertId]);

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
                  <p>MUTEESA I Royal University Education Students Association</p>
                  <hr style="border: 0; border-top: 1px solid #eee;" />
                  <p>Dear <strong>${escapeHtml(student_name)}</strong>,</p>
                  <p>Your payment has been successfully recorded on the MUESA Portal.</p>
                  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Student Number:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(reg_no)}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Class / Semester:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(student_class)}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Year:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(year)}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Payment Type:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(finalPaymentType)}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Amount Paid:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0; color: #006633; font-weight: bold;">UGX ${Number(amount).toLocaleString()}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Registered By:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${escapeHtml(registered_by || session.username || 'Admin')}</td></tr>
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
        card_number: cardNumber,
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