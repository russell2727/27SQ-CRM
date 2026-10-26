'use strict';
// Email engagement: tracked sends, merge tags, sequence scheduler, inbound reply capture over IMAP.
const crypto = require('crypto');
const mailer = require('./mail');

let q, APP_URL, log = console;
function init({ query, appUrl }) { q = query; APP_URL = appUrl; }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SEND_HOUR = Number(process.env.SEQ_SEND_HOUR || 9);
const TZ = process.env.DIGEST_TZ || 'America/New_York';

/* ---------- merge tags ---------- */
function mergeContext({ contact, company, deal, user }) {
  return {
    first_name: contact?.first_name || '', last_name: contact?.last_name || '',
    full_name: [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
    email: contact?.email || '', title: contact?.title || '',
    company: company?.name || '', vertical: deal?.vertical || contact?.vertical || company?.vertical || '',
    deal_name: deal?.name || '', deal_value: deal?.value ? '$' + Number(deal.value).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '',
    sender_name: user?.name || '', sender_email: user?.email || '', sender_first_name: (user?.name || '').split(' ')[0], meeting_link: user?.booking_url || '',
    ...(Object.fromEntries(Object.entries(contact?.custom || {}).map(([k, v]) => ['contact.' + k, v ?? '']))),
  };
}
const MERGE_TAGS = ['first_name', 'last_name', 'full_name', 'email', 'title', 'company', 'vertical', 'deal_name', 'deal_value', 'sender_name', 'sender_first_name', 'sender_email', 'meeting_link'];
function merge(text, ctx) {
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*))?\}\}/g, (m, k, fallback) => {
    const v = ctx[k]; return (v == null || v === '') ? (fallback != null ? fallback.trim() : '') : String(v);
  });
}
function textToHtml(text) {
  return '<p>' + esc(text).replace(/\r?\n\r?\n/g, '</p><p>').replace(/\r?\n/g, '<br>') + '</p>';
}

/* ---------- tracked send ---------- */
async function sendTracked({ contact, deal, user, to, subject, body, enrollmentId = null, stepIndex = null, inReplyTo = null }) {
  const company = contact?.company_id ? (await q('SELECT * FROM companies WHERE id=$1', [contact.company_id])).rows[0] : null;
  const ctx = mergeContext({ contact, company, deal, user });
  const subj = merge(subject, ctx), text = merge(body, ctx);
  const token = crypto.randomBytes(12).toString('hex');
  const fromAddr = (process.env.MAIL_FROM || '').match(/<([^>]+)>/)?.[1] || process.env.MAIL_FROM || process.env.SMTP_USER || '';
  const messageId = `<crm-${token}@${(fromAddr.split('@')[1] || 'crm.local')}>`;
  const signature = user ? `<p style="margin-top:18px">${esc(user.name)}<br><span style="color:#636466">27 Squared Marketing</span></p>` : '';
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#000">${textToHtml(text)}${signature}</div><img src="${APP_URL}/t/${token}.gif" width="1" height="1" alt="" style="display:none">`;
  const replyTo = [user?.email, fromAddr].filter(Boolean);
  const r = await mailer.sendRaw({
    from: user ? `${user.name} via 27 Squared <${fromAddr}>` : undefined,
    to, subject: subj, html, text: text + (user ? `\n\n${user.name}\n27 Squared Marketing` : ''),
    replyTo, messageId, inReplyTo: inReplyTo || undefined, references: inReplyTo || undefined,
  });
  const ins = await q(
    `INSERT INTO emails (direction, contact_id, deal_id, user_id, enrollment_id, step_index, from_email, to_email, subject, body, message_id, in_reply_to, track_token)
     VALUES ('out',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [contact?.id || null, deal?.id || null, user?.id || null, enrollmentId, stepIndex, fromAddr, to, subj, text, r?.messageId || messageId, inReplyTo, token]);
  if (contact?.id) await q('UPDATE contacts SET last_emailed_at=now() WHERE id=$1', [contact.id]);
  await q('INSERT INTO activities (contact_id, deal_id, user_id, type, text) VALUES ($1,$2,$3,$4,$5)',
    [contact?.id || null, deal?.id || null, user?.id || null, 'Email', `Sent: ${subj}${enrollmentId ? ' (sequence)' : ''}`]);
  return ins.rows[0];
}

async function recordOpen(token, ua) {
  if (/bot|crawler|preview|GoogleImageProxy/i.test(ua || '') && false) return; // Gmail proxies opens; we still count them
  const { rows } = await q('UPDATE emails SET open_count=open_count+1, first_opened_at=COALESCE(first_opened_at, now()) WHERE track_token=$1 RETURNING *', [token]);
  const e = rows[0];
  if (e && e.open_count === 1) {
    await q('INSERT INTO activities (contact_id, deal_id, user_id, type, text) VALUES ($1,$2,NULL,$3,$4)', [e.contact_id, e.deal_id, 'Email', `Opened: ${e.subject}`]);
  }
}

/* ---------- sequences ---------- */
// Next send: `delayDays` after `from`, at SEND_HOUR local time, skipping weekends.
function nextSendDate(from, delayDays) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + Number(delayDays || 0));
  // Build the local-TZ date for that day at SEND_HOUR by scanning offset
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  let y = Number(parts.year), m = Number(parts.month), day = Number(parts.day);
  let wd = parts.weekday;
  if (wd === 'Sat') { day += 2; } else if (wd === 'Sun') { day += 1; }
  const target = localToUtc(y, m, day, SEND_HOUR);
  return target;
}
function localToUtc(y, m, d, h) {
  // iterative: guess UTC then correct by the zone offset at that instant
  let guess = new Date(Date.UTC(y, m - 1, d, h, 0, 0));
  for (let i = 0; i < 2; i++) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess).reduce((a, x) => (a[x.type] = x.value, a), {});
    const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
    const want = Date.UTC(y, m - 1, d, h, 0);
    guess = new Date(guess.getTime() + (want - local));
  }
  return guess;
}

async function enroll({ sequence, contactId, dealId, userId, sendFirstNow = true }) {
  const existing = (await q("SELECT 1 FROM enrollments WHERE sequence_id=$1 AND contact_id=$2 AND status='active'", [sequence.id, contactId])).rows[0];
  if (existing) return { skipped: 'already enrolled' };
  const contact = (await q('SELECT * FROM contacts WHERE id=$1', [contactId])).rows[0];
  if (!contact || !contact.email) return { skipped: 'no email' };
  const steps = sequence.steps || [];
  if (!steps.length) return { skipped: 'sequence has no steps' };
  const first = Number(steps[0].delayDays || 0);
  const nextAt = (sendFirstNow && first === 0) ? new Date() : nextSendDate(new Date(), first);
  const { rows } = await q('INSERT INTO enrollments (sequence_id, contact_id, deal_id, user_id, next_send_at) VALUES ($1,$2,$3,$4,$5) RETURNING *', [sequence.id, contactId, dealId || null, userId, nextAt]);
  await q('INSERT INTO activities (contact_id, deal_id, user_id, type, text) VALUES ($1,$2,$3,$4,$5)', [contactId, dealId || null, userId, 'Email', `Enrolled in sequence "${sequence.name}"`]);
  return { enrollment: rows[0] };
}

async function stopEnrollment(id, status, reason) {
  const { rows } = await q("UPDATE enrollments SET status=$2, ended_at=now(), end_reason=$3 WHERE id=$1 AND status='active' RETURNING *", [id, status, reason]);
  const e = rows[0];
  if (e) {
    const s = (await q('SELECT name FROM sequences WHERE id=$1', [e.sequence_id])).rows[0];
    await q('INSERT INTO activities (contact_id, deal_id, user_id, type, text) VALUES ($1,$2,NULL,$3,$4)', [e.contact_id, e.deal_id, 'Email', `Sequence "${s?.name || ''}" ${status === 'replied' ? 'stopped — contact replied' : status === 'completed' ? 'completed' : `stopped (${reason || 'manual'})`}`]);
  }
  return e;
}

async function stopAllForContact(contactId, status, reason) {
  const { rows } = await q("SELECT id FROM enrollments WHERE contact_id=$1 AND status='active'", [contactId]);
  for (const r of rows) await stopEnrollment(r.id, status, reason);
  return rows.length;
}

let seqBusy = false;
async function runDueEnrollments() {
  if (!mailer.configured() || seqBusy) return;
  seqBusy = true;
  try { await _runDue(); } finally { seqBusy = false; }
}
async function _runDue() {
  const { rows } = await q("SELECT id FROM enrollments WHERE status='active' AND next_send_at <= now() ORDER BY next_send_at LIMIT 50");
  for (const { id } of rows) {
    // Atomic claim: push next_send_at out so no other worker/tick picks this row while we send.
    const claim = await q("UPDATE enrollments SET next_send_at = now() + interval '10 minutes' WHERE id=$1 AND status='active' AND next_send_at <= now() RETURNING *", [id]);
    const e = claim.rows[0];
    if (!e) continue;
    try {
      const seq = (await q('SELECT * FROM sequences WHERE id=$1', [e.sequence_id])).rows[0];
      const contact = (await q('SELECT * FROM contacts WHERE id=$1', [e.contact_id])).rows[0];
      const deal = e.deal_id ? (await q('SELECT * FROM deals WHERE id=$1', [e.deal_id])).rows[0] : null;
      const user = e.user_id ? (await q('SELECT * FROM users WHERE id=$1', [e.user_id])).rows[0] : null;
      if (!seq || !seq.active || !contact || !contact.email) { await stopEnrollment(e.id, 'stopped', !seq?.active ? 'sequence paused' : 'contact missing email'); continue; }
      if (contact.last_replied_at && new Date(contact.last_replied_at) > new Date(e.started_at)) { await stopEnrollment(e.id, 'replied', 'reply detected'); continue; }
      const steps = seq.steps || [];
      const step = steps[e.current_step];
      if (!step) { await stopEnrollment(e.id, 'completed', 'all steps sent'); continue; }
      const prev = (await q('SELECT message_id FROM emails WHERE enrollment_id=$1 ORDER BY sent_at ASC LIMIT 1', [e.id])).rows[0];
      await sendTracked({ contact, deal, user, to: contact.email, subject: step.subject, body: step.body, enrollmentId: e.id, stepIndex: e.current_step, inReplyTo: step.threadReply && prev ? prev.message_id : null });
      const nextIdx = e.current_step + 1;
      if (nextIdx >= steps.length) {
        await q("UPDATE enrollments SET current_step=$2, status='completed', ended_at=now(), end_reason='all steps sent', next_send_at=NULL WHERE id=$1", [e.id, nextIdx]);
      } else {
        await q('UPDATE enrollments SET current_step=$2, next_send_at=$3 WHERE id=$1', [e.id, nextIdx, nextSendDate(new Date(), steps[nextIdx].delayDays)]);
      }
    } catch (err) {
      log.error('Sequence send failed for enrollment', e.id, err.message);
      await q("UPDATE enrollments SET status='failed', ended_at=now(), end_reason=$2 WHERE id=$1", [e.id, err.message.slice(0, 200)]);
    }
  }
}

/* ---------- inbound (IMAP) ---------- */
function imapConfigured() { return !!((process.env.IMAP_HOST || /gmail/i.test(process.env.SMTP_HOST || '')) && process.env.SMTP_USER && process.env.SMTP_PASS); }
let imapBusy = false;
async function pollInbox() {
  if (!imapConfigured() || imapBusy) return;
  imapBusy = true;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.gmail.com', port: Number(process.env.IMAP_PORT || 993), secure: true,
    auth: { user: process.env.IMAP_USER || process.env.SMTP_USER, pass: process.env.IMAP_PASS || process.env.SMTP_PASS }, logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const last = Number((await q("SELECT value FROM meta WHERE key='imap_last_uid'")).rows[0]?.value || 0);
      const users = (await q('SELECT id, email, name FROM users')).rows;
      const userByEmail = Object.fromEntries(users.map(u => [u.email.toLowerCase(), u]));
      const selfAddr = (process.env.IMAP_USER || process.env.SMTP_USER || '').toLowerCase();
      let maxUid = last;
      const range = last ? `${last + 1}:*` : '1:*';
      // On first run, only look at the most recent 50 to avoid ingesting history
      let uids = await client.search({ uid: range }, { uid: true });
      if (!last) uids = uids.slice(-50);
      for (const uid of uids) {
        if (uid <= last) continue;
        maxUid = Math.max(maxUid, uid);
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!msg?.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = (parsed.from?.value?.[0]?.address || '').toLowerCase();
        const tos = [...(parsed.to?.value || []), ...(parsed.cc?.value || [])].map(a => (a.address || '').toLowerCase()).filter(a => a && a !== selfAddr);
        const messageId = parsed.messageId || null;
        if (messageId && (await q('SELECT 1 FROM emails WHERE message_id=$1', [messageId])).rows[0]) continue;
        const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])].filter(Boolean);
        const subject = parsed.subject || '(no subject)';
        const snippet = (parsed.text || '').replace(/\r?\n>.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 500);
        const teamSender = userByEmail[from];
        if (teamSender) {
          // A teammate BCC'd the CRM: log as a sent email to any matching contacts
          for (const to of tos) {
            const c = (await q('SELECT * FROM contacts WHERE lower(email)=$1 LIMIT 1', [to])).rows[0];
            if (!c) continue;
            await q(`INSERT INTO emails (direction, contact_id, user_id, from_email, to_email, subject, body, message_id, in_reply_to) VALUES ('out',$1,$2,$3,$4,$5,$6,$7,$8)`,
              [c.id, teamSender.id, from, to, subject, snippet, messageId, parsed.inReplyTo || null]);
            await q('UPDATE contacts SET last_emailed_at=now() WHERE id=$1', [c.id]);
            await q('INSERT INTO activities (contact_id, user_id, type, text) VALUES ($1,$2,$3,$4)', [c.id, teamSender.id, 'Email', `Sent (logged from Gmail): ${subject}`]);
          }
          continue;
        }
        // Otherwise: a reply/inbound from a contact
        let contact = (await q('SELECT * FROM contacts WHERE lower(email)=$1 LIMIT 1', [from])).rows[0];
        let original = null;
        if (refs.length) original = (await q('SELECT * FROM emails WHERE message_id = ANY($1) ORDER BY sent_at DESC LIMIT 1', [refs])).rows[0];
        if (!contact && original?.contact_id) contact = (await q('SELECT * FROM contacts WHERE id=$1', [original.contact_id])).rows[0];
        if (!contact) continue;
        await q(`INSERT INTO emails (direction, contact_id, deal_id, from_email, to_email, subject, body, message_id, in_reply_to) VALUES ('in',$1,$2,$3,$4,$5,$6,$7,$8)`,
          [contact.id, original?.deal_id || null, from, tos.join(', '), subject, snippet, messageId, parsed.inReplyTo || null]);
        await q('UPDATE contacts SET last_replied_at=now() WHERE id=$1', [contact.id]);
        await q('INSERT INTO activities (contact_id, deal_id, type, text) VALUES ($1,$2,$3,$4)', [contact.id, original?.deal_id || null, 'Email', `Received: ${subject}${snippet ? ' — ' + snippet.slice(0, 140) : ''}`]);
        const stopped = await stopAllForContact(contact.id, 'replied', 'reply detected');
        // Notify the owner / original sender
        const notifyIds = new Set([contact.owner_id, original?.user_id].filter(Boolean));
        for (const uid2 of notifyIds) {
          const u = users.find(x => x.id === uid2); if (!u) continue;
          mailer.send({ to: u.email, subject: `Reply from ${[contact.first_name, contact.last_name].filter(Boolean).join(' ')}: ${subject}`, html: `<p><b>${esc(from)}</b> replied${stopped ? ' (sequence stopped)' : ''}:</p><blockquote style="border-left:3px solid #EC008C;padding-left:10px;color:#333">${esc(snippet)}</blockquote><p><a href="${APP_URL}/#contact/${contact.id}">Open contact</a></p>` }).catch(() => {});
        }
      }
      if (maxUid > last) await q("INSERT INTO meta (key,value) VALUES ('imap_last_uid',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [String(maxUid)]);
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    log.error('Inbox poll failed:', e.message);
    try { await client.logout(); } catch {}
  } finally { imapBusy = false; }
}

module.exports = { init, MERGE_TAGS, merge, mergeContext, sendTracked, recordOpen, enroll, stopEnrollment, stopAllForContact, runDueEnrollments, pollInbox, imapConfigured, nextSendDate };
