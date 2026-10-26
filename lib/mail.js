'use strict';
// Email notifications over SMTP. Configure with SMTP_URL (smtps://user:pass@host:465)
// or SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS. MAIL_FROM sets the sender.
const nodemailer = require('nodemailer');

const FROM = process.env.MAIL_FROM || '27 Squared CRM <no-reply@27squaredmarketing.com>';
let transport = null;

function configured() { return !!(process.env.SMTP_URL || process.env.SMTP_HOST); }

function getTransport() {
  if (transport) return transport;
  if (process.env.SMTP_URL) transport = nodemailer.createTransport(process.env.SMTP_URL);
  else if (process.env.SMTP_HOST) transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transport;
}

async function send({ to, subject, html }) {
  if (!configured()) { console.log(`[mail off] to=${to} subject=${subject}`); return { skipped: true }; }
  const footer = `<p style="color:#636466;font-size:12px;margin-top:24px">27 Squared Marketing CRM</p>`;
  return getTransport().sendMail({ from: FROM, to, subject, html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#000">${html}${footer}</div>` });
}

function describe() {
  return { configured: configured(), from: FROM, host: process.env.SMTP_HOST || (process.env.SMTP_URL ? new URL(process.env.SMTP_URL).hostname : null) };
}

module.exports = { configured, send, describe };
