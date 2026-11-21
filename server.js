const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Erlaubt Anfragen von deiner Domain einsatztakt.de sowie lokalem Testen
const allowedOrigins = [
  'https://einsatztakt.de',
  'https://www.einsatztakt.de',
  'http://localhost:3000',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Nicht durch CORS erlaubt'));
    }
  }
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Datenbank initialisieren
const dbPath = process.env.DB_PATH || path.join(__dirname, 'einsatztakt.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Datenbankfehler:', err.message);
  } else {
    console.log('Mit SQLite-Datenbank verbunden:', dbPath);
    initDb();
  }
});

function initDb() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema, (err) => {
      if (err) console.error('Schema-Fehler:', err.message);
      else console.log('Datenbank-Tabellen sind bereit.');
    });
  }
}

// Health-Check zum Prüfen, ob das Backend läuft
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'EinsatzTakt Backend' });
});

// 1. Firma registrieren
app.post('/api/register', (req, res) => {
  const { name, branch, street, city, phone, chefName, email, pass } = req.body;
  if (!name || !chefName || !email || !pass) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }

  const code = 'ET-' + Math.floor(1000 + Math.random() * 9000);
  const sql = `INSERT INTO companies (code, name, branch, street, city, phone, chef_name, chef_email, chef_pass) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sql, [code, name, branch || '', street || '', city || '', phone || '', chefName, email, pass], function (err) {
    if (err) {
      return res.status(400).json({ error: 'Diese E-Mail-Adresse ist bereits registriert.' });
    }
    db.run(`INSERT INTO projects (company_code, name, budget) VALUES (?, ?, ?)`, [code, 'Hauptprojekt / Allgemein', 10000]);
    res.json({ success: true, code, name });
  });
});

// 2. Chef Login
app.post('/api/login/chef', (req, res) => {
  const { email, pass } = req.body;
  db.get(`SELECT * FROM companies WHERE LOWER(chef_email) = LOWER(?) AND chef_pass = ?`, [email, pass], (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'E-Mail oder Passwort ist falsch.' });
    res.json({ success: true, companyCode: row.code, role: 'chef' });
  });
});

// 3. Mitarbeiter Login
app.post('/api/login/worker', (req, res) => {
  const { code, email, pin } = req.body;
  db.get(`SELECT * FROM workers WHERE UPPER(company_code) = UPPER(?) AND LOWER(email) = LOWER(?) AND pin = ?`, [code, email, pin], (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'Firmen-Code, E-Mail oder PIN ist falsch.' });
    res.json({ success: true, companyCode: row.company_code, role: 'mitarbeiter', userName: row.name });
  });
});

// 4. Firmendaten laden
app.get('/api/company/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  db.get(`SELECT code, name, branch, street, city, phone, chef_name, chef_email FROM companies WHERE code = ?`, [code], (err, company) => {
    if (!company) return res.status(404).json({ error: 'Firma nicht gefunden.' });

    db.all(`SELECT id, name, email, pin FROM workers WHERE company_code = ?`, [code], (err, workers = []) => {
      db.all(`SELECT id, name, budget FROM projects WHERE company_code = ?`, [code], (err, projects = []) => {
        db.all(`SELECT id, worker_name AS worker, project_name AS project, hours, pause_mins AS pauseMins, log_date AS date, lat, lng FROM logs WHERE company_code = ? ORDER BY id DESC`, [code], (err, logs = []) => {
          db.all(`SELECT id, worker_name AS worker, subject, message, ticket_date AS date, status FROM tickets WHERE company_code = ? ORDER BY id DESC`, [code], (err, tickets = []) => {
            res.json({ ...company, workers, projects, logs, tickets });
          });
        });
      });
    });
  });
});

// 5. Mitarbeiter anlegen
app.post('/api/company/worker', (req, res) => {
  const { companyCode, name, email, pin } = req.body;
  if (!companyCode || !name || !email || !pin) {
    return res.status(400).json({ error: 'Fehlende Mitarbeiterdaten.' });
  }
  db.run(`INSERT INTO workers (company_code, name, email, pin) VALUES (?, ?, ?, ?)`, [companyCode.toUpperCase(), name, email, pin], function (err) {
    if (err) return res.status(400).json({ error: 'Mitarbeiter konnte nicht angelegt werden.' });
    res.json({ success: true, id: this.lastID });
  });
});

// 6. Arbeitszeit & Pause speichern
app.post('/api/logs', (req, res) => {
  const { companyCode, worker, project, hours, pauseMins, date, lat, lng } = req.body;
  db.run(
    `INSERT INTO logs (company_code, worker_name, project_name, hours, pause_mins, log_date, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyCode.toUpperCase(), worker, project, hours, pauseMins || 0, date, lat || null, lng || null],
    function (err) {
      if (err) return res.status(400).json({ error: 'Zeiteintrag konnte nicht gespeichert werden.' });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// 7. Support-Ticket speichern
app.post('/api/tickets', (req, res) => {
  const { companyCode, worker, subject, message, date } = req.body;
  db.run(
    `INSERT INTO tickets (company_code, worker_name, subject, message, ticket_date) VALUES (?, ?, ?, ?, ?)`,
    [companyCode.toUpperCase(), worker, subject, message, date],
    function (err) {
      if (err) return res.status(400).json({ error: 'Ticket konnte nicht gespeichert werden.' });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});