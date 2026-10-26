const nodemailer = require('nodemailer');

function createTransport(db) {
  const m = db.prepare('SELECT * FROM mail_settings WHERE id = 1').get();
  if (!m || !m.host) throw new Error('Mail server is not configured (Settings → Mail Server).');
  return {
    from: m.from_name ? `"${m.from_name}" <${m.from_email}>` : m.from_email,
    transporter: nodemailer.createTransport({
      host: m.host,
      port: m.port || 587,
      secure: !!m.secure,
      auth: m.username ? { user: m.username, pass: m.password } : undefined,
    }),
  };
}

async function sendMail(db, { to, subject, html }) {
  const { transporter, from } = createTransport(db);
  return transporter.sendMail({ from, to, subject, html });
}

module.exports = { sendMail };
