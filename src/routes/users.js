// User accounts (mounted under /settings/users, admin only)
const express = require('express');
const { audit } = require('../db');
const { ROLES, PERMISSIONS, hashPassword } = require('../auth');
const { action, flash, str, bool, UserError } = require('../util');

const router = express.Router();

function readRole(value) {
  if (!ROLES[value]) throw new UserError('Select a valid role.');
  return value;
}

function checkPassword(password) {
  if (!password || password.length < 8) throw new UserError('Password must be at least 8 characters.');
  return password;
}

function getUser(db, id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new UserError('User not found.');
  return u;
}

const activeAdmins = (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN' AND active = 1").get().n;

router.get('/', (req, res) => {
  const users = req.app.locals.db.prepare('SELECT * FROM users ORDER BY active DESC, username').all();
  res.render('settings/users', { title: 'Users', users, PERMISSIONS });
});

router.post('/', action((req, res) => {
  const db = req.app.locals.db;
  const username = (str(req.body.username) || '').toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new UserError('Username must be 3–32 characters: letters, digits, dots, dashes or underscores.');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    throw new UserError(`Username "${username}" is taken.`);
  }
  const role = readRole(req.body.role);
  db.prepare(`INSERT INTO users (username, full_name, email, role, password_hash, must_change_password)
    VALUES (?, ?, ?, ?, ?, 1)`)
    .run(username, str(req.body.full_name), str(req.body.email), role, hashPassword(checkPassword(req.body.password)));
  audit(db, req.session.user.username, 'USER_ADDED', `${username} as ${ROLES[role]}`);
  flash(req, 'success', `User ${username} created. They must change the temporary password at first sign-in.`);
  res.redirect('/settings/users');
}));

router.get('/:id/edit', action((req, res) => {
  const account = getUser(req.app.locals.db, req.params.id);
  res.render('settings/user-edit', { title: `Edit user ${account.username}`, account });
}));

router.post('/:id', action((req, res) => {
  const db = req.app.locals.db;
  const u = getUser(db, req.params.id);
  const role = readRole(req.body.role);
  const active = bool(req.body.active);
  const self = u.id === req.session.user.id;
  if (self && (role !== u.role || !active)) throw new UserError('You cannot change your own role or deactivate yourself.');
  if (u.role === 'ADMIN' && u.active && (role !== 'ADMIN' || !active) && activeAdmins(db) <= 1) {
    throw new UserError('At least one active administrator is required.');
  }
  db.prepare('UPDATE users SET full_name = ?, email = ?, role = ?, active = ? WHERE id = ?')
    .run(str(req.body.full_name), str(req.body.email), role, active, u.id);
  const changes = [role !== u.role && `role ${ROLES[u.role]} → ${ROLES[role]}`,
    active !== u.active && (active ? 'reactivated' : 'deactivated')].filter(Boolean).join(', ');
  audit(db, req.session.user.username, 'USER_UPDATED', `${u.username}${changes ? `: ${changes}` : ''}`);
  flash(req, 'success', `User ${u.username} updated.`);
  res.redirect('/settings/users');
}));

router.post('/:id/reset-password', action((req, res) => {
  const db = req.app.locals.db;
  const u = getUser(db, req.params.id);
  if (u.id === req.session.user.id) throw new UserError('Use "Change password" to change your own password.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
    .run(hashPassword(checkPassword(req.body.password)), u.id);
  audit(db, req.session.user.username, 'USER_PASSWORD_RESET', u.username);
  flash(req, 'success', `Password reset for ${u.username}. They must change it at next sign-in.`);
  res.redirect('/settings/users');
}));

module.exports = router;
