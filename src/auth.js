const crypto = require('node:crypto');

const ROLES = {
  ADMIN: 'Administrator',
  PAYROLL_OFFICER: 'Payroll Officer',
  APPROVER: 'Approver',
  VIEWER: 'Viewer',
};

// Who may do what. Everyone signed in may view employees, payroll registers and payslips.
const PERMISSIONS = {
  'employees.manage': ['ADMIN', 'PAYROLL_OFFICER'],
  'payitems.manage': ['ADMIN', 'PAYROLL_OFFICER'],
  'periods.manage': ['ADMIN', 'PAYROLL_OFFICER'],
  'payroll.process': ['ADMIN', 'PAYROLL_OFFICER'],   // process and roll back
  'payroll.post': ['ADMIN', 'APPROVER'],
  'payroll.email': ['ADMIN', 'APPROVER'],
  'settings.manage': ['ADMIN'],
  'users.manage': ['ADMIN'],
  'audit.view': ['ADMIN', 'APPROVER', 'VIEWER'],
};

function can(user, permission) {
  if (!PERMISSIONS[permission]) throw new Error(`Unknown permission ${permission}`);
  return !!user && PERMISSIONS[permission].includes(user.role);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

// Reloads the user on every request so role changes and deactivation take effect immediately.
function requireLogin(req, res, next) {
  const id = req.session.user?.id;
  const user = id && req.app.locals.db.prepare(
    'SELECT id, username, full_name, role, must_change_password FROM users WHERE id = ? AND active = 1').get(id);
  if (!user) {
    if (id) return req.session.destroy(() => res.redirect('/login'));
    return res.redirect('/login');
  }
  req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
  res.locals.user = req.session.user;
  res.locals.can = (permission) => can(user, permission);
  res.locals.ROLES = ROLES;

  const allowed = ['/account/password', '/logout'];
  if (user.must_change_password && !allowed.includes(req.originalUrl.split('?')[0])) {
    return res.redirect('/account/password');
  }
  next();
}

function deny(req, res) {
  const message = 'You do not have permission to do that.';
  if (req.method === 'GET') return res.status(403).render('error', { title: 'Access denied', message });
  req.session.flash = { type: 'error', message };
  res.redirect(req.get('Referrer') || '/');
}

function requirePermission(permission) {
  return (req, res, next) => (can(req.session.user, permission) ? next() : deny(req, res));
}

// Guards every non-GET request on a router; GET pages stay viewable
function requirePermissionForWrites(permission) {
  return (req, res, next) => (req.method === 'GET' || can(req.session.user, permission) ? next() : deny(req, res));
}

module.exports = {
  ROLES, PERMISSIONS, can, hashPassword, verifyPassword,
  requireLogin, requirePermission, requirePermissionForWrites,
};
