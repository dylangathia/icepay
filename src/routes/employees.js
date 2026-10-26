const express = require('express');
const { audit } = require('../db');
const { requirePermission, requirePermissionForWrites } = require('../auth');
const { periodName, periodEnd } = require('../payroll/service');
const { action, flash, str, num, int, UserError } = require('../util');

const router = express.Router();
router.use(requirePermissionForWrites('employees.manage'));
const canManage = requirePermission('employees.manage');

const FIELDS = ['emp_no', 'first_name', 'middle_name', 'last_name', 'gender', 'date_of_birth', 'id_number',
  'kra_pin', 'nssf_no', 'shif_no', 'email', 'phone', 'department_id', 'sub_department_id', 'designation_id',
  'hire_date', 'basic_salary', 'insurance_premium', 'payment_mode', 'bank_name', 'bank_branch', 'account_no'];

function lookups(db) {
  return {
    departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    subDepartments: db.prepare('SELECT * FROM sub_departments ORDER BY name').all(),
    designations: db.prepare('SELECT * FROM designations ORDER BY name').all(),
  };
}

function readForm(db, body) {
  const e = {};
  for (const f of FIELDS) e[f] = str(body[f]);
  e.department_id = int(body.department_id);
  e.sub_department_id = int(body.sub_department_id);
  e.designation_id = int(body.designation_id);
  e.basic_salary = num(body.basic_salary);
  e.insurance_premium = num(body.insurance_premium);
  e.payment_mode = e.payment_mode || 'BANK';
  if (e.kra_pin) e.kra_pin = e.kra_pin.toUpperCase();

  for (const f of ['emp_no', 'first_name', 'last_name', 'hire_date']) {
    if (!e[f]) throw new UserError(`${f.replace(/_/g, ' ')} is required.`);
  }
  if (e.basic_salary < 0) throw new UserError('Basic salary cannot be negative.');
  if (e.insurance_premium < 0) throw new UserError('Insurance premium cannot be negative.');
  if (e.kra_pin && !/^[AP]\d{9}[A-Z]$/.test(e.kra_pin)) throw new UserError('KRA PIN must look like A123456789Z.');
  if (e.sub_department_id) {
    const sub = db.prepare('SELECT department_id FROM sub_departments WHERE id = ?').get(e.sub_department_id);
    if (!sub || sub.department_id !== e.department_id) {
      throw new UserError('The sub-department does not belong to the selected department.');
    }
  }
  return e;
}

function getEmployee(db, id) {
  const e = db.prepare(`
    SELECT e.*, d.name AS department, sd.name AS sub_department, g.name AS designation
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN sub_departments sd ON sd.id = e.sub_department_id
    LEFT JOIN designations g ON g.id = e.designation_id
    WHERE e.id = ?`).get(id);
  if (!e) throw new UserError('Employee not found.');
  return e;
}

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const status = ['ACTIVE', 'SUSPENDED', 'TERMINATED'].includes(req.query.status) ? req.query.status : null;
  const q = str(req.query.q);
  const employees = db.prepare(`
    SELECT e.*, d.name AS department, g.name AS designation
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN designations g ON g.id = e.designation_id
    WHERE (? IS NULL OR e.status = ?)
      AND (? IS NULL OR e.emp_no LIKE ? OR e.first_name || ' ' || e.last_name LIKE ? OR e.id_number LIKE ?)
    ORDER BY e.emp_no`).all(status, status, q, `%${q}%`, `%${q}%`, `%${q}%`);
  res.render('employees/index', { title: 'Employees', employees, status, q });
});

router.get('/new', canManage, (req, res) => {
  const db = req.app.locals.db;
  const last = db.prepare("SELECT emp_no FROM employees WHERE emp_no GLOB 'EMP[0-9]*' ORDER BY length(emp_no) DESC, emp_no DESC LIMIT 1").get();
  const next = last ? `EMP${String(Number(last.emp_no.slice(3)) + 1).padStart(3, '0')}` : 'EMP001';
  res.render('employees/form', { title: 'Add employee', employee: { emp_no: next, payment_mode: 'BANK' }, ...lookups(db) });
});

router.post('/', action((req, res) => {
  const db = req.app.locals.db;
  const e = readForm(db, req.body);
  const { lastInsertRowid } = db.prepare(`INSERT INTO employees (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`)
    .run(...FIELDS.map((f) => e[f]));
  audit(db, req.session.user.username, 'EMPLOYEE_ADDED', `${e.emp_no} ${e.first_name} ${e.last_name}`);
  flash(req, 'success', 'Employee added.');
  res.redirect(`/employees/${lastInsertRowid}`);
}));

router.get('/:id', action((req, res) => {
  const db = req.app.locals.db;
  const employee = getEmployee(db, req.params.id);
  const items = db.prepare(`
    SELECT ep.id, ep.value, p.kind, p.code, p.name, p.calc_type, p.taxable, p.insurance_relief, p.active
    FROM employee_pay_items ep JOIN pay_items p ON p.id = ep.pay_item_id
    WHERE ep.employee_id = ? ORDER BY p.kind, p.code`).all(employee.id);
  const available = db.prepare(`
    SELECT * FROM pay_items WHERE active = 1
      AND id NOT IN (SELECT pay_item_id FROM employee_pay_items WHERE employee_id = ?)
    ORDER BY kind, code`).all(employee.id);
  const payslips = db.prepare(`
    SELECT s.id, s.gross_pay, s.net_pay, s.paye, p.id AS period_id, p.year, p.month, p.status
    FROM payslips s JOIN payroll_periods p ON p.id = s.period_id
    WHERE s.employee_id = ? ORDER BY p.year DESC, p.month DESC`).all(employee.id);
  res.render('employees/show', { title: `${employee.first_name} ${employee.last_name}`, employee, items, available, payslips });
}));

router.get('/:id/edit', canManage, action((req, res) => {
  const db = req.app.locals.db;
  const employee = getEmployee(db, req.params.id);
  if (employee.status === 'TERMINATED') throw new UserError('Terminated employees cannot be edited.');
  res.render('employees/form', { title: 'Edit employee', employee, ...lookups(db) });
}));

router.post('/:id', action((req, res) => {
  const db = req.app.locals.db;
  const current = getEmployee(db, req.params.id);
  if (current.status === 'TERMINATED') throw new UserError('Terminated employees cannot be edited.');
  const e = readForm(db, req.body);
  db.prepare(`UPDATE employees SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...FIELDS.map((f) => e[f]), current.id);
  audit(db, req.session.user.username, 'EMPLOYEE_UPDATED', e.emp_no);
  flash(req, 'success', 'Employee updated.');
  res.redirect(`/employees/${current.id}`);
}));

function changeStatus(from, to, verb) {
  return action((req, res) => {
    const db = req.app.locals.db;
    const e = getEmployee(db, req.params.id);
    if (!from.includes(e.status)) throw new UserError(`Cannot ${verb} an employee who is ${e.status.toLowerCase()}.`);
    const reason = str(req.body.reason);
    if (to !== 'ACTIVE' && !reason) throw new UserError(`A reason is required to ${verb} an employee.`);
    const date = str(req.body.date) || new Date().toISOString().slice(0, 10);
    if (to === 'TERMINATED') {
      if (date < e.hire_date) throw new UserError('Termination date cannot be before the hire date.');
      // A leaver's final pay is prorated in the period containing their last day, so it must still be unposted
      const lastPosted = db.prepare("SELECT * FROM payroll_periods WHERE status = 'POSTED' ORDER BY year DESC, month DESC LIMIT 1").get();
      if (lastPosted && date <= periodEnd(lastPosted)) {
        throw new UserError(`${periodName(lastPosted)} is already posted. Use a termination date after ${periodEnd(lastPosted)}.`);
      }
    }
    db.prepare(`UPDATE employees SET status = ?, status_date = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(to, to === 'ACTIVE' ? null : date, to === 'ACTIVE' ? null : reason, e.id);
    audit(db, req.session.user.username, `EMPLOYEE_${to}`, `${e.emp_no}${reason ? `: ${reason}` : ''}`);
    flash(req, 'success', `${e.first_name} ${e.last_name} is now ${to.toLowerCase()}.`);
    res.redirect(`/employees/${e.id}`);
  });
}

router.post('/:id/suspend', changeStatus(['ACTIVE'], 'SUSPENDED', 'suspend'));
router.post('/:id/reactivate', changeStatus(['SUSPENDED'], 'ACTIVE', 'reactivate'));
router.post('/:id/terminate', changeStatus(['ACTIVE', 'SUSPENDED'], 'TERMINATED', 'terminate'));

router.post('/:id/items', action((req, res) => {
  const db = req.app.locals.db;
  const e = getEmployee(db, req.params.id);
  const item = db.prepare('SELECT * FROM pay_items WHERE id = ? AND active = 1').get(int(req.body.pay_item_id));
  if (!item) throw new UserError('Select a benefit or deduction.');
  const value = num(req.body.value, item.default_value);
  if (value < 0) throw new UserError('Value cannot be negative.');
  db.prepare(`INSERT INTO employee_pay_items (employee_id, pay_item_id, value) VALUES (?, ?, ?)
    ON CONFLICT (employee_id, pay_item_id) DO UPDATE SET value = excluded.value`).run(e.id, item.id, value);
  flash(req, 'success', `${item.name} assigned.`);
  res.redirect(`/employees/${e.id}#pay-items`);
}));

router.post('/:id/items/:itemId', action((req, res) => {
  const db = req.app.locals.db;
  const value = num(req.body.value);
  if (value < 0) throw new UserError('Value cannot be negative.');
  db.prepare('UPDATE employee_pay_items SET value = ? WHERE id = ? AND employee_id = ?').run(value, req.params.itemId, req.params.id);
  flash(req, 'success', 'Amount updated.');
  res.redirect(`/employees/${req.params.id}#pay-items`);
}));

router.post('/:id/items/:itemId/delete', action((req, res) => {
  const db = req.app.locals.db;
  db.prepare('DELETE FROM employee_pay_items WHERE id = ? AND employee_id = ?').run(req.params.itemId, req.params.id);
  flash(req, 'success', 'Removed.');
  res.redirect(`/employees/${req.params.id}#pay-items`);
}));

module.exports = router;
