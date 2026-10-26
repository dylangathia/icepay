const test = require('node:test');
const assert = require('node:assert/strict');
const { can, hashPassword, verifyPassword } = require('../src/auth');

test('role permissions separate preparing payroll from posting it', () => {
  const officer = { role: 'PAYROLL_OFFICER' };
  const approver = { role: 'APPROVER' };
  const viewer = { role: 'VIEWER' };
  const admin = { role: 'ADMIN' };

  assert.ok(can(officer, 'payroll.process'));
  assert.ok(!can(officer, 'payroll.post'));
  assert.ok(can(approver, 'payroll.post'));
  assert.ok(!can(approver, 'payroll.process'));
  assert.ok(!can(viewer, 'employees.manage'));
  assert.ok(can(viewer, 'audit.view'));
  assert.ok(!can(officer, 'users.manage'));
  assert.ok(can(admin, 'users.manage') && can(admin, 'payroll.post') && can(admin, 'payroll.process'));
  assert.ok(!can(null, 'payroll.process'));
  assert.throws(() => can(admin, 'no.such.permission'));
});

test('password hashing', () => {
  const h = hashPassword('s3cret-pass');
  assert.ok(verifyPassword('s3cret-pass', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.notEqual(hashPassword('s3cret-pass'), h);
});
