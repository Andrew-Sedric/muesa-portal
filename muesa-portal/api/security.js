const crypto = require('crypto');

const SESSION_LIFETIME_HOURS = 12;
const LOGIN_ATTEMPT_LIMIT = 8;
const LOGIN_WINDOW_MINUTES = 15;
const securityTablePromises = new WeakMap();

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const origin = req.headers && req.headers.origin;
  const allowedOrigins = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function ensureSecurityTables(pool) {
  if (!securityTablePromises.has(pool)) {
    const promise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS portal_sessions (
          token_hash CHAR(64) NOT NULL PRIMARY KEY,
          role VARCHAR(20) NOT NULL,
          username VARCHAR(100) NULL,
          student_id BIGINT NULL,
          must_change_password TINYINT(1) NOT NULL DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          KEY portal_sessions_student_id (student_id),
          KEY portal_sessions_expires_at (expires_at)
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS portal_login_attempts (
          account_key CHAR(64) NOT NULL PRIMARY KEY,
          attempts INT NOT NULL DEFAULT 0,
          window_started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
    })().catch(error => {
      securityTablePromises.delete(pool);
      throw error;
    });
    securityTablePromises.set(pool, promise);
  }
  return securityTablePromises.get(pool);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`;
}

function isPasswordHash(value) {
  return typeof value === 'string' && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/i.test(value);
}

function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256 || !isPasswordHash(encoded)) return false;
  const [, saltHex, hashHex] = encoded.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sessionTokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createSession(pool, { role, username = null, studentId = null, mustChangePassword = false }) {
  await ensureSecurityTables(pool);
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(`
    INSERT INTO portal_sessions (token_hash, role, username, student_id, must_change_password, expires_at)
    VALUES (?, ?, ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ${SESSION_LIFETIME_HOURS} HOUR))
  `, [sessionTokenHash(token), role, username, studentId, mustChangePassword ? 1 : 0]);
  return token;
}

function bearerToken(req) {
  const value = req.headers && req.headers.authorization;
  const match = typeof value === 'string' && value.match(/^Bearer ([A-Za-z0-9_-]+)$/);
  return match ? match[1] : null;
}

async function authenticate(req, pool) {
  const token = bearerToken(req);
  if (!token) return null;
  await ensureSecurityTables(pool);
  const [rows] = await pool.query(`
    SELECT role, username, student_id, must_change_password
    FROM portal_sessions
    WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP
    LIMIT 1
  `, [sessionTokenHash(token)]);
  if (!rows.length) return null;
  return {
    ...rows[0],
    student_id: rows[0].student_id == null ? null : String(rows[0].student_id),
    must_change_password: Number(rows[0].must_change_password) === 1,
    tokenHash: sessionTokenHash(token)
  };
}

async function revokeStudentSessions(pool, studentId) {
  await ensureSecurityTables(pool);
  await pool.query('DELETE FROM portal_sessions WHERE student_id = ?', [studentId]);
}

async function checkLoginLimit(pool, account) {
  await ensureSecurityTables(pool);
  const accountKey = crypto.createHash('sha256').update(String(account || '').trim().toLowerCase()).digest('hex');
  const [rows] = await pool.query(`
    SELECT attempts, TIMESTAMPDIFF(SECOND, window_started_at, CURRENT_TIMESTAMP) AS seconds_in_window
    FROM portal_login_attempts WHERE account_key = ?
  `, [accountKey]);
  if (rows.length && Number(rows[0].attempts) >= LOGIN_ATTEMPT_LIMIT
      && Number(rows[0].seconds_in_window) < LOGIN_WINDOW_MINUTES * 60) {
    return { limited: true, retryAfter: LOGIN_WINDOW_MINUTES * 60 - Number(rows[0].seconds_in_window) };
  }
  return { limited: false, accountKey };
}

async function recordFailedLogin(pool, accountKey) {
  await pool.query(`
    INSERT INTO portal_login_attempts (account_key, attempts, window_started_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON DUPLICATE KEY UPDATE
      attempts = IF(TIMESTAMPDIFF(SECOND, window_started_at, CURRENT_TIMESTAMP) >= ?, 1, attempts + 1),
      window_started_at = IF(TIMESTAMPDIFF(SECOND, window_started_at, CURRENT_TIMESTAMP) >= ?, CURRENT_TIMESTAMP, window_started_at)
  `, [accountKey, LOGIN_WINDOW_MINUTES * 60, LOGIN_WINDOW_MINUTES * 60]);
}

async function clearLoginFailures(pool, accountKey) {
  await pool.query('DELETE FROM portal_login_attempts WHERE account_key = ?', [accountKey]);
}

function staffCredential(username, password) {
  const credentials = [
    { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD, role: 'admin' },
    { username: process.env.PRESIDENT_USERNAME || 'president_muesa', password: process.env.PRESIDENT_PASSWORD, role: 'staff' },
    { username: process.env.FINANCIAL_USERNAME || 'financial_muesa', password: process.env.FINANCIAL_PASSWORD, role: 'staff' }
  ];
  return credentials.find(item => item.password && item.username === username && safeEqual(item.password, password)) || null;
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

module.exports = {
  applySecurityHeaders,
  authenticate,
  checkLoginLimit,
  clearLoginFailures,
  createSession,
  ensureSecurityTables,
  hashPassword,
  isPasswordHash,
  recordFailedLogin,
  revokeStudentSessions,
  staffCredential,
  verifyPassword
};
