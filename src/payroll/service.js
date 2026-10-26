// Payroll period lifecycle: OPEN --process--> PROCESSED --post--> POSTED (final)
//                                 <--rollback--
const { transaction, getSettings, audit } = require('../db');
const { computePayslip } = require('./calculator');
const { UserError } = require('../util');

class PayrollError extends UserError {}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const periodName = (p) => `${MONTHS[p.month - 1]} ${p.year}`;
const pad = (n) => String(n).padStart(2, '0');
const periodStart = (p) => `${p.year}-${pad(p.month)}-01`;
const periodEnd = (p) => `${p.year}-${pad(p.month)}-${pad(new Date(p.year, p.month, 0).getDate())}`;

function getPeriod(db, periodId) {
  const period = db.prepare('SELECT * FROM payroll_periods WHERE id = ?').get(periodId);
  if (!period) throw new PayrollError('Payroll period not found');
  return period;
}

// Active employees hired by period end, plus terminated employees whose last day falls in or after
// the period (they get a final, prorated payslip). Suspended employees are not paid.
function eligibleEmployees(db, period) {
  return db.prepare(`
    SELECT e.*, d.name AS department, g.name AS designation
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN designations g ON g.id = e.designation_id
    WHERE e.hire_date <= ?
      AND (e.status = 'ACTIVE' OR (e.status = 'TERMINATED' AND e.status_date >= ?))
    ORDER BY e.emp_no`).all(periodEnd(period), periodStart(period));
}

const dayNumber = (isoDate) => Date.UTC(...isoDate.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) / 86400000;

// Calendar days the employee was employed within the period
function daysEmployed(employee, period) {
  const start = Math.max(dayNumber(periodStart(period)), dayNumber(employee.hire_date));
  let end = dayNumber(periodEnd(period));
  if (employee.status === 'TERMINATED' && employee.status_date) end = Math.min(end, dayNumber(employee.status_date));
  return Math.max(0, end - start + 1);
}

function employeeItems(db, employeeId) {
  return db.prepare(`
    SELECT p.kind, p.code, p.name, p.calc_type, p.taxable, p.insurance_relief, ep.value
    FROM employee_pay_items ep JOIN pay_items p ON p.id = ep.pay_item_id
    WHERE ep.employee_id = ? AND p.active = 1
    ORDER BY p.kind, p.code`).all(employeeId);
}

function processPeriod(db, periodId, username) {
  const period = getPeriod(db, periodId);
  if (period.status === 'PROCESSED') throw new PayrollError(`${periodName(period)} is already processed. Roll it back to process again.`);
  if (period.status === 'POSTED') throw new PayrollError(`${periodName(period)} is posted and cannot be processed again.`);

  const pending = db.prepare(`
    SELECT * FROM payroll_periods
    WHERE (year * 12 + month) < (? * 12 + ?) AND status <> 'POSTED'
    ORDER BY year, month LIMIT 1`).get(period.year, period.month);
  if (pending) throw new PayrollError(`Post ${periodName(pending)} before processing ${periodName(period)}.`);

  const settings = getSettings(db);
  const daysInPeriod = new Date(period.year, period.month, 0).getDate();
  const employees = eligibleEmployees(db, period)
    .map((e) => ({ ...e, daysWorked: settings.proration_enabled ? daysEmployed(e, period) : daysInPeriod }))
    .filter((e) => e.daysWorked > 0);
  if (employees.length === 0) throw new PayrollError('There are no active employees to process for this period.');

  const bands = db.prepare('SELECT * FROM paye_bands').all();
  if (bands.length === 0) throw new PayrollError('Configure PAYE bands before processing payroll.');

  const insertSlip = db.prepare(`
    INSERT INTO payslips (period_id, employee_id, emp_no, employee_name, kra_pin, department, designation,
      monthly_basic, days_worked, days_in_period,
      basic_salary, total_benefits, gross_pay, nssf, shif, housing_levy, exempt_deductions, taxable_pay,
      tax_charged, personal_relief, insurance_relief, paye, other_deductions, total_deductions, net_pay,
      employer_nssf, employer_housing_levy)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertLine = db.prepare(
    'INSERT INTO payslip_lines (payslip_id, category, code, name, amount, taxable) VALUES (?,?,?,?,?,?)');

  transaction(db, () => {
    for (const e of employees) {
      const slip = computePayslip({
        basicSalary: e.basic_salary, items: employeeItems(db, e.id), settings, bands,
        daysWorked: e.daysWorked, daysInPeriod, insurancePremium: e.insurance_premium,
      });
      const name = [e.first_name, e.middle_name, e.last_name].filter(Boolean).join(' ');
      const { lastInsertRowid } = insertSlip.run(period.id, e.id, e.emp_no, name, e.kra_pin ?? null,
        e.department ?? null, e.designation ?? null,
        slip.monthly_basic, slip.days_worked, slip.days_in_period,
        slip.basic_salary, slip.total_benefits, slip.gross_pay, slip.nssf, slip.shif, slip.housing_levy,
        slip.exempt_deductions, slip.taxable_pay, slip.tax_charged, slip.personal_relief, slip.insurance_relief, slip.paye,
        slip.other_deductions, slip.total_deductions, slip.net_pay, slip.employer_nssf, slip.employer_housing_levy);
      for (const l of slip.lines) insertLine.run(lastInsertRowid, l.category, l.code, l.name, l.amount, l.taxable);
    }
    db.prepare(`UPDATE payroll_periods SET status = 'PROCESSED', processed_at = datetime('now'), processed_by = ?
      WHERE id = ?`).run(username ?? null, period.id);
    audit(db, username, 'PAYROLL_PROCESSED', `${periodName(period)}: ${employees.length} employees`);
  });
  return employees.length;
}

function rollbackPeriod(db, periodId, username) {
  const period = getPeriod(db, periodId);
  if (period.status === 'POSTED') throw new PayrollError(`${periodName(period)} is posted. Posted payroll cannot be rolled back.`);
  if (period.status !== 'PROCESSED') throw new PayrollError(`${periodName(period)} has not been processed.`);

  transaction(db, () => {
    db.prepare('DELETE FROM payslips WHERE period_id = ?').run(period.id);
    db.prepare(`UPDATE payroll_periods SET status = 'OPEN', processed_at = NULL, processed_by = NULL
      WHERE id = ?`).run(period.id);
    audit(db, username, 'PAYROLL_ROLLED_BACK', periodName(period));
  });
}

function postPeriod(db, periodId, username) {
  const period = getPeriod(db, periodId);
  if (period.status === 'POSTED') throw new PayrollError(`${periodName(period)} is already posted.`);
  if (period.status !== 'PROCESSED') throw new PayrollError(`Process ${periodName(period)} before posting it.`);
  if (getSettings(db).post_requires_different_user && period.processed_by === username) {
    throw new PayrollError('You processed this payroll, so another user must post it.');
  }

  transaction(db, () => {
    db.prepare(`UPDATE payroll_periods SET status = 'POSTED', posted_at = datetime('now'), posted_by = ?
      WHERE id = ?`).run(username ?? null, period.id);
    audit(db, username, 'PAYROLL_POSTED', periodName(period));
  });
}

module.exports = {
  PayrollError, MONTHS, periodName, periodStart, periodEnd,
  getPeriod, processPeriod, rollbackPeriod, postPeriod, daysEmployed,
};
