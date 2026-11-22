const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { after, test } = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'einsatztakt-security-'));
process.env.DB_PATH = path.join(temporaryDirectory, 'test.sqlite');
process.env.SESSION_SECRET = 'test-session-secret-with-more-than-32-characters';

function createLegacyDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(process.env.DB_PATH);
    db.exec(`
      CREATE TABLE companies (
        code VARCHAR(10) PRIMARY KEY, name TEXT NOT NULL, branch TEXT, street TEXT, city TEXT,
        phone TEXT, chef_name TEXT NOT NULL, chef_email TEXT UNIQUE NOT NULL,
        chef_pass VARCHAR(255) NOT NULL
      );
      CREATE TABLE workers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, company_code VARCHAR(10) REFERENCES companies(code),
        name TEXT NOT NULL, email TEXT NOT NULL, pin VARCHAR(10) NOT NULL,
        UNIQUE(company_code, email)
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT, company_code VARCHAR(10), name TEXT NOT NULL,
        budget DECIMAL(10,2) DEFAULT 0
      );
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, company_code VARCHAR(10), worker_name TEXT NOT NULL,
        project_name TEXT NOT NULL, hours DECIMAL(5,2) NOT NULL, pause_mins INT DEFAULT 0,
        log_date DATE NOT NULL, lat VARCHAR(50), lng VARCHAR(50)
      );
      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, company_code VARCHAR(10), worker_name TEXT NOT NULL,
        subject TEXT NOT NULL, message TEXT NOT NULL, ticket_date DATE NOT NULL,
        status VARCHAR(50) DEFAULT 'offen'
      );
      INSERT INTO companies (code, name, chef_name, chef_email, chef_pass)
        VALUES ('ET-1234', 'Legacy GmbH', 'Chef Legacy', 'chef@example.test', 'legacy-password');
      INSERT INTO workers (company_code, name, email, pin)
        VALUES ('ET-1234', 'Worker Legacy', 'worker@example.test', '1234');
      INSERT INTO workers (company_code, name, email, pin)
        VALUES ('ET-1234', 'Other Worker', 'other@example.test', '5678');
      INSERT INTO projects (company_code, name, budget)
        VALUES ('ET-1234', 'Baustelle A', 1000);
      INSERT INTO logs (company_code, worker_name, project_name, hours, log_date)
        VALUES ('ET-1234', 'Worker Legacy', 'Baustelle A', 8, '2026-11-22');
      INSERT INTO logs (company_code, worker_name, project_name, hours, log_date)
        VALUES ('ET-1234', 'Other Worker', 'Baustelle A', 8, '2026-11-22');
    `, error => {
      db.close(closeError => {
        if (error || closeError) reject(error || closeError);
        else resolve();
      });
    });
  });
}

function databaseGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

let server;
let service;
let baseUrl;

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (service?.db) await new Promise(resolve => service.db.close(resolve));
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('secures legacy data, tenant APIs, and role-specific actions', async () => {
  await createLegacyDatabase();
  service = require('../server');
  await service.initializeDatabase();
  assert.equal(fs.statSync(process.env.DB_PATH).mode & 0o777, 0o600);
  server = service.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = async (endpoint, { method = 'GET', body, cookie, origin } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const payload = await response.json();
    return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };

  const unauthorized = await call('/api/company/ET-1234');
  assert.equal(unauthorized.response.status, 401);
  const csrf = await call('/api/login/chef', {
    method: 'POST',
    body: { email: 'chef@example.test', pass: 'legacy-password' },
    origin: 'https://attacker.example'
  });
  assert.equal(csrf.response.status, 403);

  const storedPassword = await databaseGet(service.db, 'SELECT chef_pass_hash FROM companies WHERE code = ?', ['ET-1234']);
  const storedPin = await databaseGet(service.db, 'SELECT pin_hash FROM workers WHERE email = ?', ['worker@example.test']);
  assert.match(storedPassword.chef_pass_hash, /^scrypt\$/);
  assert.match(storedPin.pin_hash, /^scrypt\$/);

  const chefLogin = await call('/api/login/chef', {
    method: 'POST',
    body: { email: 'chef@example.test', pass: 'legacy-password' }
  });
  assert.equal(chefLogin.response.status, 200);
  const chefCookie = chefLogin.cookie;
  const chefData = await call('/api/company/ET-1234', { cookie: chefCookie });
  assert.equal(chefData.response.status, 200);
  assert.equal(chefData.payload.workers.length, 2);
  assert.equal('pin' in chefData.payload.workers[0], false);
  assert.equal('pin_hash' in chefData.payload.workers[0], false);
  assert.equal('chef_pass_hash' in chefData.payload, false);

  const wrongTenant = await call('/api/company/ET-OTHER', { cookie: chefCookie });
  assert.equal(wrongTenant.response.status, 403);

  const registration = await call('/api/register', {
    method: 'POST',
    body: {
      name: 'New Company',
      branch: 'Handwerk',
      street: 'Musterstraße 1',
      city: 'Berlin',
      phone: '+49 30 123456',
      chefName: 'New Chef',
      email: 'new-chef@example.test',
      pass: 'a-strong-password-2026'
    }
  });
  assert.equal(registration.response.status, 201);
  assert.match(registration.payload.code, /^ET-[A-F0-9]{32}$/);
  const newCompanyHash = await databaseGet(
    service.db,
    'SELECT chef_pass_hash FROM companies WHERE code = ?',
    [registration.payload.code]
  );
  assert.match(newCompanyHash.chef_pass_hash, /^scrypt\$/);
  const secondTenantAccess = await call('/api/company/ET-1234', { cookie: registration.cookie });
  assert.equal(secondTenantAccess.response.status, 403);
  const duplicateEmail = await call('/api/register', {
    method: 'POST',
    body: {
      name: 'Duplicate Company',
      chefName: 'Duplicate Chef',
      email: 'NEW-CHEF@example.test',
      pass: 'another-strong-password'
    }
  });
  assert.equal(duplicateEmail.response.status, 409);

  const weakPin = await call('/api/company/worker', {
    method: 'POST',
    cookie: chefCookie,
    body: { name: 'Weak PIN', email: 'weak@example.test', pin: '1234' }
  });
  assert.equal(weakPin.response.status, 400);

  const addWorker = await call('/api/company/worker', {
    method: 'POST',
    cookie: chefCookie,
    body: { name: 'New Worker', email: 'new@example.test', pin: '01234567' }
  });
  assert.equal(addWorker.response.status, 201);
  assert.equal('pin' in addWorker.payload.worker, false);

  const workerLogin = await call('/api/login/worker', {
    method: 'POST',
    body: { code: 'ET-1234', email: 'worker@example.test', pin: '1234' }
  });
  assert.equal(workerLogin.response.status, 200);
  const workerCookie = workerLogin.cookie;
  const workerData = await call('/api/company/ET-1234', { cookie: workerCookie });
  assert.equal(workerData.response.status, 200);
  assert.equal(workerData.payload.logs.length, 1);
  assert.equal(workerData.payload.logs[0].worker, 'Worker Legacy');
  assert.equal('budget' in workerData.payload.projects[0], false);
  assert.deepEqual(workerData.payload.workers, []);
  assert.deepEqual(workerData.payload.tickets, []);

  const workerCannotAdd = await call('/api/company/worker', {
    method: 'POST',
    cookie: workerCookie,
    body: { name: 'Intruder', email: 'intruder@example.test', pin: '12345678' }
  });
  assert.equal(workerCannotAdd.response.status, 403);

  const savedLog = await call('/api/logs', {
    method: 'POST',
    cookie: workerCookie,
    body: { projectId: workerData.payload.projects[0].id, hours: 7.5, pauseMins: 30, lat: 52.5, lng: 13.4 }
  });
  assert.equal(savedLog.response.status, 201);

  const ticket = await call('/api/tickets', {
    method: 'POST',
    cookie: workerCookie,
    body: { subject: 'Anfrage', message: 'Bitte prüfen.' }
  });
  assert.equal(ticket.response.status, 201);

  const workerCannotReadOthers = await call('/api/company/ET-1234', { cookie: workerCookie });
  assert.equal(workerCannotReadOthers.payload.logs.some(log => log.worker === 'Other Worker'), false);

  const logout = await call('/api/logout', { method: 'POST', cookie: workerCookie, body: {} });
  assert.equal(logout.response.status, 200);
  const afterLogout = await call('/api/session', { cookie: workerCookie });
  assert.equal(afterLogout.response.status, 401);

  const page = await fetch(`${baseUrl}/`);
  const html = await page.text();
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  assert.doesNotMatch(html, /onclick=|onsubmit=|localStorage|cdn\.tailwindcss\.com|unpkg\.com|emailjs/);
  assert.match(html, /<a href="#vorteile"[^>]*>Vorteile<\/a>/);
  assert.match(html, /<section id="vorteile"/);
  assert.match(html, /hero-scene/);
});
