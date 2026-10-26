const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { processPeriod, rollbackPeriod, postPeriod } = require('../src/payroll/service');

function setup() {
  const d = db.open(':memory:');
  const add = d.prepare(`INSERT INTO employees (emp_no, first_name, last_name, hire_date, basic_salary, status)
    VALUES (?, ?, ?, ?, ?, ?)`);
  add.run('EMP001', 'Jane', 'Wanjiku', '2024-01-01', 50000, 'ACTIVE');
  add.run('EMP002', 'John', 'Otieno', '2024-01-01', 80000, 'ACTIVE');
  add.run('EMP003', 'Suspended', 'Person', '2024-01-01', 40000, 'SUSPENDED');
  add.run('EMP004', 'Future', 'Hire', '2026-03-15', 40000, 'ACTIVE');
  d.prepare('INSERT INTO payroll_periods (year, month) VALUES (2026, 1), (2026, 2)').run();
  return d;
}
const period = (d, month) => d.prepare('SELECT * FROM payroll_periods WHERE month = ?').get(month);
const slipCount = (d, id) => d.prepare('SELECT COUNT(*) AS n FROM payslips WHERE period_id = ?').get(id).n;

test('process includes only active employees hired by period end', () => {
  const d = setup();
  const jan = period(d, 1);
  assert.equal(processPeriod(d, jan.id, 'tester'), 2);
  assert.equal(period(d, 1).status, 'PROCESSED');
  assert.equal(slipCount(d, jan.id), 2);
});

test('rollback deletes payslips and allows reprocessing with new data', () => {
  const d = setup();
  const jan = period(d, 1);
  processPeriod(d, jan.id, 'tester');
  assert.throws(() => processPeriod(d, jan.id, 'tester'), /already processed/);

  rollbackPeriod(d, jan.id, 'tester');
  assert.equal(period(d, 1).status, 'OPEN');
  assert.equal(slipCount(d, jan.id), 0);
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM payslip_lines').get().n, 0);

  d.prepare("UPDATE employees SET basic_salary = 60000 WHERE emp_no = 'EMP001'").run();
  processPeriod(d, jan.id, 'tester');
  const slip = d.prepare("SELECT * FROM payslips WHERE emp_no = 'EMP001'").get();
  assert.equal(slip.basic_salary, 60000);
});

test('periods must be posted in order', () => {
  const d = setup();
  assert.throws(() => processPeriod(d, period(d, 2).id, 'tester'), /Post January 2026/);
  processPeriod(d, period(d, 1).id, 'tester');
  postPeriod(d, period(d, 1).id, 'tester');
  assert.equal(processPeriod(d, period(d, 2).id, 'tester'), 2);
});

test('mid-month joiners and leavers are prorated; leavers drop off after their last month', () => {
  const d = setup();
  d.prepare(`INSERT INTO employees (emp_no, first_name, last_name, hire_date, basic_salary, status)
    VALUES ('EMP005', 'New', 'Joiner', '2026-01-22', 31000, 'ACTIVE')`).run();
  d.prepare(`INSERT INTO employees (emp_no, first_name, last_name, hire_date, basic_salary, status, status_date, status_reason)
    VALUES ('EMP006', 'Early', 'Leaver', '2024-01-01', 31000, 'TERMINATED', '2026-01-15', 'Resigned')`).run();
  const jan = period(d, 1);
  assert.equal(processPeriod(d, jan.id, 'tester'), 4);
  const slip = (no) => d.prepare('SELECT * FROM payslips WHERE emp_no = ? AND period_id = ?').get(no, jan.id);
  assert.deepEqual([slip('EMP005').days_worked, slip('EMP005').basic_salary], [10, 10000]);
  assert.deepEqual([slip('EMP006').days_worked, slip('EMP006').basic_salary], [15, 15000]);
  assert.equal(slip('EMP001').days_worked, 31);

  postPeriod(d, jan.id, 'tester');
  const feb = period(d, 2);
  processPeriod(d, feb.id, 'tester');
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM payslips WHERE emp_no = 'EMP006' AND period_id = ?").get(feb.id).n, 0);
});

test('proration can be switched off', () => {
  const d = setup();
  d.prepare("UPDATE settings SET value = '0' WHERE key = 'proration_enabled'").run();
  d.prepare(`INSERT INTO employees (emp_no, first_name, last_name, hire_date, basic_salary, status)
    VALUES ('EMP005', 'New', 'Joiner', '2026-01-22', 31000, 'ACTIVE')`).run();
  processPeriod(d, period(d, 1).id, 'tester');
  assert.equal(d.prepare("SELECT basic_salary FROM payslips WHERE emp_no = 'EMP005'").get().basic_salary, 31000);
});

test('four-eyes rule: the processor cannot post when enabled', () => {
  const d = setup();
  d.prepare("UPDATE settings SET value = '1' WHERE key = 'post_requires_different_user'").run();
  const jan = period(d, 1);
  processPeriod(d, jan.id, 'officer');
  assert.throws(() => postPeriod(d, jan.id, 'officer'), /another user must post/);
  postPeriod(d, jan.id, 'approver');
  assert.equal(period(d, 1).posted_by, 'approver');
});

test('posting is irreversible, in code and in the database', () => {
  const d = setup();
  const jan = period(d, 1);
  assert.throws(() => postPeriod(d, jan.id, 'tester'), /Process January 2026 before posting/);
  processPeriod(d, jan.id, 'tester');
  postPeriod(d, jan.id, 'tester');

  assert.throws(() => rollbackPeriod(d, jan.id, 'tester'), /cannot be rolled back/);
  assert.throws(() => processPeriod(d, jan.id, 'tester'), /posted/);
  assert.throws(() => postPeriod(d, jan.id, 'tester'), /already posted/);

  // Direct SQL is blocked by triggers too
  assert.throws(() => d.prepare("UPDATE payroll_periods SET status = 'OPEN' WHERE id = ?").run(jan.id), /cannot be changed/);
  assert.throws(() => d.prepare('DELETE FROM payslips WHERE period_id = ?').run(jan.id), /cannot be deleted/);
  assert.throws(() => d.prepare('UPDATE payslips SET net_pay = 0 WHERE period_id = ?').run(jan.id), /cannot be changed/);
  assert.throws(() => d.prepare('DELETE FROM payroll_periods WHERE id = ?').run(jan.id), /cannot be deleted/);
  assert.equal(slipCount(d, jan.id), 2);
});
