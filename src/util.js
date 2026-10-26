// Small helpers shared by routes and views

const money = (n) => Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Form fields: '' -> null, so optional columns are stored as NULL
const str = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};
const num = (v, fallback = 0) => {
  const s = str(v);
  if (s === null) return fallback;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new UserError(`"${v}" is not a valid number`);
  return n;
};
const int = (v) => (str(v) === null ? null : Math.trunc(num(v)));
const bool = (v) => (v === '1' || v === 'on' || v === 'true' || v === true ? 1 : 0);

// Errors whose message is safe to show to the user
class UserError extends Error {}

function flash(req, type, message) {
  req.session.flash = { type, message };
}

// Wraps a POST handler: user-facing errors are flashed and the user is sent back.
function action(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      const friendly = err instanceof UserError
        || /UNIQUE constraint failed|FOREIGN KEY constraint failed|cannot be/.test(err.message);
      if (!friendly) return next(err);
      let message = err.message;
      if (/UNIQUE constraint failed/.test(message)) message = 'A record with the same unique value already exists.';
      if (/FOREIGN KEY constraint failed/.test(message)) message = 'This record is in use and cannot be removed.';
      flash(req, 'error', message);
      res.redirect(req.get('Referrer') || '/');
    }
  };
}

function csvRow(values) {
  return values.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}

module.exports = { money, str, num, int, bool, UserError, flash, action, csvRow };
