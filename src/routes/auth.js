const express = require('express');
const { verifyPassword, hashPassword, requireLogin } = require('../auth');
const { action, flash, UserError } = require('../util');
const { audit } = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in' });
});

router.post('/login', (req, res, next) => {
  const db = req.app.locals.db;
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(req.body.username || '').trim());
  if (!user || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    flash(req, 'error', 'Invalid username or password.');
    return res.redirect('/login');
  }
  if (!user.active) {
    flash(req, 'error', 'This account is deactivated. Contact your administrator.');
    return res.redirect('/login');
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    audit(db, user.username, 'LOGIN');
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account/password', requireLogin, (req, res) => {
  const { must_change_password: forced } = req.app.locals.db
    .prepare('SELECT must_change_password FROM users WHERE id = ?').get(req.session.user.id);
  res.render('password', { title: 'Change password', forced });
});

router.post('/account/password', requireLogin, action((req, res) => {
  const db = req.app.locals.db;
  const { current, password, confirm } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!verifyPassword(String(current || ''), user.password_hash)) throw new UserError('Current password is incorrect.');
  if (!password || password.length < 8) throw new UserError('New password must be at least 8 characters.');
  if (password !== confirm) throw new UserError('New passwords do not match.');
  if (password === current) throw new UserError('Choose a password different from the current one.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(password), user.id);
  audit(db, user.username, 'PASSWORD_CHANGED');
  flash(req, 'success', 'Password changed.');
  res.redirect('/');
}));

module.exports = router;
