const express = require('express');
const { promisify } = require('node:util');
const { action, flash, csvRow, money, UserError } = require('../util');
const { audit, getSettings } = require('../db');
const { requirePermission } = require('../auth');
const { sendMail } = require('../mail');
const service = require('../payroll/service');

const router = express.Router();

const TOTALS_SQL = `
  COUNT(s.id) AS employees, SUM(s.gross_pay) AS gross_pay, SUM(s.paye) AS paye, SUM(s.nssf) AS nssf,
  SUM(s.shif) AS shif, SUM(s.housing_levy) AS housing_levy, SUM(s.total_deductions) AS total_deductions,
  SUM(s.net_pay) AS net_pay, SUM(s.employer_nssf) AS employer_nssf, SUM(s.employer_housing_levy) AS employer_housing_levy`;

function loadPayslip(db, periodId, slipId) {
  const slip = db.prepare(`
    SELECT s.*, e.email, e.id_number, e.nssf_no, e.shif_no, e.bank_name, e.account_no, e.payment_mode
    FROM payslips s JOIN employees e ON e.id = s.employee_id
    WHERE s.id = ? AND s.period_id = ?`).get(slipId, periodId);
  if (!slip) throw new UserError('Payslip not found.');
  slip.lines = db.prepare('SELECT * FROM payslip_lines WHERE payslip_id = ? ORDER BY id').all(slip.id);
  return slip;
}

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const periods = db.prepare(`
    SELECT p.*, ${TOTALS_SQL}
    FROM payroll_periods p LEFT JOIN payslips s ON s.period_id = p.id
    GROUP BY p.id ORDER BY p.year DESC, p.month DESC`).all();
  const nextActionable = db.prepare("SELECT id FROM payroll_periods WHERE status <> 'POSTED' ORDER BY year, month LIMIT 1").get();
  res.render('payroll/index', { title: 'Payroll', periods, nextActionableId: nextActionable?.id });
});

router.get('/:id', action((req, res) => {
  const db = req.app.locals.db;
  const period = service.getPeriod(db, req.params.id);
  const payslips = db.prepare('SELECT * FROM payslips WHERE period_id = ? ORDER BY emp_no').all(period.id);
  const totals = db.prepare(`SELECT ${TOTALS_SQL} FROM payslips s WHERE s.period_id = ?`).get(period.id);
  const fourEyes = !!getSettings(db).post_requires_different_user;
  res.render('payroll/period', { title: service.periodName(period), period, payslips, totals, fourEyes });
}));

router.post('/:id/process', requirePermission('payroll.process'), action((req, res) => {
  const db = req.app.locals.db;
  const count = service.processPeriod(db, req.params.id, req.session.user.username);
  flash(req, 'success', `Payroll processed for ${count} employee(s). Review it, then post or roll back.`);
  res.redirect(`/payroll/${req.params.id}`);
}));

router.post('/:id/rollback', requirePermission('payroll.process'), action((req, res) => {
  const db = req.app.locals.db;
  service.rollbackPeriod(db, req.params.id, req.session.user.username);
  flash(req, 'success', 'Payroll rolled back. The period is open and can be processed again.');
  res.redirect(`/payroll/${req.params.id}`);
}));

router.post('/:id/post', requirePermission('payroll.post'), action((req, res) => {
  const db = req.app.locals.db;
  if (req.body.confirm !== 'POST') throw new UserError('Type POST to confirm. Posting cannot be undone.');
  service.postPeriod(db, req.params.id, req.session.user.username);
  flash(req, 'success', 'Payroll posted. This period is now locked.');
  res.redirect(`/payroll/${req.params.id}`);
}));

router.get('/:id/payslips/:slipId', action((req, res) => {
  const db = req.app.locals.db;
  const period = service.getPeriod(db, req.params.id);
  const slip = loadPayslip(db, period.id, req.params.slipId);
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get();
  res.render('payroll/payslip', { title: `Payslip ${slip.emp_no}`, period, slip, companyInfo: company });
}));

router.get('/:id/export.csv', action((req, res) => {
  const db = req.app.locals.db;
  const period = service.getPeriod(db, req.params.id);
  const rows = db.prepare(`
    SELECT s.*, e.id_number, e.nssf_no, e.shif_no, e.bank_name, e.bank_branch, e.account_no
    FROM payslips s JOIN employees e ON e.id = s.employee_id
    WHERE s.period_id = ? ORDER BY s.emp_no`).all(period.id);
  const cols = ['emp_no', 'employee_name', 'id_number', 'kra_pin', 'nssf_no', 'shif_no', 'department', 'designation',
    'monthly_basic', 'days_worked', 'days_in_period',
    'basic_salary', 'total_benefits', 'gross_pay', 'nssf', 'shif', 'housing_levy', 'exempt_deductions', 'taxable_pay',
    'tax_charged', 'personal_relief', 'insurance_relief', 'paye', 'other_deductions', 'total_deductions', 'net_pay',
    'employer_nssf', 'employer_housing_levy', 'bank_name', 'bank_branch', 'account_no'];
  const csv = [csvRow(cols), ...rows.map((r) => csvRow(cols.map((c) => r[c])))].join('\r\n');
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="payroll-${period.year}-${String(period.month).padStart(2, '0')}.csv"`);
  res.send(csv);
}));

router.post('/:id/email', requirePermission('payroll.email'), action(async (req, res) => {
  const db = req.app.locals.db;
  const period = service.getPeriod(db, req.params.id);
  if (period.status !== 'POSTED') throw new UserError('Payslips can only be emailed after the payroll is posted.');
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get();
  const render = promisify(req.app.render.bind(req.app));
  const slips = db.prepare('SELECT s.id FROM payslips s WHERE s.period_id = ?').all(period.id);

  let sent = 0;
  const failures = [];
  for (const { id } of slips) {
    const slip = loadPayslip(db, period.id, id);
    if (!slip.email) { failures.push(`${slip.emp_no} (no email)`); continue; }
    try {
      const html = await render('payroll/payslip', {
        period, slip, companyInfo: company, money, periodName: service.periodName, email: true,
      });
      await sendMail(db, { to: slip.email, subject: `Payslip - ${service.periodName(period)}`, html });
      sent++;
    } catch (err) {
      if (/not configured/.test(err.message)) throw new UserError(err.message);
      failures.push(`${slip.emp_no} (${err.message})`);
    }
  }
  audit(db, req.session.user.username, 'PAYSLIPS_EMAILED', `${service.periodName(period)}: ${sent} sent, ${failures.length} failed`);
  flash(req, failures.length ? 'error' : 'success',
    `${sent} payslip(s) emailed.${failures.length ? ` Not sent: ${failures.join(', ')}` : ''}`);
  res.redirect(`/payroll/${period.id}`);
}));

module.exports = router;
