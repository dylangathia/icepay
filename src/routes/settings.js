const express = require('express');
const { audit, transaction, getSettings, DEFAULT_SETTINGS } = require('../db');
const { action, flash, str, num, int, bool, UserError } = require('../util');
const { sendMail } = require('../mail');
const { can, requirePermission } = require('../auth');
const { periodName } = require('../payroll/service');

const router = express.Router();
const user = (req) => req.session.user.username;

// Settings sections and the permission each needs; anything else needs settings.manage
const SECTIONS = [
  ['company', 'settings.manage'], ['statutory', 'settings.manage'], ['periods', 'periods.manage'],
  ['departments', 'settings.manage'], ['designations', 'settings.manage'], ['mail', 'settings.manage'],
  ['users', 'users.manage'], ['audit', 'audit.view'],
];
router.use((req, res, next) => {
  const section = req.path.split('/')[1];
  if (!section) return next();
  const permission = SECTIONS.find(([s]) => s === section)?.[1] || 'settings.manage';
  return requirePermission(permission)(req, res, next);
});

router.get('/', (req, res) => {
  const first = SECTIONS.find(([, permission]) => can(req.session.user, permission));
  if (!first) return res.status(403).render('error', { title: 'Access denied', message: 'You do not have access to settings.' });
  res.redirect(`/settings/${first[0]}`);
});

router.use('/users', require('./users'));

// ---- Company ----
const COMPANY_FIELDS = ['name', 'kra_pin', 'nssf_no', 'shif_no', 'address', 'phone', 'email', 'website'];

router.get('/company', (req, res) => {
  const companyInfo = req.app.locals.db.prepare('SELECT * FROM company WHERE id = 1').get();
  res.render('settings/company', { title: 'Company setup', companyInfo });
});

router.post('/company', action((req, res) => {
  const db = req.app.locals.db;
  const c = Object.fromEntries(COMPANY_FIELDS.map((f) => [f, str(req.body[f])]));
  if (!c.name) throw new UserError('Company name is required.');
  db.prepare(`UPDATE company SET ${COMPANY_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = 1`)
    .run(...COMPANY_FIELDS.map((f) => c[f]));
  audit(db, user(req), 'COMPANY_UPDATED');
  flash(req, 'success', 'Company details saved.');
  res.redirect('/settings/company');
}));

// ---- Mail server ----
router.get('/mail', (req, res) => {
  const mail = req.app.locals.db.prepare('SELECT * FROM mail_settings WHERE id = 1').get();
  res.render('settings/mail', { title: 'Mail server', mail });
});

router.post('/mail', action((req, res) => {
  const db = req.app.locals.db;
  const password = str(req.body.password);
  db.prepare(`UPDATE mail_settings SET host = ?, port = ?, secure = ?, username = ?, from_email = ?, from_name = ?
    ${password ? ', password = ?' : ''} WHERE id = 1`)
    .run(str(req.body.host), int(req.body.port), bool(req.body.secure), str(req.body.username),
      str(req.body.from_email), str(req.body.from_name), ...(password ? [password] : []));
  audit(db, user(req), 'MAIL_SETTINGS_UPDATED');
  flash(req, 'success', 'Mail settings saved.');
  res.redirect('/settings/mail');
}));

router.post('/mail/test', action(async (req, res) => {
  const to = str(req.body.to);
  if (!to) throw new UserError('Enter an address to send the test email to.');
  try {
    await sendMail(req.app.locals.db, { to, subject: 'IcePay test email', html: '<p>Your mail server settings work.</p>' });
  } catch (err) {
    throw new UserError(`Test email failed: ${err.message}`);
  }
  flash(req, 'success', `Test email sent to ${to}.`);
  res.redirect('/settings/mail');
}));

// ---- Statutory: PAYE bands, SHIF, NSSF, Housing Levy ----
router.get('/statutory', (req, res) => {
  const db = req.app.locals.db;
  const bands = db.prepare('SELECT * FROM paye_bands ORDER BY lower_limit').all();
  const processed = db.prepare("SELECT * FROM payroll_periods WHERE status = 'PROCESSED'").all();
  res.render('settings/statutory', { title: 'Statutory deductions', s: getSettings(db), bands, processed });
});

router.post('/statutory', action((req, res) => {
  const db = req.app.locals.db;
  const flags = ['shif_tax_deductible', 'housing_levy_enabled', 'housing_levy_tax_deductible',
    'proration_enabled', 'post_requires_different_user'];
  const values = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    values[key] = flags.includes(key) ? bool(req.body[key]) : num(req.body[key]);
    if (values[key] < 0) throw new UserError(`${key.replace(/_/g, ' ')} cannot be negative.`);
  }
  if (values.nssf_upper_limit < values.nssf_lower_limit) throw new UserError('NSSF upper limit must be above the lower limit.');
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  transaction(db, () => {
    for (const [key, value] of Object.entries(values)) update.run(String(value), key);
  });
  audit(db, user(req), 'STATUTORY_UPDATED');
  flash(req, 'success', 'Statutory rates saved. They apply the next time payroll is processed.');
  res.redirect('/settings/statutory');
}));

router.post('/statutory/bands', action((req, res) => {
  const db = req.app.locals.db;
  const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const lowers = arr(req.body.lower);
  const uppers = arr(req.body.upper);
  const rates = arr(req.body.rate);
  const bands = lowers
    .map((l, i) => ({ lower: str(l), upper: str(uppers[i]), rate: str(rates[i]) }))
    .filter((b) => b.lower !== null || b.upper !== null || b.rate !== null)
    .map((b) => ({ lower: num(b.lower), upper: b.upper === null ? null : num(b.upper), rate: num(b.rate) }))
    .sort((a, b) => a.lower - b.lower);

  if (bands.length === 0) throw new UserError('At least one PAYE band is required.');
  if (bands[0].lower !== 0) throw new UserError('The first PAYE band must start at 0.');
  bands.forEach((b, i) => {
    if (b.rate < 0 || b.rate > 100) throw new UserError('PAYE rates must be between 0 and 100.');
    const last = i === bands.length - 1;
    if (!last && b.upper === null) throw new UserError('Only the last band may have no upper limit.');
    if (b.upper !== null && b.upper <= b.lower) throw new UserError(`Band starting at ${b.lower} must end above its start.`);
    if (!last && bands[i + 1].lower !== b.upper) throw new UserError(`Bands must be continuous: band ending at ${b.upper} is followed by one starting at ${bands[i + 1].lower}.`);
  });
  if (bands[bands.length - 1].upper !== null) throw new UserError('The last band must have no upper limit.');

  transaction(db, () => {
    db.prepare('DELETE FROM paye_bands').run();
    const ins = db.prepare('INSERT INTO paye_bands (lower_limit, upper_limit, rate) VALUES (?, ?, ?)');
    for (const b of bands) ins.run(b.lower, b.upper, b.rate);
  });
  audit(db, user(req), 'PAYE_BANDS_UPDATED', bands.map((b) => `${b.lower}-${b.upper ?? '∞'}@${b.rate}%`).join('; '));
  flash(req, 'success', 'PAYE bands saved.');
  res.redirect('/settings/statutory');
}));

// ---- Payroll periods ----
router.get('/periods', (req, res) => {
  const db = req.app.locals.db;
  const periods = db.prepare('SELECT * FROM payroll_periods ORDER BY year DESC, month DESC').all();
  const latest = periods[0];
  const next = latest
    ? { year: latest.month === 12 ? latest.year + 1 : latest.year, month: latest.month === 12 ? 1 : latest.month + 1 }
    : { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  res.render('settings/periods', { title: 'Payroll periods', periods, next });
});

router.post('/periods', action((req, res) => {
  const db = req.app.locals.db;
  const year = int(req.body.year);
  const month = int(req.body.month);
  if (!year || year < 2000 || year > 2100) throw new UserError('Enter a valid year.');
  if (!month || month < 1 || month > 12) throw new UserError('Select a month.');
  const posted = db.prepare(`SELECT * FROM payroll_periods WHERE status = 'POSTED' AND (year * 12 + month) > (? * 12 + ?)
    ORDER BY year DESC, month DESC LIMIT 1`).get(year, month);
  if (posted) throw new UserError(`Cannot open a period before ${periodName(posted)}, which is already posted.`);
  db.prepare('INSERT INTO payroll_periods (year, month) VALUES (?, ?)').run(year, month);
  audit(db, user(req), 'PERIOD_OPENED', periodName({ year, month }));
  flash(req, 'success', `${periodName({ year, month })} opened.`);
  res.redirect('/settings/periods');
}));

router.post('/periods/:id/delete', action((req, res) => {
  const db = req.app.locals.db;
  const p = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(req.params.id);
  if (!p) throw new UserError('Period not found.');
  if (p.status !== 'OPEN') throw new UserError('Only open periods with no processed payroll can be deleted. Roll back first.');
  db.prepare('DELETE FROM payroll_periods WHERE id = ?').run(p.id);
  audit(db, user(req), 'PERIOD_DELETED', periodName(p));
  flash(req, 'success', `${periodName(p)} deleted.`);
  res.redirect('/settings/periods');
}));

// ---- Departments & sub-departments ----
router.get('/departments', (req, res) => {
  const db = req.app.locals.db;
  const departments = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS employees
    FROM departments d ORDER BY d.name`).all();
  const subs = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM employees e WHERE e.sub_department_id = s.id) AS employees
    FROM sub_departments s ORDER BY s.name`).all();
  for (const d of departments) d.subs = subs.filter((s) => s.department_id === d.id);
  res.render('settings/departments', { title: 'Departments', departments });
});

function simpleCrud(table, label, redirect) {
  return {
    create: action((req, res) => {
      const name = str(req.body.name);
      if (!name) throw new UserError('Name is required.');
      req.app.locals.db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name);
      flash(req, 'success', `${label} "${name}" added.`);
      res.redirect(redirect);
    }),
    rename: action((req, res) => {
      const name = str(req.body.name);
      if (!name) throw new UserError('Name is required.');
      req.app.locals.db.prepare(`UPDATE ${table} SET name = ? WHERE id = ?`).run(name, req.params.id);
      flash(req, 'success', `${label} renamed.`);
      res.redirect(redirect);
    }),
    remove: action((req, res) => {
      req.app.locals.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
      flash(req, 'success', `${label} deleted.`);
      res.redirect(redirect);
    }),
  };
}

const departments = simpleCrud('departments', 'Department', '/settings/departments');
router.post('/departments', departments.create);
router.post('/departments/:id', departments.rename);
router.post('/departments/:id/delete', departments.remove);

router.post('/departments/:id/subs', action((req, res) => {
  const name = str(req.body.name);
  if (!name) throw new UserError('Name is required.');
  req.app.locals.db.prepare('INSERT INTO sub_departments (department_id, name) VALUES (?, ?)').run(req.params.id, name);
  flash(req, 'success', `Sub-department "${name}" added.`);
  res.redirect('/settings/departments');
}));
const subDepartments = simpleCrud('sub_departments', 'Sub-department', '/settings/departments');
router.post('/sub-departments/:id', subDepartments.rename);
router.post('/sub-departments/:id/delete', subDepartments.remove);

// ---- Designations ----
router.get('/designations', (req, res) => {
  const designations = req.app.locals.db.prepare(`
    SELECT g.*, (SELECT COUNT(*) FROM employees e WHERE e.designation_id = g.id) AS employees
    FROM designations g ORDER BY g.name`).all();
  res.render('settings/designations', { title: 'Designations', designations });
});
const designations = simpleCrud('designations', 'Designation', '/settings/designations');
router.post('/designations', designations.create);
router.post('/designations/:id', designations.rename);
router.post('/designations/:id/delete', designations.remove);

// ---- Audit log ----
router.get('/audit', (req, res) => {
  const entries = req.app.locals.db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
  res.render('settings/audit', { title: 'Audit log', entries });
});

module.exports = router;
