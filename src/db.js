const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'ADMIN',     -- see auth.ROLES
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  kra_pin TEXT, nssf_no TEXT, shif_no TEXT,
  address TEXT, phone TEXT, email TEXT, website TEXT
);

CREATE TABLE IF NOT EXISTS mail_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host TEXT, port INTEGER, secure INTEGER NOT NULL DEFAULT 0,
  username TEXT, password TEXT,
  from_email TEXT, from_name TEXT
);

-- Statutory rates and other scalar settings
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paye_bands (
  id INTEGER PRIMARY KEY,
  lower_limit REAL NOT NULL,
  upper_limit REAL,               -- NULL = no upper limit
  rate REAL NOT NULL              -- percent
);

CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sub_departments (
  id INTEGER PRIMARY KEY,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  UNIQUE (department_id, name)
);

CREATE TABLE IF NOT EXISTS designations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  emp_no TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  middle_name TEXT,
  last_name TEXT NOT NULL,
  gender TEXT,
  date_of_birth TEXT,
  id_number TEXT,
  kra_pin TEXT,
  nssf_no TEXT,
  shif_no TEXT,
  email TEXT,
  phone TEXT,
  department_id INTEGER REFERENCES departments(id),
  sub_department_id INTEGER REFERENCES sub_departments(id),
  designation_id INTEGER REFERENCES designations(id),
  hire_date TEXT NOT NULL,
  basic_salary REAL NOT NULL DEFAULT 0,
  insurance_premium REAL NOT NULL DEFAULT 0,  -- monthly premiums paid outside payroll, for insurance relief
  payment_mode TEXT NOT NULL DEFAULT 'BANK',
  bank_name TEXT, bank_branch TEXT, account_no TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','TERMINATED')),
  status_date TEXT,
  status_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Benefits and deductions share one definition table, distinguished by kind
CREATE TABLE IF NOT EXISTS pay_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('BENEFIT','DEDUCTION')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  calc_type TEXT NOT NULL CHECK (calc_type IN ('FIXED','PERCENT')),
  default_value REAL NOT NULL DEFAULT 0,  -- amount (FIXED) or % of basic salary (PERCENT)
  -- Benefit: 1 = adds to taxable pay. Deduction: 1 = after-tax, 0 = tax-exempt (reduces taxable pay)
  taxable INTEGER NOT NULL DEFAULT 1,
  insurance_relief INTEGER NOT NULL DEFAULT 0,  -- deduction is an insurance premium qualifying for relief
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, code)
);

CREATE TABLE IF NOT EXISTS employee_pay_items (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pay_item_id INTEGER NOT NULL REFERENCES pay_items(id) ON DELETE RESTRICT,
  value REAL NOT NULL,            -- overrides pay_items.default_value for this employee
  UNIQUE (employee_id, pay_item_id)
);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PROCESSED','POSTED')),
  processed_at TEXT, processed_by TEXT,
  posted_at TEXT, posted_by TEXT,
  UNIQUE (year, month)
);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY,
  period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  -- snapshot of employee details at processing time
  emp_no TEXT, employee_name TEXT, kra_pin TEXT, department TEXT, designation TEXT,
  monthly_basic REAL,              -- full monthly basic before proration
  days_worked INTEGER,
  days_in_period INTEGER,
  basic_salary REAL NOT NULL,      -- basic actually paid (prorated)
  total_benefits REAL NOT NULL,
  gross_pay REAL NOT NULL,
  nssf REAL NOT NULL,
  shif REAL NOT NULL,
  housing_levy REAL NOT NULL,
  exempt_deductions REAL NOT NULL,
  taxable_pay REAL NOT NULL,
  tax_charged REAL NOT NULL,
  personal_relief REAL NOT NULL,
  insurance_relief REAL NOT NULL DEFAULT 0,
  paye REAL NOT NULL,
  other_deductions REAL NOT NULL,
  total_deductions REAL NOT NULL,
  net_pay REAL NOT NULL,
  employer_nssf REAL NOT NULL,
  employer_housing_levy REAL NOT NULL,
  UNIQUE (period_id, employee_id)
);

CREATE TABLE IF NOT EXISTS payslip_lines (
  id INTEGER PRIMARY KEY,
  payslip_id INTEGER NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('EARNING','STATUTORY','DEDUCTION')),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  taxable INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  username TEXT,
  action TEXT NOT NULL,
  details TEXT
);

-- Posted payroll is immutable, enforced at the database level as well as in code
CREATE TRIGGER IF NOT EXISTS trg_period_posted_locked
BEFORE UPDATE ON payroll_periods
WHEN OLD.status = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Posted payroll periods cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS trg_period_posted_nodelete
BEFORE DELETE ON payroll_periods
WHEN OLD.status = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Posted payroll periods cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_payslip_posted_noupdate
BEFORE UPDATE ON payslips
WHEN (SELECT status FROM payroll_periods WHERE id = OLD.period_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Payslips of a posted period cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS trg_payslip_posted_nodelete
BEFORE DELETE ON payslips
WHEN (SELECT status FROM payroll_periods WHERE id = OLD.period_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Payslips of a posted period cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_payslip_posted_noinsert
BEFORE INSERT ON payslips
WHEN (SELECT status FROM payroll_periods WHERE id = NEW.period_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Cannot add payslips to a posted period'); END;

CREATE TRIGGER IF NOT EXISTS trg_line_posted_locked
BEFORE DELETE ON payslip_lines
WHEN (SELECT p.status FROM payslips s JOIN payroll_periods p ON p.id = s.period_id WHERE s.id = OLD.payslip_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Payslip lines of a posted period cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS trg_line_posted_noupdate
BEFORE UPDATE ON payslip_lines
WHEN (SELECT p.status FROM payslips s JOIN payroll_periods p ON p.id = s.period_id WHERE s.id = OLD.payslip_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Payslip lines of a posted period cannot be changed'); END;
`;

// Kenyan statutory defaults (monthly). Verify against current KRA / SHA / NSSF notices.
const DEFAULT_SETTINGS = {
  personal_relief: '2400',
  insurance_relief_rate: '15',    // % of qualifying premiums
  insurance_relief_cap: '5000',   // max monthly insurance relief
  pension_relief_cap: '30000',   // max monthly allowable pension contribution (NSSF + exempt deductions)
  shif_rate: '2.75',
  shif_minimum: '300',
  shif_tax_deductible: '1',
  nssf_rate: '6',
  nssf_lower_limit: '8000',     // Tier I ceiling (LEL)
  nssf_upper_limit: '72000',    // Tier II ceiling (UEL)
  housing_levy_enabled: '1',
  housing_levy_rate: '1.5',
  housing_levy_tax_deductible: '1',
  proration_enabled: '1',             // prorate pay for mid-month joiners and leavers (calendar days)
  post_requires_different_user: '0',  // four-eyes: the user who processed cannot post
};

// Columns added after the first release; ALTERed into existing databases on startup
const MIGRATIONS = [
  ['users', 'email', 'TEXT'],
  ['users', 'role', "TEXT NOT NULL DEFAULT 'ADMIN'"],
  ['users', 'active', 'INTEGER NOT NULL DEFAULT 1'],
  ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'last_login_at', 'TEXT'],
  ['employees', 'insurance_premium', 'REAL NOT NULL DEFAULT 0'],
  ['pay_items', 'insurance_relief', 'INTEGER NOT NULL DEFAULT 0'],
  ['payslips', 'monthly_basic', 'REAL'],
  ['payslips', 'days_worked', 'INTEGER'],
  ['payslips', 'days_in_period', 'INTEGER'],
  ['payslips', 'insurance_relief', 'REAL NOT NULL DEFAULT 0'],
];

const DEFAULT_PAYE_BANDS = [
  [0, 24000, 10],
  [24000, 32333, 25],
  [32333, 500000, 30],
  [500000, 800000, 32.5],
  [800000, null, 35],
];

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

function migrate(db) {
  for (const [table, column, type] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function seed(db) {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

  if (db.prepare('SELECT COUNT(*) AS n FROM paye_bands').get().n === 0) {
    const ins = db.prepare('INSERT INTO paye_bands (lower_limit, upper_limit, rate) VALUES (?, ?, ?)');
    for (const b of DEFAULT_PAYE_BANDS) ins.run(...b);
  }
  db.prepare("INSERT OR IGNORE INTO company (id, name) VALUES (1, 'My Company Ltd')").run();
  db.prepare('INSERT OR IGNORE INTO mail_settings (id, port, secure) VALUES (1, 587, 0)').run();

  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    db.prepare(`INSERT INTO users (username, full_name, password_hash, role, must_change_password)
      VALUES (?, ?, ?, 'ADMIN', 1)`).run('admin', 'Administrator', hashPassword('admin123'));
  }
}

// Runs fn inside a transaction; rolls back on any thrown error.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getSettings(db) {
  const out = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = Number(row.value);
  return out;
}

function audit(db, username, action, details) {
  db.prepare('INSERT INTO audit_log (username, action, details) VALUES (?, ?, ?)')
    .run(username || null, action, details || null);
}

module.exports = { open, transaction, getSettings, audit, DEFAULT_SETTINGS };
