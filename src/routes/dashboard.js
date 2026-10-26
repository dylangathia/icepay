const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  const db = req.app.locals.db;
  const counts = db.prepare(`
    SELECT
      SUM(status = 'ACTIVE') AS active,
      SUM(status = 'SUSPENDED') AS suspended,
      SUM(status = 'TERMINATED') AS terminated
    FROM employees`).get();
  const current = db.prepare(`
    SELECT * FROM payroll_periods WHERE status <> 'POSTED' ORDER BY year, month LIMIT 1`).get();
  const lastPosted = db.prepare(`
    SELECT p.*, SUM(s.gross_pay) AS gross, SUM(s.net_pay) AS net, SUM(s.paye) AS paye, COUNT(s.id) AS employees
    FROM payroll_periods p LEFT JOIN payslips s ON s.period_id = p.id
    WHERE p.status = 'POSTED' GROUP BY p.id ORDER BY p.year DESC, p.month DESC LIMIT 1`).get();
  const activity = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 10').all();
  res.render('dashboard', { title: 'Dashboard', counts, current, lastPosted, activity });
});

module.exports = router;
