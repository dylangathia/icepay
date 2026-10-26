const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { requireLogin } = require('./auth');
const { money } = require('./util');
const { periodName, MONTHS } = require('./payroll/service');

function createApp(database) {
  const app = express();
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.locals.db = database;

  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
  }));

  app.use((req, res, next) => {
    res.locals.user = null;              // set by requireLogin
    res.locals.can = () => false;
    res.locals.flash = req.session.flash;
    delete req.session.flash;
    res.locals.path = req.path;
    res.locals.money = money;
    res.locals.periodName = periodName;
    res.locals.MONTHS = MONTHS;
    res.locals.company = database.prepare('SELECT name FROM company WHERE id = 1').get();
    next();
  });

  app.use(require('./routes/auth'));
  app.use(requireLogin);
  app.use(require('./routes/dashboard'));
  app.use('/employees', require('./routes/employees'));
  app.use('/benefits', require('./routes/payItems')('BENEFIT'));
  app.use('/deductions', require('./routes/payItems')('DEDUCTION'));
  app.use('/payroll', require('./routes/payroll'));
  app.use('/settings', require('./routes/settings'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'Page not found.' }));
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).render('error', { title: 'Error', message: err.message });
  });
  return app;
}

if (require.main === module) {
  const database = db.open(process.env.DB_FILE || path.join(__dirname, '..', 'data', 'icepay.db'));
  const port = Number(process.env.PORT) || 3000;
  createApp(database).listen(port, () => console.log(`IcePay running at http://localhost:${port}`));
}

module.exports = { createApp };
