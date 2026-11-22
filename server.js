const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit').rateLimit;
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || path.join(__dirname, 'einsatztakt.db');
const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || (!production && crypto.randomBytes(32).toString('hex'));
const scrypt = promisify(crypto.scrypt);
process.umask(0o077);
const db = new sqlite3.Database(dbPath);

class SQLiteSessionStore extends session.Store {
  get(sid, callback) {
    get('SELECT sess, expires_at FROM sessions WHERE sid = ?', [sid])
      .then(row => {
        if (!row || row.expires_at <= Date.now()) {
          if (row) run('DELETE FROM sessions WHERE sid = ?', [sid]).catch(error => console.error('Sitzung konnte nicht gelöscht werden:', error.message));
          return callback(null, null);
        }
        callback(null, JSON.parse(row.sess));
      })
      .catch(callback);
  }

  set(sid, sess, callback = () => {}) {
    const expiresAt = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess.cookie?.maxAge || 8 * 60 * 60 * 1000);
    run(
      `INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, JSON.stringify(sess), expiresAt]
    ).then(() => callback()).catch(callback);
  }

  destroy(sid, callback = () => {}) {
    run('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => callback())
      .catch(callback);
  }

  touch(sid, sess, callback = () => {}) {
    const expiresAt = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + (sess.cookie?.maxAge || 8 * 60 * 60 * 1000);
    run('UPDATE sessions SET expires_at = ? WHERE sid = ?', [expiresAt, sid])
      .then(() => callback())
      .catch(callback);
  }
}

if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
}

if (production) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://formspree.io'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'", 'https://formspree.io']
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const origin = req.get('origin');
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    if (origin && origin !== expectedOrigin) {
      return res.status(403).json({ error: 'Anfragequelle nicht erlaubt.' });
    }
    if (!req.is('application/json')) {
      return res.status(415).json({ error: 'JSON-Anfragen sind erforderlich.' });
    }
  }
  next();
});

app.use(express.json({ limit: '16kb' }));
app.use(session({
  name: 'einsatztakt.sid',
  secret: sessionSecret,
  store: new SQLiteSessionStore(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: production,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' }
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Zu viele Registrierungen. Bitte später erneut versuchen.' }
});

app.use('/vendor', express.static(path.join(__dirname, 'node_modules/lucide/dist/umd'), {
  immutable: true,
  maxAge: '1y'
}));
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, err => err ? reject(err) : resolve());
  });
}

function isPasswordHash(value) {
  return typeof value === 'string' && value.startsWith('scrypt$');
}

async function hashSecret(value) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
}

const dummyCredentialHash = hashSecret(crypto.randomBytes(32).toString('hex'));

async function verifySecret(value, stored) {
  if (typeof value !== 'string' || typeof stored !== 'string') return { valid: false, needsUpgrade: false };
  if (!isPasswordHash(stored)) {
    const supplied = Buffer.from(value);
    const legacy = Buffer.from(stored);
    const valid = supplied.length === legacy.length && crypto.timingSafeEqual(supplied, legacy);
    return { valid, needsUpgrade: valid };
  }

  const [algorithm, n, r, p, saltHex, hashHex] = stored.split('$');
  if (algorithm !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' ||
      !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{128}$/.test(hashHex)) {
    return { valid: false, needsUpgrade: false };
  }
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scrypt(value, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
  });
  return { valid: expected.length === derived.length && crypto.timingSafeEqual(expected, derived), needsUpgrade: false };
}

async function migrateLegacyHashes() {
  const companyColumns = await all('PRAGMA table_info(companies)');
  if (companyColumns.some(column => column.name === 'chef_pass')) {
    await run('ALTER TABLE companies RENAME COLUMN chef_pass TO chef_pass_hash');
  }
  const workerColumns = await all('PRAGMA table_info(workers)');
  if (workerColumns.some(column => column.name === 'pin')) {
    await run('ALTER TABLE workers RENAME COLUMN pin TO pin_hash');
  }

  const companies = await all('SELECT code, chef_pass_hash FROM companies');
  for (const company of companies) {
    if (!isPasswordHash(company.chef_pass_hash)) {
      await run('UPDATE companies SET chef_pass_hash = ? WHERE code = ?', [
        await hashSecret(company.chef_pass_hash), company.code
      ]);
    }
  }
  const workers = await all('SELECT id, pin_hash FROM workers');
  for (const worker of workers) {
    if (!isPasswordHash(worker.pin_hash)) {
      await run('UPDATE workers SET pin_hash = ? WHERE id = ?', [
        await hashSecret(worker.pin_hash), worker.id
      ]);
    }
  }
}

async function initializeDatabase() {
  await exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  await exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await migrateLegacyHashes();
  const logColumns = await all('PRAGMA table_info(logs)');
  if (!logColumns.some(column => column.name === 'worker_id')) {
    await run('ALTER TABLE logs ADD COLUMN worker_id INTEGER REFERENCES workers(id)');
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_chef_email_lower ON companies(LOWER(chef_email))');
  await run('CREATE INDEX IF NOT EXISTS idx_workers_company ON workers(company_code)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_company_email_lower ON workers(company_code, LOWER(email))');
  await run('CREATE INDEX IF NOT EXISTS idx_logs_company ON logs(company_code, id DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_tickets_company ON tickets(company_code, id DESC)');
  await run('CREATE INDEX IF NOT EXISTS idx_sessions_expiration ON sessions(expires_at)');
  await run('DELETE FROM sessions WHERE expires_at <= ?', [Date.now()]);
  fs.chmodSync(dbPath, 0o600);
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: 'Bitte zuerst anmelden.' });
    if (req.session.user.role !== role) return res.status(403).json({ error: 'Keine Berechtigung für diese Aktion.' });
    next();
  };
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function randomCompanyCode() {
  return `ET-${crypto.randomBytes(16).toString('hex').toUpperCase()}`;
}

function regenerateSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.user = user;
      req.session.save(saveErr => saveErr ? reject(saveErr) : resolve());
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy(err => err ? reject(err) : resolve());
  });
}

app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', service: 'EinsatzTakt Backend' });
});

app.get('/api/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.session.user) return res.status(401).json({ error: 'Nicht angemeldet.' });
  res.json(req.session.user);
});

app.post('/api/register', registrationLimiter, async (req, res, next) => {
  try {
    const { name, branch, street, city, phone, chefName, email, pass } = req.body;
    if (![name, chefName, email].every(value => validText(value, 255)) ||
        typeof pass !== 'string' || pass.length < 12 || pass.length > 200 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Bitte gültige Pflichtfelder ausfüllen und ein Passwort mit mindestens 12 Zeichen wählen.' });
    }
    const passwordHash = await hashSecret(pass);
    let company;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = randomCompanyCode();
      try {
        await run(
          `INSERT INTO companies (code, name, branch, street, city, phone, chef_name, chef_email, chef_pass_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [code, name.trim(), String(branch || '').slice(0, 100), String(street || '').slice(0, 255),
            String(city || '').slice(0, 100), String(phone || '').slice(0, 50), chefName.trim(),
            email.trim().toLowerCase(), passwordHash]
        );
        const project = await run(
          'INSERT INTO projects (company_code, name, budget) VALUES (?, ?, ?)',
          [code, 'Hauptprojekt / Allgemein', 10000]
        );
        company = { code, name: name.trim(), projectId: project.lastID };
        break;
      } catch (error) {
        if (error.message.includes('UNIQUE constraint failed') &&
            (await get('SELECT 1 FROM companies WHERE LOWER(chef_email) = LOWER(?)', [email.trim()]))) {
          return res.status(409).json({ error: 'Diese E-Mail-Adresse ist bereits registriert.' });
        }
        if (attempt === 2) throw error;
      }
    }
    await regenerateSession(req, {
      companyCode: company.code,
      role: 'chef',
      userName: chefName.trim()
    });
    res.status(201).json({ success: true, code: company.code, name: company.name });
  } catch (error) {
    next(error);
  }
});

app.post('/api/login/chef', loginLimiter, async (req, res, next) => {
  try {
    const { email, pass } = req.body;
    if (!validText(email, 255) || typeof pass !== 'string' || pass.length > 200) {
      return res.status(400).json({ error: 'E-Mail oder Passwort ist ungültig.' });
    }
    const company = await get('SELECT code, chef_name, chef_pass_hash FROM companies WHERE LOWER(chef_email) = LOWER(?)', [email.trim()]);
    const credentialHash = company ? company.chef_pass_hash : await dummyCredentialHash;
    const result = await verifySecret(pass, credentialHash);
    if (!company || !result.valid) return res.status(401).json({ error: 'E-Mail oder Passwort ist falsch.' });
    if (result.needsUpgrade) {
      await run('UPDATE companies SET chef_pass_hash = ? WHERE code = ?', [await hashSecret(pass), company.code]);
    }
    await regenerateSession(req, { companyCode: company.code, role: 'chef', userName: company.chef_name });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/login/worker', loginLimiter, async (req, res, next) => {
  try {
    const { code, email, pin } = req.body;
    if (!validText(code, 64) || !validText(email, 255) || typeof pin !== 'string' || pin.length > 32) {
      return res.status(400).json({ error: 'Firmen-Code, E-Mail oder PIN ist ungültig.' });
    }
    const worker = await get(
      `SELECT id, company_code, name, pin_hash FROM workers
       WHERE UPPER(company_code) = UPPER(?) AND LOWER(email) = LOWER(?)`,
      [code.trim(), email.trim()]
    );
    const credentialHash = worker ? worker.pin_hash : await dummyCredentialHash;
    const result = await verifySecret(pin, credentialHash);
    if (!worker || !result.valid) return res.status(401).json({ error: 'Firmen-Code, E-Mail oder PIN ist falsch.' });
    if (result.needsUpgrade) {
      await run('UPDATE workers SET pin_hash = ? WHERE id = ?', [await hashSecret(pin), worker.id]);
    }
    await regenerateSession(req, {
      companyCode: worker.company_code,
      role: 'mitarbeiter',
      userId: worker.id,
      userName: worker.name
    });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', requireAuth, async (req, res, next) => {
  try {
    await destroySession(req);
    res.clearCookie('einsatztakt.sid', { httpOnly: true, secure: production, sameSite: 'strict' });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/company/:code', requireAuth, async (req, res, next) => {
  try {
    const user = req.session.user;
    const code = req.params.code.toUpperCase();
    if (code !== user.companyCode) return res.status(403).json({ error: 'Kein Zugriff auf diese Firma.' });
    const company = await get(
      'SELECT code, name, branch, street, city FROM companies WHERE code = ?',
      [user.companyCode]
    );
    if (!company) return res.status(404).json({ error: 'Firma nicht gefunden.' });
    const isChef = user.role === 'chef';
    const workers = isChef
      ? await all('SELECT id, name, email FROM workers WHERE company_code = ? ORDER BY name', [user.companyCode])
      : [];
    const projects = await all(
      isChef
        ? 'SELECT id, name, budget FROM projects WHERE company_code = ? ORDER BY id'
        : 'SELECT id, name FROM projects WHERE company_code = ? ORDER BY id',
      [user.companyCode]
    );
    const logs = isChef
      ? await all(
        `SELECT id, worker_name AS worker, project_name AS project, hours, pause_mins AS pauseMins,
                log_date AS date, lat, lng
         FROM logs WHERE company_code = ? ORDER BY id DESC LIMIT 1000`,
        [user.companyCode]
      )
      : await all(
        `SELECT id, worker_name AS worker, project_name AS project, hours, pause_mins AS pauseMins,
                log_date AS date, lat, lng
         FROM logs WHERE company_code = ? AND (worker_id = ? OR (worker_id IS NULL AND worker_name = ?))
         ORDER BY id DESC LIMIT 1000`,
        [user.companyCode, user.userId, user.userName]
      );
    const tickets = isChef
      ? await all(
        `SELECT id, worker_name AS worker, subject, message, ticket_date AS date, status
         FROM tickets WHERE company_code = ? ORDER BY id DESC LIMIT 500`,
        [user.companyCode]
      )
      : [];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...company, workers, projects, logs, tickets });
  } catch (error) {
    next(error);
  }
});

app.post('/api/company/worker', requireRole('chef'), async (req, res, next) => {
  try {
    const { name, email, pin } = req.body;
    if (!validText(name, 255) || !validText(email, 255) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        typeof pin !== 'string' || !/^\d{8,12}$/.test(pin)) {
      return res.status(400).json({ error: 'Name und E-Mail sind erforderlich. Die PIN muss 8 bis 12 Ziffern enthalten.' });
    }
    const pinHash = await hashSecret(pin);
    const result = await run(
      'INSERT INTO workers (company_code, name, email, pin_hash) VALUES (?, ?, ?, ?)',
      [req.session.user.companyCode, name.trim(), email.trim().toLowerCase(), pinHash]
    );
    res.status(201).json({ success: true, worker: { id: result.lastID, name: name.trim(), email: email.trim().toLowerCase() } });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Diese Mitarbeiter-E-Mail ist bereits registriert.' });
    }
    next(error);
  }
});

app.post('/api/logs', requireRole('mitarbeiter'), async (req, res, next) => {
  try {
    const { projectId, hours, pauseMins, lat, lng } = req.body;
    if (!Number.isInteger(Number(projectId)) || !Number.isFinite(hours) || hours <= 0 || hours > 24 ||
        !Number.isInteger(pauseMins) || pauseMins < 0 || pauseMins > 1440 ||
        (lat !== null && lat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
        (lng !== null && lng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
      return res.status(400).json({ error: 'Der Zeiteintrag enthält ungültige Werte.' });
    }
    const user = req.session.user;
    const project = await get(
      'SELECT name FROM projects WHERE id = ? AND company_code = ?',
      [Number(projectId), user.companyCode]
    );
    if (!project) return res.status(400).json({ error: 'Das gewählte Projekt ist ungültig.' });
    const result = await run(
      `INSERT INTO logs (company_code, worker_id, worker_name, project_name, hours, pause_mins, log_date, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [user.companyCode, user.userId, user.userName, project.name, hours, pauseMins,
        new Date().toISOString().slice(0, 10), lat ?? null, lng ?? null]
    );
    res.status(201).json({ success: true, id: result.lastID });
  } catch (error) {
    next(error);
  }
});

app.post('/api/tickets', requireRole('mitarbeiter'), async (req, res, next) => {
  try {
    const { subject, message } = req.body;
    if (!validText(subject, 255) || !validText(message, 5000)) {
      return res.status(400).json({ error: 'Betreff und Nachricht sind erforderlich.' });
    }
    const result = await run(
      `INSERT INTO tickets (company_code, worker_name, subject, message, ticket_date)
       VALUES (?, ?, ?, ?, ?)`,
      [req.session.user.companyCode, req.session.user.userName, subject.trim(), message.trim(),
        new Date().toISOString().slice(0, 10)]
    );
    res.status(201).json({ success: true, id: result.lastID });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API-Endpunkt nicht gefunden.' }));
app.use((error, req, res, next) => {
  console.error('Anfragefehler:', error.message);
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Anfrage ist zu groß.' });
  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({ error: 'Ungültiges JSON.' });
  }
  res.status(500).json({ error: 'Interner Serverfehler.' });
});

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => console.log(`EinsatzTakt Backend läuft auf Port ${PORT}`));
  } catch (error) {
    console.error('Datenbankinitialisierung fehlgeschlagen:', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) start();

module.exports = { app, initializeDatabase, db };
