CREATE TABLE IF NOT EXISTS companies (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    branch TEXT,
    street TEXT,
    city TEXT,
    phone TEXT,
    chef_name TEXT NOT NULL,
    chef_email TEXT UNIQUE NOT NULL,
    chef_pass_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_code, email)
);

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    name TEXT NOT NULL,
    budget DECIMAL(10,2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    worker_id INTEGER REFERENCES workers(id),
    worker_name TEXT NOT NULL,
    project_name TEXT NOT NULL,
    hours DECIMAL(5,2) NOT NULL,
    pause_mins INT DEFAULT 0,
    log_date DATE NOT NULL,
    lat VARCHAR(50),
    lng VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_code TEXT NOT NULL REFERENCES companies(code) ON DELETE CASCADE,
    worker_name TEXT NOT NULL,
    subject VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    ticket_date DATE NOT NULL,
    status VARCHAR(50) DEFAULT 'offen',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
