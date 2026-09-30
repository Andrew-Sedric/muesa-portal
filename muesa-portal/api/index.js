const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

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
async function ensurePasswordColumn() {
  if (!passwordMigration) {
    passwordMigration = (async () => {
      const [columns] = await pool.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'students' AND COLUMN_NAME = 'password'
      `);
      if (!columns.length) {
        try {
          await pool.query("ALTER TABLE students ADD COLUMN password VARCHAR(255) NOT NULL DEFAULT '123'");
        } catch (error) {
          if (error.code !== 'ER_DUP_FIELDNAME' && error.errno !== 1060) throw error;
        }
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
}

function staffRoleFor(username, password) {
  if (username === 'admin' && password === 'HoD123') return 'admin';
  if (username === 'president_muesa' && password === 'muesa2026') return 'president';
  if (username === 'financial_muesa' && password === 'muesa2026') return 'finance';
  return null;
}

function hashCollectionOtp(code) {
  const secret = process.env.ID_COLLECTION_OTP_SECRET || process.env.TIDB_PASSWORD;
  if (!secret) throw new Error('ID_COLLECTION_OTP_SECRET must be configured.');
  return crypto.createHmac('sha256', secret).update(code).digest('hex');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    await ensurePasswordColumn();
    await ensureCardNumberColumn();
  } catch (error) {
    console.error('Student password migration error:', error);
    return res.status(500).json({ error: 'Unable to prepare student accounts.' });
  }

  // GET: Fetch records
  if (req.method === 'GET') {
    if (req.query.action === 'photos') {
      try {
        await ensurePhotoTable();
        await pool.query(`
          CREATE TABLE IF NOT EXISTS student_card_prints (
            student_id BIGINT NOT NULL PRIMARY KEY,
            printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
          )
        `);
        const [rows] = await pool.query(`
          SELECT photos.student_id, photos.reg_no, photos.photo_data, photos.file_name, photos.photo_status, photos.updated_at, prints.printed_at
          FROM student_photos photos
          LEFT JOIN student_card_prints prints ON prints.student_id = photos.student_id
        `);
        return res.status(200).json(rows.map(photo => ({
          ...photo,
          photo_status: normalizePhotoStatus(photo.photo_data, photo.photo_status)
        })));
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
      const [rows] = await pool.query('SELECT *, DATE(created_at) as reg_date FROM students ORDER BY id DESC');
      return res.status(200).json(rows.map(({ password, ...student }) => student));
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

      if (action === 'get_id_collection_status') {
        if (!body.reg_no || !password) return res.status(400).json({ error: 'Registration number and password are required.' });
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
          WHERE LOWER(students.reg_no) = LOWER(?) AND students.password = ?
          LIMIT 1
        `, [body.reg_no.trim(), password]);
        if (!rows.length) return res.status(401).json({ error: 'Student authentication failed.' });
        const { id, ...status } = rows[0];
        return res.status(200).json({ success: true, ...status });
      }

      if (action === 'request_id_collection_otp') {
        if (!body.reg_no || !password) return res.status(400).json({ error: 'Registration number and password are required.' });
        await ensureIdCollectionTables();
        await pool.query(`CREATE TABLE IF NOT EXISTS student_card_prints (student_id BIGINT NOT NULL PRIMARY KEY, printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        const [students] = await pool.query(`
          SELECT students.id, students.reg_no, students.card_number, prints.printed_at, collections.collected_at
          FROM students
          LEFT JOIN student_card_prints prints ON prints.student_id = students.id
          LEFT JOIN id_card_collections collections ON collections.student_id = students.id
          WHERE LOWER(students.reg_no) = LOWER(?) AND students.password = ?
          LIMIT 1
        `, [body.reg_no.trim(), password]);
        if (!students.length) return res.status(401).json({ error: 'Student authentication failed.' });
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
        if (!staffRoleFor(username, password)) return res.status(401).json({ error: 'Staff authentication failed.' });
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

      if (action === 'verify_id_collection_otp') {
        const staffRole = staffRoleFor(username, password);
        if (!staffRole) return res.status(401).json({ error: 'Staff authentication failed.' });
        if (!body.reg_no || !/^\d{6}$/.test(String(body.code || ''))) return res.status(400).json({ error: 'Student number and six-digit code are required.' });
        await ensureIdCollectionTables();
        await pool.query(`CREATE TABLE IF NOT EXISTS student_card_prints (student_id BIGINT NOT NULL PRIMARY KEY, printed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();
          const [students] = await connection.query(`
            SELECT students.id, students.student_name, students.reg_no, students.card_number, prints.printed_at
            FROM students LEFT JOIN student_card_prints prints ON prints.student_id = students.id
            WHERE LOWER(students.reg_no) = LOWER(?) LIMIT 1 FOR UPDATE
          `, [body.reg_no.trim()]);
          if (!students.length) { await connection.rollback(); return res.status(404).json({ error: 'Student not found.' }); }
          const student = students[0];
          if (!student.printed_at) { await connection.rollback(); return res.status(409).json({ error: "This student's ID card has not been marked ready for collection." }); }
          const [collections] = await connection.query('SELECT collected_at FROM id_card_collections WHERE student_id = ?', [student.id]);
          if (collections.length) { await connection.rollback(); return res.status(409).json({ error: 'This ID card has already been collected.', collected_at: collections[0].collected_at }); }
          const [challenges] = await connection.query(`SELECT *, TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, expires_at) AS seconds_left FROM id_card_collection_otps WHERE student_id = ? FOR UPDATE`, [student.id]);
          if (!challenges.length || challenges[0].status !== 'PENDING') { await connection.rollback(); return res.status(400).json({ error: 'There is no active collection code for this student.' }); }
          const challenge = challenges[0];
          if (Number(challenge.seconds_left) <= 0) {
            await connection.query(`UPDATE id_card_collection_otps SET status = 'EXPIRED' WHERE student_id = ?`, [student.id]);
            await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor) VALUES (?, ?, ?, 'OTP_EXPIRED', ?)`, [student.id, student.reg_no, student.card_number, username]);
            await connection.commit();
            return res.status(410).json({ error: 'The collection code has expired. Ask the student to generate a new one.' });
          }
          if (Number(challenge.attempts) >= 5) { await connection.rollback(); return res.status(429).json({ error: 'Too many attempts. The student must generate a new code.' }); }
          const submittedHash = hashCollectionOtp(String(body.code));
          const validCode = crypto.timingSafeEqual(Buffer.from(submittedHash), Buffer.from(challenge.otp_hash));
          if (!validCode) {
            const attempts = Number(challenge.attempts) + 1;
            const status = attempts >= 5 ? 'LOCKED' : 'PENDING';
            await connection.query('UPDATE id_card_collection_otps SET attempts = ?, status = ? WHERE student_id = ?', [attempts, status, student.id]);
            await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor) VALUES (?, ?, ?, 'OTP_FAILED', ?)`, [student.id, student.reg_no, student.card_number, username]);
            await connection.commit();
            return res.status(400).json({ error: attempts >= 5 ? 'Too many incorrect attempts. The student must generate a new code.' : 'Incorrect code. Check the code with the student and try again.', attempts_remaining: Math.max(0, 5 - attempts) });
          }
          await connection.query(`UPDATE id_card_collection_otps SET status = 'VERIFIED', verified_at = CURRENT_TIMESTAMP WHERE student_id = ?`, [student.id]);
          await connection.query(`INSERT INTO id_card_collections (student_id, reg_no, card_number, collected_by) VALUES (?, ?, ?, ?)`, [student.id, student.reg_no, student.card_number, username]);
          await connection.query(`INSERT INTO id_card_collection_events (student_id, reg_no, card_number, event_type, actor) VALUES (?, ?, ?, 'COLLECTED', ?)`, [student.id, student.reg_no, student.card_number, username]);
          const [result] = await connection.query('SELECT collected_at FROM id_card_collections WHERE student_id = ?', [student.id]);
          await connection.commit();
          return res.status(200).json({ success: true, collected_at: result[0].collected_at, collected_by: username, student_name: student.student_name, reg_no: student.reg_no, card_number: student.card_number });
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }

      if (action === 'student_login') {
        if (!body.reg_no || !password) {
          return res.status(400).json({ error: 'Registration number and password are required.' });
        }
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
          WHERE LOWER(students.reg_no) = LOWER(?) AND students.password = ?
          LIMIT 1
        `, [body.reg_no.trim(), password]);
        if (!rows.length) return res.status(401).json({ error: 'Invalid student number or password.' });
        const { password: ignoredPassword, ...student } = rows[0];
        student.photo_status = normalizePhotoStatus(student.photo_data, student.photo_status);
        return res.status(200).json({ success: true, student });
      }

      if (action === 'student_upload_photo') {
        if (!body.reg_no || !body.password || !body.photo_data || !body.file_name) {
          return res.status(400).json({ error: 'Student authentication and a photo are required.' });
        }
        if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.photo_data)) {
          return res.status(400).json({ error: 'Upload a JPG, PNG, or WebP image.' });
        }
        await ensurePhotoTable();
        const [students] = await pool.query('SELECT id, reg_no FROM students WHERE LOWER(reg_no) = LOWER(?) AND password = ? LIMIT 1', [body.reg_no.trim(), body.password]);
        if (!students.length) return res.status(401).json({ error: 'Student authentication failed.' });
        await pool.query(`
          INSERT INTO student_photos (student_id, reg_no, photo_data, file_name, photo_status)
          VALUES (?, ?, ?, ?, 'Pending')
          ON DUPLICATE KEY UPDATE photo_data = VALUES(photo_data), file_name = VALUES(file_name), photo_status = 'Pending'
        `, [students[0].id, students[0].reg_no, body.photo_data, body.file_name]);
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
        if (!body.reg_no || !body.current_password || !body.new_password) {
          return res.status(400).json({ error: 'Registration number, current password, and new password are required.' });
        }
        if (String(body.new_password).length < 3) {
          return res.status(400).json({ error: 'New password must be at least 3 characters.' });
        }
        const [result] = await pool.query(
          'UPDATE students SET password = ? WHERE LOWER(reg_no) = LOWER(?) AND password = ?',
          [body.new_password, body.reg_no.trim(), body.current_password]
        );
        if (!result.affectedRows) return res.status(401).json({ error: 'Current password is incorrect.' });
        return res.status(200).json({ success: true, message: 'Password updated successfully.' });
      }

      if (action === 'admin_reset_password') {
        if (!body.student_id && !body.reg_no) {
          return res.status(400).json({ error: 'Student ID or registration number is required.' });
        }
        const [result] = await pool.query(
          body.student_id ? 'UPDATE students SET password = ? WHERE id = ?' : 'UPDATE students SET password = ? WHERE LOWER(reg_no) = LOWER(?)',
          ['123', body.student_id || body.reg_no]
        );
        if (!result.affectedRows) return res.status(404).json({ error: 'Student not found.' });
        return res.status(200).json({ success: true, message: 'Student password reset to 123.' });
      }

      // Authentication handling
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
            if (!/^data:image\/(jpeg|png|webp|gif);base64,/.test(photo.photo_data)) {
              throw new Error(`Unsupported image data for ${photo.file_name}.`);
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
        const { id, student_name, reg_no, email } = body;
        if (!id || !student_name || !reg_no) {
          return res.status(400).json({ error: 'Record ID, student name, and student number are required.' });
        }
        const [result] = await pool.query(
          'UPDATE students SET student_name = ?, reg_no = ?, email = ? WHERE id = ?',
          [student_name.trim(), reg_no.trim(), email ? email.trim() : null, id]
        );
        if (!result.affectedRows) {
          return res.status(404).json({ error: 'Record not found.' });
        }
        return res.status(200).json({ success: true, message: 'Record updated successfully.' });
      }

      const {
        student_name,
        reg_no,
        student_class,
        year,
        email,
        phone,
        payment_type,
        custom_payment_note,
        amount,
        registered_by
      } = body;

      if (!student_name || !reg_no || !amount) {
        return res.status(400).json({ error: 'Missing required fields.' });
      }

      // Format final payment type text
      const finalPaymentType = (payment_type === 'Others' && custom_payment_note) 
        ? `Others (${custom_payment_note})` 
        : (payment_type || 'Subscription');

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
        finalPaymentType,
        amount,
        registered_by || 'Admin'
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
                  <p>Dear <strong>${student_name}</strong>,</p>
                  <p>Your payment has been successfully recorded on the MUESA Portal.</p>
                  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Student Number:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${reg_no}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Class / Semester:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${student_class}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Year:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${year}</td></tr>
                    <tr><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;"><strong>Payment Type:</strong></td><td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">${finalPaymentType}</td></tr>
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