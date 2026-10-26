// Benefits and deductions: same shape, different `kind`
const express = require('express');
const { audit } = require('../db');
const { requirePermission, requirePermissionForWrites } = require('../auth');
const { action, flash, str, num, bool, UserError } = require('../util');

module.exports = function payItemsRouter(kind) {
  const router = express.Router();
  router.use(requirePermissionForWrites('payitems.manage'));
  const base = kind === 'BENEFIT' ? '/benefits' : '/deductions';
  const label = kind === 'BENEFIT' ? 'Benefit' : 'Deduction';
  const view = { kind, base, label, plural: `${label}s` };

  function readForm(body) {
    const item = {
      code: (str(body.code) || '').toUpperCase(),
      name: str(body.name),
      calc_type: body.calc_type === 'PERCENT' ? 'PERCENT' : 'FIXED',
      default_value: num(body.default_value),
      taxable: bool(body.taxable),
      insurance_relief: kind === 'DEDUCTION' ? bool(body.insurance_relief) : 0,
      active: bool(body.active),
    };
    if (item.insurance_relief && !item.taxable) {
      throw new UserError('Insurance premiums get relief instead of reducing taxable pay. Set the tax treatment to "after tax".');
    }
    if (!item.code || !item.name) throw new UserError('Code and name are required.');
    if (!/^[A-Z0-9_]+$/.test(item.code)) throw new UserError('Code may contain only letters, digits and underscores.');
    if (['BASIC', 'PAYE', 'NSSF', 'SHIF', 'AHL'].includes(item.code)) throw new UserError(`${item.code} is a reserved code.`);
    if (item.default_value < 0) throw new UserError('Value cannot be negative.');
    if (item.calc_type === 'PERCENT' && item.default_value > 100) throw new UserError('Percentage cannot exceed 100.');
    return item;
  }

  function getItem(db, id) {
    const item = db.prepare('SELECT * FROM pay_items WHERE id = ? AND kind = ?').get(id, kind);
    if (!item) throw new UserError(`${label} not found.`);
    return item;
  }

  router.get('/', (req, res) => {
    const db = req.app.locals.db;
    const items = db.prepare(`
      SELECT p.*, COUNT(ep.id) AS assigned
      FROM pay_items p LEFT JOIN employee_pay_items ep ON ep.pay_item_id = p.id
      WHERE p.kind = ? GROUP BY p.id ORDER BY p.code`).all(kind);
    res.render('payItems/index', { title: view.plural, items, ...view, item: { calc_type: 'FIXED', taxable: 1, active: 1 } });
  });

  router.post('/', action((req, res) => {
    const db = req.app.locals.db;
    const i = readForm(req.body);
    db.prepare(`INSERT INTO pay_items (kind, code, name, calc_type, default_value, taxable, insurance_relief, active)
      VALUES (?,?,?,?,?,?,?,?)`).run(kind, i.code, i.name, i.calc_type, i.default_value, i.taxable, i.insurance_relief, i.active);
    audit(db, req.session.user.username, `${kind}_ADDED`, i.code);
    flash(req, 'success', `${label} ${i.code} created.`);
    res.redirect(base);
  }));

  router.get('/:id/edit', requirePermission('payitems.manage'), action((req, res) => {
    const db = req.app.locals.db;
    res.render('payItems/edit', { title: `Edit ${label.toLowerCase()}`, item: getItem(db, req.params.id), ...view });
  }));

  router.post('/:id', action((req, res) => {
    const db = req.app.locals.db;
    const current = getItem(db, req.params.id);
    const i = readForm(req.body);
    db.prepare('UPDATE pay_items SET code=?, name=?, calc_type=?, default_value=?, taxable=?, insurance_relief=?, active=? WHERE id=?')
      .run(i.code, i.name, i.calc_type, i.default_value, i.taxable, i.insurance_relief, i.active, current.id);
    audit(db, req.session.user.username, `${kind}_UPDATED`, i.code);
    flash(req, 'success', `${label} updated.`);
    res.redirect(base);
  }));

  router.post('/:id/delete', action((req, res) => {
    const db = req.app.locals.db;
    const item = getItem(db, req.params.id);
    db.prepare('DELETE FROM pay_items WHERE id = ?').run(item.id);
    audit(db, req.session.user.username, `${kind}_DELETED`, item.code);
    flash(req, 'success', `${label} deleted.`);
    res.redirect(base);
  }));

  // Assign this item at its default value to every active employee who doesn't have it yet
  router.post('/:id/assign-all', action((req, res) => {
    const db = req.app.locals.db;
    const item = getItem(db, req.params.id);
    if (!item.active) throw new UserError('Activate this item before assigning it.');
    const { changes } = db.prepare(`
      INSERT INTO employee_pay_items (employee_id, pay_item_id, value)
      SELECT id, ?, ? FROM employees WHERE status = 'ACTIVE'
      ON CONFLICT (employee_id, pay_item_id) DO NOTHING`).run(item.id, item.default_value);
    audit(db, req.session.user.username, `${kind}_ASSIGNED_ALL`, `${item.code} to ${changes} employees`);
    flash(req, 'success', `${item.name} assigned to ${changes} employee(s).`);
    res.redirect(base);
  }));

  return router;
};
