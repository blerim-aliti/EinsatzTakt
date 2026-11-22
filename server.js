const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

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
    });
  }

  db.serialize(() => {
    db.run(`ALTER TABLE companies ADD COLUMN gps_enabled INTEGER DEFAULT 1`, () => {});
    db.run(`ALTER TABLE logs ADD COLUMN vehicle_info TEXT`, () => {});
    db.run(`CREATE TABLE IF NOT EXISTS vehicles (
      id TEXT PRIMARY KEY,
      company_code VARCHAR(10) REFERENCES companies(code) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      plate VARCHAR(50) NOT NULL,
      category VARCHAR(20) NOT NULL DEFAULT 'fixed',
      barcode VARCHAR(100) DEFAULT '',
      current_km INTEGER DEFAULT 0,
      assigned_worker_email VARCHAR(255) DEFAULT '',
      gps_enabled INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS vehicle_trips (
      id TEXT PRIMARY KEY,
      company_code VARCHAR(10) REFERENCES companies(code) ON DELETE CASCADE,
      vehicle_id TEXT,
      vehicle_name VARCHAR(255) NOT NULL,
      plate VARCHAR(50) NOT NULL,
      barcode VARCHAR(100) DEFAULT '',
      driver_name VARCHAR(255) NOT NULL,
      km_start INTEGER DEFAULT 0,
      km_end INTEGER DEFAULT 0,
      km_driven INTEGER DEFAULT 0,
      timestamp_ms INTEGER NOT NULL,
      date_str VARCHAR(100) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  });
}

function seedDefaultVehiclesIfEmpty(companyCode, cb) {
  db.get(`SELECT COUNT(*) AS cnt FROM vehicles WHERE company_code = ?`, [companyCode], (err, row) => {
    if (err || !row || row.cnt > 0) return cb();
    const stmt = db.prepare(`INSERT INTO vehicles (id, company_code, name, plate, category, barcode, current_km, assigned_worker_email, gps_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    stmt.run('veh-fixed-' + companyCode, companyCode, 'Dienstwagen Sprinter (Fest)', 'B-ET 101', 'fixed', '', 42150, '', 1);
    stmt.run('veh-pool-' + companyCode, companyCode, 'Springer Golf Kombi (Pool)', 'B-ET 202', 'pool', 'CAR-202', 68400, '', 1);
    stmt.finalize(cb);
  });
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'EinsatzTakt Backend' });
});

app.post('/api/register', (req, res) => {
  const { name, branch, street, city, phone, chefName, email, pass } = req.body;
  if (!name || !chefName || !email || !pass) {
    return res.status(400).json({ error: 'Bitte alle Pflichtfelder ausfüllen.' });
  }
  const code = 'ET-' + Math.floor(1000 + Math.random() * 9000);
  const sql = `INSERT INTO companies (code, name, branch, street, city, phone, chef_name, chef_email, chef_pass, gps_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`;

  db.run(sql, [code, name, branch || '', street || '', city || '', phone || '', chefName, email, pass], function (err) {
    if (err) {
      return res.status(400).json({ error: 'Diese E-Mail-Adresse ist bereits registriert.' });
    }
    db.run(`INSERT INTO projects (company_code, name, budget) VALUES (?, ?, ?)`, [code, 'Hauptprojekt / Allgemein', 10000]);
    seedDefaultVehiclesIfEmpty(code, () => {
      res.json({ success: true, code, name });
    });
  });
});

app.post('/api/login/chef', (req, res) => {
  const { email, pass } = req.body;
  db.get(`SELECT * FROM companies WHERE LOWER(chef_email) = LOWER(?) AND chef_pass = ?`, [email, pass], (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'E-Mail oder Passwort ist falsch.' });
    res.json({ success: true, companyCode: row.code, role: 'chef' });
  });
});

app.post('/api/login/worker', (req, res) => {
  const { code, email, pin } = req.body;
  db.get(`SELECT * FROM workers WHERE UPPER(company_code) = UPPER(?) AND LOWER(email) = LOWER(?) AND pin = ?`, [code, email, pin], (err, row) => {
    if (err || !row) return res.status(401).json({ error: 'Firmen-Code, E-Mail oder PIN ist falsch.' });
    res.json({ success: true, companyCode: row.company_code, role: 'mitarbeiter', userName: row.name });
  });
});

app.get('/api/company/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  db.get(`SELECT code, name, branch, street, city, phone, chef_name, chef_email, gps_enabled FROM companies WHERE code = ?`, [code], (err, company) => {
    if (!company) return res.status(404).json({ error: 'Firma nicht gefunden.' });

    seedDefaultVehiclesIfEmpty(code, () => {
      db.all(`SELECT id, name, email, pin FROM workers WHERE company_code = ?`, [code], (err, workers = []) => {
        db.all(`SELECT id, name, budget FROM projects WHERE company_code = ?`, [code], (err, projects = []) => {
          db.all(`SELECT id, worker_name AS worker, project_name AS project, hours, pause_mins AS pauseMins, vehicle_info AS vehicleInfo, log_date AS date, lat, lng FROM logs WHERE company_code = ? ORDER BY id DESC`, [code], (err, logs = []) => {
            db.all(`SELECT id, worker_name AS worker, subject, message, ticket_date AS date, status FROM tickets WHERE company_code = ? ORDER BY id DESC`, [code], (err, tickets = []) => {
              db.all(`SELECT id, name, plate, category, barcode, current_km AS currentKm, assigned_worker_email AS assignedWorkerEmail, gps_enabled AS gpsEnabled FROM vehicles WHERE company_code = ? ORDER BY created_at DESC`, [code], (err, vehicles = []) => {
                const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                db.all(`SELECT id, vehicle_id AS vehicleId, vehicle_name AS vehicleName, plate, barcode, driver_name AS driver, km_start AS kmStart, km_end AS kmEnd, km_driven AS kmDriven, timestamp_ms AS timestamp, date_str AS dateStr FROM vehicle_trips WHERE company_code = ? AND timestamp_ms >= ? ORDER BY timestamp_ms DESC`, [code, sevenDaysAgo], (err, vehicleTrips = []) => {
                  const formattedLogs = logs.map(l => ({
                    ...l,
                    gps: (l.lat && l.lng) ? { lat: l.lat, lng: l.lng } : null
                  }));
                  res.json({
                    ...company,
                    gpsEnabled: company.gps_enabled !== 0,
                    workers,
                    projects,
                    logs: formattedLogs,
                    tickets,
                    vehicles: vehicles.map(v => ({ ...v, gpsEnabled: v.gpsEnabled !== 0 })),
                    vehicleTrips
                  });
                });
              });
            });
          });
        });
      });
    });
  });
});

app.put('/api/company/:code/gps', (req, res) => {
  const code = req.params.code.toUpperCase();
  const gpsVal = req.body.gpsEnabled ? 1 : 0;
  db.run(`UPDATE companies SET gps_enabled = ? WHERE code = ?`, [gpsVal, code], function (err) {
    if (err) return res.status(400).json({ error: 'GPS-Einstellung konnte nicht gespeichert werden.' });
    res.json({ success: true, gpsEnabled: !!gpsVal });
  });
});

app.delete('/api/company/:code/gps-data', (req, res) => {
  const code = req.params.code.toUpperCase();
  db.serialize(() => {
    db.run(`UPDATE companies SET gps_enabled = 0 WHERE code = ?`, [code]);
    db.run(`UPDATE vehicles SET gps_enabled = 0 WHERE company_code = ?`, [code]);
    db.run(`UPDATE logs SET lat = NULL, lng = NULL WHERE company_code = ?`, [code], function (err) {
      if (err) return res.status(400).json({ error: 'GPS-Daten konnten nicht gelöscht werden.' });
      res.json({ success: true });
    });
  });
});

app.get('/api/company/:code/vehicles', (req, res) => {
  const code = req.params.code.toUpperCase();
  seedDefaultVehiclesIfEmpty(code, () => {
    db.all(`SELECT id, name, plate, category, barcode, current_km AS currentKm, assigned_worker_email AS assignedWorkerEmail, gps_enabled AS gpsEnabled FROM vehicles WHERE company_code = ? ORDER BY created_at DESC`, [code], (err, rows = []) => {
      if (err) return res.status(400).json({ error: 'Fahrzeuge konnten nicht geladen werden.' });
      res.json(rows.map(v => ({ ...v, gpsEnabled: v.gpsEnabled !== 0 })));
    });
  });
});

app.post('/api/company/:code/vehicles', (req, res) => {
  const code = req.params.code.toUpperCase();
  const { id, name, plate, category, barcode, currentKm, assignedWorkerEmail, gpsEnabled } = req.body;
  if (!name || !plate) return res.status(400).json({ error: 'Fahrzeugname und Kennzeichen erforderlich.' });
  const vehId = id || ('veh-' + Date.now());
  db.run(
    `INSERT INTO vehicles (id, company_code, name, plate, category, barcode, current_km, assigned_worker_email, gps_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [vehId, code, name, plate.toUpperCase(), category || 'fixed', (barcode || '').toUpperCase(), parseInt(currentKm, 10) || 0, assignedWorkerEmail || '', gpsEnabled === false ? 0 : 1],
    function (err) {
      if (err) return res.status(400).json({ error: 'Fahrzeug konnte nicht gespeichert werden.' });
      res.json({ success: true, id: vehId });
    }
  );
});

app.patch('/api/company/:code/vehicles/:vehicleId/gps', (req, res) => {
  const code = req.params.code.toUpperCase();
  const { vehicleId } = req.params;
  const gpsVal = req.body.gpsEnabled ? 1 : 0;
  db.run(`UPDATE vehicles SET gps_enabled = ? WHERE company_code = ? AND id = ?`, [gpsVal, code, vehicleId], function (err) {
    if (err) return res.status(400).json({ error: 'Fahrzeug-GPS konnte nicht aktualisiert werden.' });
    res.json({ success: true, gpsEnabled: !!gpsVal });
  });
});

app.delete('/api/company/:code/vehicles/:vehicleId', (req, res) => {
  const code = req.params.code.toUpperCase();
  const { vehicleId } = req.params;
  db.run(`DELETE FROM vehicles WHERE company_code = ? AND id = ?`, [code, vehicleId], function (err) {
    if (err) return res.status(400).json({ error: 'Fahrzeug konnte nicht gelöscht werden.' });
    res.json({ success: true });
  });
});

app.get('/api/company/:code/vehicle-trips', (req, res) => {
  const code = req.params.code.toUpperCase();
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  db.all(
    `SELECT id, vehicle_id AS vehicleId, vehicle_name AS vehicleName, plate, barcode, driver_name AS driver, km_start AS kmStart, km_end AS kmEnd, km_driven AS kmDriven, timestamp_ms AS timestamp, date_str AS dateStr FROM vehicle_trips WHERE company_code = ? AND timestamp_ms >= ? ORDER BY timestamp_ms DESC`,
    [code, sevenDaysAgo],
    (err, rows = []) => {
      if (err) return res.status(400).json({ error: 'Fahrtenbuch konnte nicht geladen werden.' });
      res.json(rows);
    }
  );
});

app.post('/api/company/:code/vehicle-trips', (req, res) => {
  const code = req.params.code.toUpperCase();
  const { id, vehicleId, vehicleName, plate, barcode, driver, kmStart, kmEnd, kmDriven, timestamp, dateStr } = req.body;
  const tripId = id || ('trip-' + Date.now());
  const startNum = parseInt(kmStart, 10) || 0;
  const endNum = parseInt(kmEnd, 10) || startNum;
  const drivenNum = typeof kmDriven === 'number' ? kmDriven : Math.max(0, endNum - startNum);
  const tsNum = timestamp || Date.now();
  const dStr = dateStr || new Date(tsNum).toLocaleString('de-DE');

  db.serialize(() => {
    db.run(
      `INSERT INTO vehicle_trips (id, company_code, vehicle_id, vehicle_name, plate, barcode, driver_name, km_start, km_end, km_driven, timestamp_ms, date_str) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tripId, code, vehicleId || '', vehicleName || '', plate || '', barcode || '', driver || '', startNum, endNum, drivenNum, tsNum, dStr]
    );
    if (vehicleId && endNum > 0) {
      db.run(`UPDATE vehicles SET current_km = ? WHERE company_code = ? AND id = ?`, [endNum, code, vehicleId]);
    }
    res.json({ success: true, id: tripId });
  });
});

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

app.post('/api/logs', (req, res) => {
  const { companyCode, worker, project, hours, pauseMins, vehicleInfo, date, lat, lng } = req.body;
  db.run(
    `INSERT INTO logs (company_code, worker_name, project_name, hours, pause_mins, vehicle_info, log_date, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyCode.toUpperCase(), worker, project, hours, pauseMins || 0, vehicleInfo || '', date, lat || null, lng || null],
    function (err) {
      if (err) return res.status(400).json({ error: 'Zeiteintrag konnte nicht gespeichert werden.' });
      res.json({ success: true, id: this.lastID });
    }
  );
});

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
