'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // DATE columns as 'YYYY-MM-DD' strings, not JS Dates
const mailer = require('./lib/mail');
const docusign = require('./lib/docusign');
const engage = require('./lib/engage');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RENDER;
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set — using a random one; every deploy will log all users out.');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

const STAGES = ['New lead', 'Contacted', 'Qualified', 'Proposal sent', 'Closed won'];
const SIGN_STAGES = ['Proposal sent', 'Closed won'];

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);

// DocuSign Connect webhook needs the raw body for HMAC verification; mount before json().
app.post('/api/docusign/webhook', express.raw({ type: '*/*', limit: '10mb' }), (req, res, next) => handleWebhook(req, res).catch(next));

app.use(express.json({ limit: '20mb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  name: 'crm.sid',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 24 * 14 },
}));

/* ---------- helpers ---------- */
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Sign in required' });
const requireAdmin = (req, res, next) => req.session.user && req.session.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const str = v => (v == null ? '' : String(v)).trim();
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; };
const intOrNull = v => { const n = Number(v); return v !== '' && v != null && Number.isInteger(n) ? n : null; };
const dateOrNull = v => { const s = str(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.created_at });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const contactOut = r => ({
  id: r.id, first: r.first_name, last: r.last_name, title: r.title, email: r.email, phone: r.phone,
  companyId: r.company_id, vertical: r.vertical, source: r.source, notes: r.notes,
  ownerId: r.owner_id, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  custom: r.custom || {}, lastEmailedAt: r.last_emailed_at, lastRepliedAt: r.last_replied_at,
});
const companyOut = r => ({
  id: r.id, name: r.name, domain: r.domain, phone: r.phone, vertical: r.vertical, size: r.size,
  city: r.city, state: r.state, notes: r.notes, createdAt: r.created_at, custom: r.custom || {},
});
const dealOut = r => ({
  id: r.id, name: r.name, contactId: r.contact_id, companyId: r.company_id, stage: r.stage, value: Number(r.value),
  vertical: r.vertical, source: r.source, expectedClose: r.expected_close || null, notes: r.notes,
  lost: r.lost, lostAt: r.lost_at, wonAt: r.won_at, stageHistory: r.stage_history || [],
  ownerId: r.owner_id, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, custom: r.custom || {},
});
const taskOut = r => ({
  id: r.id, title: r.title, dueAt: r.due_at || null, done: r.done, doneAt: r.done_at,
  dealId: r.deal_id, contactId: r.contact_id, assigneeId: r.assignee_id, createdBy: r.created_by, createdAt: r.created_at,
});
const envelopeOut = r => ({
  id: r.id, dealId: r.deal_id, envelopeId: r.envelope_id, templateId: r.template_id, templateName: r.template_name,
  signerName: r.signer_name, signerEmail: r.signer_email, status: r.status, sentBy: r.sent_by, sentAt: r.sent_at, completedAt: r.completed_at,
});
const activityOut = r => ({ id: r.id, contactId: r.contact_id, dealId: r.deal_id, userId: r.user_id, userName: r.user_name, type: r.type, text: r.text, at: r.created_at });

async function logActivity({ contactId = null, dealId = null, userId = null, type = 'Note', text }) {
  await q('INSERT INTO activities (contact_id, deal_id, user_id, type, text) VALUES ($1,$2,$3,$4,$5)', [contactId, dealId, userId, type, text]);
}
async function userById(id) { if (!id) return null; const { rows } = await q('SELECT * FROM users WHERE id=$1 AND active', [id]); return rows[0] || null; }
async function dealById(id) { const { rows } = await q('SELECT * FROM deals WHERE id=$1', [id]); return rows[0] || null; }
const dealLink = id => `${APP_URL}/#deal/${id}`;

/* ---------- custom properties ---------- */
let PROPS = []; // cache: rows from properties
async function loadProps() { PROPS = (await q('SELECT * FROM properties ORDER BY object, sort, id')).rows; }
function cleanCustom(object, input) {
  const out = {}; const src = input && typeof input === 'object' ? input : {};
  for (const p of PROPS.filter(x => x.object === object)) {
    let v = src[p.key];
    if (v == null || v === '') continue;
    if (p.type === 'number') { const n = Number(v); if (!Number.isFinite(n)) continue; v = n; }
    else if (p.type === 'checkbox') v = v === true || v === 'true' || v === 'on' || v === 1;
    else if (p.type === 'date') { v = str(v); if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) continue; }
    else if (p.type === 'select') { v = str(v); if (!(p.options || []).includes(v)) continue; }
    else v = str(v).slice(0, 5000);
    out[p.key] = v;
  }
  return out;
}
const propOut = r => ({ id: r.id, object: r.object, key: r.key, label: r.label, type: r.type, options: r.options || [], sort: r.sort });
const emailOut = r => ({ id: r.id, direction: r.direction, contactId: r.contact_id, dealId: r.deal_id, userId: r.user_id, enrollmentId: r.enrollment_id, stepIndex: r.step_index, from: r.from_email, to: r.to_email, subject: r.subject, body: r.body, openCount: r.open_count, firstOpenedAt: r.first_opened_at, sentAt: r.sent_at });
const sequenceOut = r => ({ id: r.id, name: r.name, steps: r.steps || [], active: r.active, createdBy: r.created_by, createdAt: r.created_at });
const enrollmentOut = r => ({ id: r.id, sequenceId: r.sequence_id, contactId: r.contact_id, dealId: r.deal_id, userId: r.user_id, status: r.status, currentStep: r.current_step, nextSendAt: r.next_send_at, startedAt: r.started_at, endedAt: r.ended_at, endReason: r.end_reason });

/* ---------- notifications ---------- */
async function notifyUser(userId, subject, html, actorId) {
  if (!userId || String(userId) === String(actorId)) return;
  const u = await userById(userId);
  if (!u) return;
  mailer.send({ to: u.email, subject, html }).catch(e => console.error('Mail failed:', e.message));
}

/* ---------- auth ---------- */
app.get('/api/auth/status', wrap(async (req, res) => {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  res.json({ needsSetup: rows[0].n === 0, user: req.session.user || null });
}));

app.post('/api/auth/setup', wrap(async (req, res) => {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return res.status(403).json({ error: 'Setup already completed' });
  const email = str(req.body.email).toLowerCase(), name = str(req.body.name), password = String(req.body.password || '');
  if (!email || !name || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required' });
  const ins = await q('INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *', [email, name, await bcrypt.hash(password, 11), 'admin']);
  req.session.user = publicUser(ins.rows[0]);
  res.json({ user: req.session.user });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase(), password = String(req.body.password || '');
  const { rows } = await q('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Email or password is incorrect' });
  req.session.user = publicUser(u);
  res.json({ user: req.session.user });
}));

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.post('/api/auth/password', requireAuth, wrap(async (req, res) => {
  const current = String(req.body.current || ''), next = String(req.body.next || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be 8+ characters' });
  const { rows } = await q('SELECT * FROM users WHERE id=$1', [req.session.user.id]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) return res.status(400).json({ error: 'Current password is incorrect' });
  await q('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(next, 11), req.session.user.id]);
  res.json({ ok: true });
}));

/* ---------- bootstrap ---------- */
app.get('/api/bootstrap', requireAuth, wrap(async (req, res) => {
  const [contacts, companies, deals, tasks, envelopes, users, sequences, enrollments] = await Promise.all([
    q('SELECT * FROM contacts ORDER BY created_at DESC'),
    q('SELECT * FROM companies ORDER BY name'),
    q('SELECT * FROM deals ORDER BY created_at DESC'),
    q('SELECT * FROM tasks ORDER BY done, due_at NULLS LAST, created_at'),
    q('SELECT * FROM envelopes ORDER BY sent_at DESC'),
    q('SELECT id, name, email, role, active, created_at FROM users ORDER BY name'),
    q('SELECT * FROM sequences ORDER BY name'),
    q('SELECT * FROM enrollments ORDER BY started_at DESC'),
  ]);
  res.json({
    user: req.session.user,
    contacts: contacts.rows.map(contactOut),
    companies: companies.rows.map(companyOut),
    deals: deals.rows.map(dealOut),
    tasks: tasks.rows.map(taskOut),
    envelopes: envelopes.rows.map(envelopeOut),
    users: users.rows.map(publicUser),
    sequences: sequences.rows.map(sequenceOut),
    enrollments: enrollments.rows.map(enrollmentOut),
    properties: PROPS.map(propOut),
    mergeTags: engage.MERGE_TAGS,
    stages: STAGES,
    signStages: SIGN_STAGES,
    integrations: { docusign: docusign.configured(), email: mailer.configured(), inbound: engage.imapConfigured() },
  });
}));

/* ---------- companies ---------- */
const companyFields = b => [str(b.name), str(b.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, ''), str(b.phone), str(b.vertical), str(b.size), str(b.city), str(b.state), str(b.notes)];

app.post('/api/companies', requireAuth, wrap(async (req, res) => {
  const f = companyFields(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Company name is required' });
  const { rows } = await q('INSERT INTO companies (name,domain,phone,vertical,size,city,state,notes,created_by,custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *', [...f, req.session.user.id, JSON.stringify(cleanCustom('company', req.body.custom))]);
  res.json(companyOut(rows[0]));
}));
app.put('/api/companies/:id', requireAuth, wrap(async (req, res) => {
  const f = companyFields(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Company name is required' });
  const { rows } = await q('UPDATE companies SET name=$1,domain=$2,phone=$3,vertical=$4,size=$5,city=$6,state=$7,notes=$8,custom=$10,updated_at=now() WHERE id=$9 RETURNING *', [...f, req.params.id, JSON.stringify(cleanCustom('company', req.body.custom))]);
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json(companyOut(rows[0]));
}));
app.delete('/api/companies/:id', requireAuth, wrap(async (req, res) => {
  await q('DELETE FROM companies WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- contacts ---------- */
const contactFields = b => ({
  first: str(b.first), last: str(b.last), title: str(b.title), email: str(b.email).toLowerCase(), phone: str(b.phone),
  companyId: intOrNull(b.companyId), vertical: str(b.vertical), source: str(b.source), notes: str(b.notes), ownerId: intOrNull(b.ownerId),
});

app.post('/api/contacts', requireAuth, wrap(async (req, res) => {
  const f = contactFields(req.body);
  if (!f.first && !f.last) return res.status(400).json({ error: 'Add at least a first or last name' });
  const { rows } = await q(
    `INSERT INTO contacts (first_name,last_name,title,email,phone,company_id,vertical,source,notes,owner_id,created_by,deal_migrated,custom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12) RETURNING *`,
    [f.first, f.last, f.title, f.email, f.phone, f.companyId, f.vertical, f.source, f.notes, f.ownerId || req.session.user.id, req.session.user.id, JSON.stringify(cleanCustom('contact', req.body.custom))]);
  const contact = rows[0];
  let deal = null;
  if (req.body.createDeal) {
    deal = await createDeal({
      name: str(req.body.dealName) || (contact.company_id ? (await q('SELECT name FROM companies WHERE id=$1', [contact.company_id])).rows[0]?.name : '') || `${f.first} ${f.last}`.trim(),
      contactId: contact.id, companyId: contact.company_id, stage: STAGES.includes(req.body.stage) ? req.body.stage : 'New lead',
      value: num(req.body.value), vertical: f.vertical, source: f.source, ownerId: contact.owner_id, expectedClose: null, notes: '',
    }, req.session.user.id);
  }
  res.json({ contact: contactOut(contact), deal: deal && dealOut(deal) });
}));

app.put('/api/contacts/:id', requireAuth, wrap(async (req, res) => {
  const f = contactFields(req.body);
  if (!f.first && !f.last) return res.status(400).json({ error: 'Add at least a first or last name' });
  const { rows } = await q(
    `UPDATE contacts SET first_name=$1,last_name=$2,title=$3,email=$4,phone=$5,company_id=$6,vertical=$7,source=$8,notes=$9,owner_id=$10,custom=$12,updated_at=now() WHERE id=$11 RETURNING *`,
    [f.first, f.last, f.title, f.email, f.phone, f.companyId, f.vertical, f.source, f.notes, f.ownerId, req.params.id, JSON.stringify(cleanCustom('contact', req.body.custom))]);
  if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
  res.json(contactOut(rows[0]));
}));

app.delete('/api/contacts/:id', requireAuth, wrap(async (req, res) => {
  await q('DELETE FROM contacts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- deals ---------- */
const dealFields = b => ({
  name: str(b.name), contactId: intOrNull(b.contactId), companyId: intOrNull(b.companyId),
  stage: STAGES.includes(b.stage) ? b.stage : 'New lead', value: num(b.value), vertical: str(b.vertical), source: str(b.source),
  expectedClose: dateOrNull(b.expectedClose), notes: str(b.notes), ownerId: intOrNull(b.ownerId), custom: cleanCustom('deal', b.custom),
});

async function createDeal(f, actorId) {
  const history = JSON.stringify([{ stage: f.stage, at: new Date().toISOString(), by: actorId }]);
  const wonAt = f.stage === 'Closed won' ? new Date() : null;
  const { rows } = await q(
    `INSERT INTO deals (name,contact_id,company_id,stage,value,vertical,source,expected_close,notes,owner_id,created_by,stage_history,won_at,custom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [f.name, f.contactId, f.companyId, f.stage, f.value, f.vertical, f.source, f.expectedClose, f.notes, f.ownerId || actorId, actorId, history, wonAt, JSON.stringify(f.custom || {})]);
  const d = rows[0];
  if (d.owner_id && String(d.owner_id) !== String(actorId)) {
    const actor = await userById(actorId);
    await notifyUser(d.owner_id, `Deal assigned to you: ${d.name}`,
      `<p>${esc(actor?.name || 'A teammate')} assigned you the deal <b>${esc(d.name)}</b> (${esc(d.stage)}).</p><p><a href="${dealLink(d.id)}">Open it in the CRM</a></p>`, actorId);
  }
  return d;
}

app.post('/api/deals', requireAuth, wrap(async (req, res) => {
  const f = dealFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Deal name is required' });
  if (!f.companyId && f.contactId) f.companyId = (await q('SELECT company_id FROM contacts WHERE id=$1', [f.contactId])).rows[0]?.company_id || null;
  const d = await createDeal(f, req.session.user.id);
  res.json(dealOut(d));
}));

app.put('/api/deals/:id', requireAuth, wrap(async (req, res) => {
  const f = dealFields(req.body);
  if (!f.name) return res.status(400).json({ error: 'Deal name is required' });
  const cur = await dealById(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Deal not found' });
  let history = cur.stage_history || [], wonAt = cur.won_at;
  const me = req.session.user;
  if (cur.stage !== f.stage) {
    history = [...history, { stage: f.stage, at: new Date().toISOString(), by: me.id }];
    if (f.stage === 'Closed won') wonAt = new Date();
    await logActivity({ dealId: cur.id, contactId: cur.contact_id, userId: me.id, text: `Moved to ${f.stage}` });
    await notifyUser(cur.owner_id, `${cur.name}: moved to ${f.stage}`, `<p>${esc(me.name)} moved <b>${esc(cur.name)}</b> to <b>${esc(f.stage)}</b>.</p><p><a href="${dealLink(cur.id)}">Open deal</a></p>`, me.id);
  }
  const { rows } = await q(
    `UPDATE deals SET name=$1,contact_id=$2,company_id=$3,stage=$4,value=$5,vertical=$6,source=$7,expected_close=$8,notes=$9,owner_id=$10,stage_history=$11,won_at=$12,custom=$14,updated_at=now()
     WHERE id=$13 RETURNING *`,
    [f.name, f.contactId, f.companyId, f.stage, f.value, f.vertical, f.source, f.expectedClose, f.notes, f.ownerId, JSON.stringify(history), wonAt, req.params.id, JSON.stringify(f.custom)]);
  if (f.ownerId && String(f.ownerId) !== String(cur.owner_id)) {
    await notifyUser(f.ownerId, `Deal assigned to you: ${f.name}`, `<p>${esc(me.name)} assigned you the deal <b>${esc(f.name)}</b> (${esc(f.stage)}).</p><p><a href="${dealLink(cur.id)}">Open deal</a></p>`, me.id);
  }
  res.json(dealOut(rows[0]));
}));

app.patch('/api/deals/:id/stage', requireAuth, wrap(async (req, res) => {
  const stage = req.body.stage;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
  const cur = await dealById(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Deal not found' });
  if (cur.stage === stage && !cur.lost) return res.json(dealOut(cur));
  const me = req.session.user;
  const history = [...(cur.stage_history || []), { stage, at: new Date().toISOString(), by: me.id }];
  const wonAt = stage === 'Closed won' ? new Date() : cur.won_at;
  const { rows } = await q('UPDATE deals SET stage=$1, lost=FALSE, lost_at=NULL, stage_history=$2, won_at=$3, updated_at=now() WHERE id=$4 RETURNING *', [stage, JSON.stringify(history), wonAt, cur.id]);
  await logActivity({ dealId: cur.id, contactId: cur.contact_id, userId: me.id, text: `Moved to ${stage}` });
  if (stage === 'Closed won' && cur.contact_id) await engage.stopAllForContact(cur.contact_id, 'stopped', 'deal closed won');
  await notifyUser(cur.owner_id, `${cur.name}: moved to ${stage}`, `<p>${esc(me.name)} moved <b>${esc(cur.name)}</b> to <b>${esc(stage)}</b>.</p><p><a href="${dealLink(cur.id)}">Open deal</a></p>`, me.id);
  res.json(dealOut(rows[0]));
}));

app.patch('/api/deals/:id/lost', requireAuth, wrap(async (req, res) => {
  const lost = !!req.body.lost;
  const { rows } = await q('UPDATE deals SET lost=$1, lost_at=$2, updated_at=now() WHERE id=$3 RETURNING *', [lost, lost ? new Date() : null, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Deal not found' });
  await logActivity({ dealId: rows[0].id, contactId: rows[0].contact_id, userId: req.session.user.id, text: lost ? 'Marked lost' : 'Reopened' });
  if (lost && rows[0].contact_id) await engage.stopAllForContact(rows[0].contact_id, 'stopped', 'deal marked lost');
  res.json(dealOut(rows[0]));
}));

app.delete('/api/deals/:id', requireAuth, wrap(async (req, res) => {
  await q('DELETE FROM deals WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- activities ---------- */
app.get('/api/activities', requireAuth, wrap(async (req, res) => {
  const where = req.query.dealId ? ['a.deal_id=$1', req.query.dealId] : req.query.contactId ? ['a.contact_id=$1', req.query.contactId] : null;
  if (!where) return res.status(400).json({ error: 'dealId or contactId required' });
  const { rows } = await q(`SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE ${where[0]} ORDER BY a.created_at DESC LIMIT 200`, [where[1]]);
  res.json(rows.map(activityOut));
}));
app.post('/api/activities', requireAuth, wrap(async (req, res) => {
  const text = str(req.body.text), type = str(req.body.type) || 'Note';
  const dealId = intOrNull(req.body.dealId), contactId = intOrNull(req.body.contactId);
  if (!text) return res.status(400).json({ error: 'Activity text is required' });
  if (!dealId && !contactId) return res.status(400).json({ error: 'dealId or contactId required' });
  let cid = contactId;
  if (dealId && !cid) cid = (await dealById(dealId))?.contact_id || null;
  await logActivity({ dealId, contactId: cid, userId: req.session.user.id, type, text });
  res.json({ ok: true });
}));

/* ---------- tasks ---------- */
app.post('/api/tasks', requireAuth, wrap(async (req, res) => {
  const title = str(req.body.title); if (!title) return res.status(400).json({ error: 'Task title is required' });
  const dealId = intOrNull(req.body.dealId), assigneeId = intOrNull(req.body.assigneeId) || req.session.user.id;
  let contactId = intOrNull(req.body.contactId);
  if (dealId && !contactId) contactId = (await dealById(dealId))?.contact_id || null;
  const { rows } = await q('INSERT INTO tasks (title,due_at,deal_id,contact_id,assignee_id,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [title, dateOrNull(req.body.dueAt), dealId, contactId, assigneeId, req.session.user.id]);
  const t = rows[0];
  if (String(assigneeId) !== String(req.session.user.id)) {
    const d = dealId ? await dealById(dealId) : null;
    await notifyUser(assigneeId, `Task for you: ${title}`, `<p>${esc(req.session.user.name)} assigned you a task${d ? ` on <b>${esc(d.name)}</b>` : ''}:</p><p><b>${esc(title)}</b>${t.due_at ? ` — due ${String(t.due_at).slice(0, 10)}` : ''}</p><p><a href="${APP_URL}/#tasks">Open tasks</a></p>`, req.session.user.id);
  }
  res.json(taskOut(t));
}));
app.put('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM tasks WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Task not found' });
  const title = req.body.title != null ? str(req.body.title) : cur.title;
  const done = req.body.done != null ? !!req.body.done : cur.done;
  const dueAt = req.body.dueAt !== undefined ? dateOrNull(req.body.dueAt) : cur.due_at;
  const assigneeId = req.body.assigneeId !== undefined ? intOrNull(req.body.assigneeId) : cur.assignee_id;
  const { rows } = await q('UPDATE tasks SET title=$1, done=$2, done_at=$3, due_at=$4, assignee_id=$5 WHERE id=$6 RETURNING *',
    [title, done, done ? (cur.done ? cur.done_at : new Date()) : null, dueAt, assigneeId, req.params.id]);
  res.json(taskOut(rows[0]));
}));
app.delete('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
  await q('DELETE FROM tasks WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- CSV import ---------- */
async function findOrCreateCompany(name, extra, userId, cache) {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let row = (await q('SELECT id FROM companies WHERE lower(name)=$1 LIMIT 1', [key])).rows[0];
  if (!row) {
    row = (await q('INSERT INTO companies (name,domain,phone,vertical,size,city,state,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [name, str(extra.domain), str(extra.phone), str(extra.vertical), str(extra.size), str(extra.city), str(extra.state), str(extra.notes), userId])).rows[0];
    cache.set(key, { id: row.id, created: true });
  } else cache.set(key, { id: row.id, created: false });
  return cache.get(key);
}

app.post('/api/import/companies', requireAuth, wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
  const cache = new Map(); let created = 0, skipped = 0;
  for (const r of rows) {
    const name = str(r.name); if (!name) { skipped++; continue; }
    const c = await findOrCreateCompany(name, r, req.session.user.id, cache);
    if (c.created) { created++; const cust = cleanCustom('company', r.custom); if (Object.keys(cust).length) await q('UPDATE companies SET custom=$2 WHERE id=$1', [c.id, JSON.stringify(cust)]); } else skipped++;
    c.created = false;
  }
  res.json({ created, skipped });
}));

app.post('/api/import/contacts', requireAuth, wrap(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 5000) : [];
  const createDeals = !!req.body.createDeals, stage = STAGES.includes(req.body.stage) ? req.body.stage : 'New lead';
  const ownerId = intOrNull(req.body.ownerId) || req.session.user.id;
  const cache = new Map(); let created = 0, skipped = 0, companies = 0, deals = 0;
  const existingEmails = new Set((await q("SELECT lower(email) AS e FROM contacts WHERE email<>''")).rows.map(x => x.e));
  for (const r of rows) {
    const first = str(r.first), last = str(r.last), email = str(r.email).toLowerCase();
    if (!first && !last && !email) { skipped++; continue; }
    if (email && existingEmails.has(email)) { skipped++; continue; }
    let companyId = null;
    const coName = str(r.company);
    if (coName) { const c = await findOrCreateCompany(coName, { vertical: r.vertical, domain: r.domainName }, req.session.user.id, cache); companyId = c.id; if (c.created) { companies++; c.created = false; } }
    const ins = await q(
      `INSERT INTO contacts (first_name,last_name,title,email,phone,company_id,vertical,source,notes,owner_id,created_by,deal_migrated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE) RETURNING *`,
      [first, last, str(r.title), email, str(r.phone), companyId, str(r.vertical), str(r.source) || 'Import', str(r.notes), ownerId, req.session.user.id]);
    const cust = cleanCustom('contact', r.custom); if (Object.keys(cust).length) await q('UPDATE contacts SET custom=$2 WHERE id=$1', [ins.rows[0].id, JSON.stringify(cust)]);
    if (email) existingEmails.add(email);
    created++;
    if (createDeals) {
      await q(`INSERT INTO deals (name,contact_id,company_id,stage,value,vertical,source,owner_id,created_by,stage_history)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [coName || `${first} ${last}`.trim(), ins.rows[0].id, companyId, stage, num(r.value), str(r.vertical), str(r.source) || 'Import', ownerId, req.session.user.id,
          JSON.stringify([{ stage, at: new Date().toISOString(), by: req.session.user.id }])]);
      deals++;
    }
  }
  res.json({ created, skipped, companies, deals });
}));

/* ---------- properties (admin) ---------- */
const PROP_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'checkbox'];
app.post('/api/properties', requireAdmin, wrap(async (req, res) => {
  const object = ['contact', 'company', 'deal'].includes(req.body.object) ? req.body.object : null;
  const label = str(req.body.label); const type = PROP_TYPES.includes(req.body.type) ? req.body.type : 'text';
  let key = str(req.body.key) || label; key = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!object || !label || !key) return res.status(400).json({ error: 'Object, label and key are required' });
  const options = type === 'select' ? (Array.isArray(req.body.options) ? req.body.options : String(req.body.options || '').split(/\n|,/)).map(str).filter(Boolean) : [];
  if ((await q('SELECT 1 FROM properties WHERE object=$1 AND key=$2', [object, key])).rows[0]) return res.status(409).json({ error: `A ${object} property with key "${key}" already exists` });
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM properties WHERE object=$1', [object])).rows[0].s;
  const { rows } = await q('INSERT INTO properties (object,key,label,type,options,sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [object, key, label, type, JSON.stringify(options), sort]);
  await loadProps(); res.json(propOut(rows[0]));
}));
app.put('/api/properties/:id', requireAdmin, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM properties WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Property not found' });
  const label = str(req.body.label) || cur.label;
  const options = cur.type === 'select' ? (Array.isArray(req.body.options) ? req.body.options : String(req.body.options ?? (cur.options || []).join('\n')).split(/\n|,/)).map(str).filter(Boolean) : [];
  const sort = req.body.sort != null ? Number(req.body.sort) : cur.sort;
  const { rows } = await q('UPDATE properties SET label=$2, options=$3, sort=$4 WHERE id=$1 RETURNING *', [cur.id, label, JSON.stringify(options), sort]);
  await loadProps(); res.json(propOut(rows[0]));
}));
app.delete('/api/properties/:id', requireAdmin, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM properties WHERE id=$1', [req.params.id])).rows[0];
  if (cur) {
    await q('DELETE FROM properties WHERE id=$1', [cur.id]);
    const table = { contact: 'contacts', company: 'companies', deal: 'deals' }[cur.object];
    await q(`UPDATE ${table} SET custom = custom - $1 WHERE custom ? $1`, [cur.key]);
    await loadProps();
  }
  res.json({ ok: true });
}));

/* ---------- email ---------- */
app.get('/api/emails', requireAuth, wrap(async (req, res) => {
  const where = req.query.contactId ? ['contact_id=$1', req.query.contactId] : req.query.dealId ? ['deal_id=$1', req.query.dealId] : null;
  if (!where) return res.status(400).json({ error: 'contactId or dealId required' });
  const { rows } = await q(`SELECT * FROM emails WHERE ${where[0]} ORDER BY sent_at DESC LIMIT 100`, [where[1]]);
  res.json(rows.map(emailOut));
}));
app.post('/api/emails/preview', requireAuth, wrap(async (req, res) => {
  const contact = req.body.contactId ? (await q('SELECT * FROM contacts WHERE id=$1', [req.body.contactId])).rows[0] : null;
  const deal = req.body.dealId ? (await q('SELECT * FROM deals WHERE id=$1', [req.body.dealId])).rows[0] : null;
  const company = contact?.company_id ? (await q('SELECT * FROM companies WHERE id=$1', [contact.company_id])).rows[0] : null;
  const user = (await q('SELECT * FROM users WHERE id=$1', [req.session.user.id])).rows[0];
  const ctx = engage.mergeContext({ contact, company, deal, user });
  res.json({ subject: engage.merge(req.body.subject, ctx), body: engage.merge(req.body.body, ctx) });
}));
app.post('/api/emails', requireAuth, wrap(async (req, res) => {
  if (!mailer.configured()) return res.status(400).json({ error: 'Email is not configured (Settings)' });
  const contact = req.body.contactId ? (await q('SELECT * FROM contacts WHERE id=$1', [req.body.contactId])).rows[0] : null;
  const deal = req.body.dealId ? (await q('SELECT * FROM deals WHERE id=$1', [req.body.dealId])).rows[0] : null;
  const to = str(req.body.to) || contact?.email;
  const subject = str(req.body.subject), body = str(req.body.body);
  if (!to || !subject || !body) return res.status(400).json({ error: 'Recipient, subject and body are required' });
  const user = (await q('SELECT * FROM users WHERE id=$1', [req.session.user.id])).rows[0];
  const e = await engage.sendTracked({ contact, deal, user, to, subject, body });
  res.json(emailOut(e));
}));
app.get('/t/:token.gif', wrap(async (req, res) => {
  engage.recordOpen(req.params.token, req.headers['user-agent']).catch(() => {});
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' });
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
}));

/* ---------- sequences ---------- */
const cleanSteps = steps => (Array.isArray(steps) ? steps : []).map((s, i) => ({
  delayDays: Math.max(0, Math.min(90, Number(s.delayDays) || (i === 0 ? 0 : 1))),
  subject: str(s.subject).slice(0, 300), body: str(s.body).slice(0, 20000), threadReply: !!s.threadReply,
})).filter(s => s.subject && s.body).slice(0, 12);

app.post('/api/sequences', requireAuth, wrap(async (req, res) => {
  const name = str(req.body.name), steps = cleanSteps(req.body.steps);
  if (!name) return res.status(400).json({ error: 'Sequence name is required' });
  const { rows } = await q('INSERT INTO sequences (name, steps, active, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [name, JSON.stringify(steps), req.body.active !== false, req.session.user.id]);
  res.json(sequenceOut(rows[0]));
}));
app.put('/api/sequences/:id', requireAuth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM sequences WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Sequence not found' });
  const name = req.body.name != null ? str(req.body.name) || cur.name : cur.name;
  const steps = req.body.steps != null ? cleanSteps(req.body.steps) : cur.steps;
  const active = req.body.active != null ? !!req.body.active : cur.active;
  const { rows } = await q('UPDATE sequences SET name=$2, steps=$3, active=$4, updated_at=now() WHERE id=$1 RETURNING *', [cur.id, name, JSON.stringify(steps), active]);
  res.json(sequenceOut(rows[0]));
}));
app.delete('/api/sequences/:id', requireAuth, wrap(async (req, res) => {
  await q('DELETE FROM sequences WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));
app.post('/api/sequences/:id/enroll', requireAuth, wrap(async (req, res) => {
  if (!mailer.configured()) return res.status(400).json({ error: 'Email is not configured (Settings)' });
  const seq = (await q('SELECT * FROM sequences WHERE id=$1', [req.params.id])).rows[0];
  if (!seq) return res.status(404).json({ error: 'Sequence not found' });
  if (!seq.active) return res.status(400).json({ error: 'Sequence is paused' });
  const ids = (Array.isArray(req.body.contactIds) ? req.body.contactIds : [req.body.contactId]).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: 'Pick at least one contact' });
  const senderId = intOrNull(req.body.userId) || req.session.user.id;
  let enrolled = 0; const skipped = [];
  for (const cid of ids) {
    const r = await engage.enroll({ sequence: seq, contactId: cid, dealId: intOrNull(req.body.dealId), userId: senderId, sendFirstNow: req.body.sendFirstNow !== false });
    if (r.enrollment) enrolled++; else skipped.push(r.skipped);
  }
  // Send any step-0 emails right away rather than waiting for the minute tick
  engage.runDueEnrollments().catch(e => console.error('Immediate sequence send failed:', e.message));
  res.json({ enrolled, skipped });
}));
app.post('/api/enrollments/:id/stop', requireAuth, wrap(async (req, res) => {
  const e = await engage.stopEnrollment(req.params.id, 'stopped', `by ${req.session.user.name}`);
  if (!e) return res.status(404).json({ error: 'Enrollment not active' });
  res.json(enrollmentOut(e));
}));

/* ---------- DocuSign ---------- */
app.get('/api/docusign/status', requireAuth, wrap(async (req, res) => {
  res.json(await docusign.status());
}));
app.get('/api/docusign/templates', requireAuth, wrap(async (req, res) => {
  res.json(await docusign.listTemplates());
}));
app.get('/api/docusign/templates/:id/roles', requireAuth, wrap(async (req, res) => {
  res.json(await docusign.templateRoles(req.params.id));
}));
app.post('/api/deals/:id/envelopes', requireAuth, wrap(async (req, res) => {
  const d = await dealById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Deal not found' });
  if (!SIGN_STAGES.includes(d.stage)) return res.status(400).json({ error: `Signatures can be sent at ${SIGN_STAGES.join(' or ')}` });
  const templateId = str(req.body.templateId), roleName = str(req.body.roleName), signerName = str(req.body.signerName), signerEmail = str(req.body.signerEmail).toLowerCase();
  if (!templateId || !roleName || !signerName || !signerEmail) return res.status(400).json({ error: 'Template, role, signer name and signer email are required' });
  const extraRoles = Array.isArray(req.body.extraRoles) ? req.body.extraRoles.filter(r => str(r.roleName) && str(r.name) && str(r.email)) : [];
  const env = await docusign.sendFromTemplate({
    templateId, emailSubject: str(req.body.subject) || `27 Squared Marketing — ${d.name}`,
    roles: [{ roleName, name: signerName, email: signerEmail }, ...extraRoles.map(r => ({ roleName: str(r.roleName), name: str(r.name), email: str(r.email).toLowerCase() }))],
  });
  const { rows } = await q(
    `INSERT INTO envelopes (deal_id, envelope_id, template_id, template_name, signer_name, signer_email, status, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [d.id, env.envelopeId, templateId, str(req.body.templateName), signerName, signerEmail, env.status || 'sent', req.session.user.id]);
  await logActivity({ dealId: d.id, contactId: d.contact_id, userId: req.session.user.id, type: 'Proposal', text: `Sent "${str(req.body.templateName) || 'document'}" for signature to ${signerName} <${signerEmail}>` });
  res.json(envelopeOut(rows[0]));
}));
app.post('/api/envelopes/:id/refresh', requireAuth, wrap(async (req, res) => {
  const e = (await q('SELECT * FROM envelopes WHERE id=$1', [req.params.id])).rows[0];
  if (!e) return res.status(404).json({ error: 'Envelope not found' });
  const s = await docusign.envelopeStatus(e.envelope_id);
  const updated = await applyEnvelopeStatus(e.envelope_id, s.status, s.completedDateTime);
  res.json(envelopeOut(updated || e));
}));
app.post('/api/envelopes/:id/void', requireAuth, wrap(async (req, res) => {
  const e = (await q('SELECT * FROM envelopes WHERE id=$1', [req.params.id])).rows[0];
  if (!e) return res.status(404).json({ error: 'Envelope not found' });
  await docusign.voidEnvelope(e.envelope_id, str(req.body.reason) || 'Voided from CRM');
  const updated = await applyEnvelopeStatus(e.envelope_id, 'voided', null);
  res.json(envelopeOut(updated || e));
}));

async function applyEnvelopeStatus(envelopeId, status, completedAt) {
  status = String(status || '').toLowerCase();
  if (!status) return null;
  const cur = (await q('SELECT * FROM envelopes WHERE envelope_id=$1', [envelopeId])).rows[0];
  if (!cur) return null;
  if (cur.status === status) return cur;
  const { rows } = await q('UPDATE envelopes SET status=$1, completed_at=$2, updated_at=now() WHERE envelope_id=$3 RETURNING *',
    [status, status === 'completed' ? (completedAt ? new Date(completedAt) : new Date()) : cur.completed_at, envelopeId]);
  const e = rows[0];
  const d = await dealById(e.deal_id);
  const label = { completed: 'signed by all parties', declined: 'declined', voided: 'voided', delivered: 'opened by the signer' }[status] || status;
  await logActivity({ dealId: e.deal_id, contactId: d?.contact_id, type: 'Proposal', text: `DocuSign "${e.template_name || 'document'}" ${label}` });
  if (['completed', 'declined', 'voided'].includes(status) && d) {
    await notifyUser(d.owner_id, `${d.name}: document ${label}`, `<p>The DocuSign envelope <b>${esc(e.template_name || 'document')}</b> for <b>${esc(d.name)}</b> was <b>${label}</b> (${esc(e.signer_name)}).</p><p><a href="${dealLink(d.id)}">Open deal</a></p>`, null);
    if (status === 'completed' && e.sent_by && String(e.sent_by) !== String(d.owner_id)) {
      await notifyUser(e.sent_by, `${d.name}: document signed`, `<p>The DocuSign envelope <b>${esc(e.template_name || 'document')}</b> for <b>${esc(d.name)}</b> was signed by ${esc(e.signer_name)}.</p><p><a href="${dealLink(d.id)}">Open deal</a></p>`, null);
    }
  }
  return e;
}

async function handleWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (!docusign.verifyWebhook(req.headers, raw)) return res.status(401).send('bad signature');
  let payload; try { payload = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('bad json'); }
  const data = payload.data || payload;
  const envelopeId = data.envelopeId || data.envelopeSummary?.envelopeId;
  const status = data.envelopeSummary?.status || payload.event?.replace('envelope-', '') || data.status;
  const completedAt = data.envelopeSummary?.completedDateTime;
  if (envelopeId && status) await applyEnvelopeStatus(envelopeId, status, completedAt);
  res.json({ ok: true });
}

/* ---------- users (admin) ---------- */
app.post('/api/users', requireAdmin, wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase(), name = str(req.body.name), password = String(req.body.password || ''), role = req.body.role === 'admin' ? 'admin' : 'member';
  if (!email || !name || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required' });
  if ((await q('SELECT 1 FROM users WHERE email=$1', [email])).rows[0]) return res.status(409).json({ error: 'A user with that email already exists' });
  const { rows } = await q('INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING *', [email, name, await bcrypt.hash(password, 11), role]);
  mailer.send({ to: email, subject: 'Your 27 Squared CRM login', html: `<p>${esc(req.session.user.name)} created a CRM account for you.</p><p>Sign in at <a href="${APP_URL}">${APP_URL}</a> with this email. They'll share your temporary password separately; change it from the sidebar after signing in.</p>` }).catch(() => {});
  res.json(publicUser(rows[0]));
}));
app.put('/api/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const name = str(req.body.name), role = req.body.role === 'admin' ? 'admin' : 'member', active = req.body.active !== false;
  if (id === req.session.user.id && (role !== 'admin' || !active)) return res.status(400).json({ error: "You can't demote or deactivate yourself" });
  const sets = ['name=$1', 'role=$2', 'active=$3'], params = [name, role, active];
  if (req.body.password) { if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' }); sets.push(`password_hash=$${params.length + 1}`); params.push(await bcrypt.hash(String(req.body.password), 11)); }
  params.push(id);
  const { rows } = await q(`UPDATE users SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(publicUser(rows[0]));
}));

/* ---------- settings (admin) ---------- */
app.get('/api/settings', requireAdmin, wrap(async (req, res) => {
  res.json({ appUrl: APP_URL, email: mailer.describe(), inbound: { configured: engage.imapConfigured(), host: process.env.IMAP_HOST || 'imap.gmail.com', mailbox: process.env.IMAP_USER || process.env.SMTP_USER || null, lastUid: (await q("SELECT value FROM meta WHERE key='imap_last_uid'")).rows[0]?.value || null }, docusign: await docusign.status(), webhookUrl: `${APP_URL}/api/docusign/webhook` });
}));
app.post('/api/settings/test-email', requireAdmin, wrap(async (req, res) => {
  await mailer.send({ to: req.session.user.email, subject: '27 Squared CRM — test email', html: '<p>Email notifications are working.</p>' });
  res.json({ ok: true });
}));

/* ---------- backup ---------- */
app.get('/api/export', requireAuth, wrap(async (req, res) => {
  const [contacts, companies, deals, activities, tasks, envelopes, emails, sequences, enrollments, properties] = await Promise.all([q('SELECT * FROM contacts'), q('SELECT * FROM companies'), q('SELECT * FROM deals'), q('SELECT * FROM activities'), q('SELECT * FROM tasks'), q('SELECT * FROM envelopes'), q('SELECT * FROM emails'), q('SELECT * FROM sequences'), q('SELECT * FROM enrollments'), q('SELECT * FROM properties')]);
  res.setHeader('Content-Disposition', `attachment; filename="27sq-crm-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date(), contacts: contacts.rows, companies: companies.rows, deals: deals.rows, activities: activities.rows, tasks: tasks.rows, envelopes: envelopes.rows, emails: emails.rows, sequences: sequences.rows, enrollments: enrollments.rows, properties: properties.rows });
}));

/* ---------- daily task digest (8:00 America/New_York) ---------- */
async function dailyDigestTick() {
  if (!mailer.configured()) return;
  const now = new Date();
  const et = new Intl.DateTimeFormat('en-US', { timeZone: process.env.DIGEST_TZ || 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' }).formatToParts(now).reduce((a, p) => (a[p.type] = p.value, a), {});
  if (Number(et.hour) !== Number(process.env.DIGEST_HOUR || 8)) return;
  const today = `${et.year}-${et.month}-${et.day}`;
  const last = (await q("SELECT value FROM meta WHERE key='digest_sent'")).rows[0]?.value;
  if (last === today) return;
  await q("INSERT INTO meta (key,value) VALUES ('digest_sent',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [today]);
  const users = (await q('SELECT * FROM users WHERE active')).rows;
  for (const u of users) {
    const { rows } = await q(`SELECT t.*, d.name AS deal_name FROM tasks t LEFT JOIN deals d ON d.id=t.deal_id WHERE t.assignee_id=$1 AND t.done=FALSE AND t.due_at IS NOT NULL AND t.due_at <= $2 ORDER BY t.due_at`, [u.id, today]);
    if (!rows.length) continue;
    const overdue = rows.filter(t => String(t.due_at).slice(0, 10) < today), due = rows.filter(t => String(t.due_at).slice(0, 10) === today);
    const li = t => `<li><b>${esc(t.title)}</b>${t.deal_name ? ` — ${esc(t.deal_name)}` : ''} <span style="color:#636466">(${String(t.due_at).slice(0, 10)})</span></li>`;
    const html = `${overdue.length ? `<p><b>Overdue (${overdue.length})</b></p><ul>${overdue.map(li).join('')}</ul>` : ''}${due.length ? `<p><b>Due today (${due.length})</b></p><ul>${due.map(li).join('')}</ul>` : ''}<p><a href="${APP_URL}/#tasks">Open tasks</a></p>`;
    mailer.send({ to: u.email, subject: `Tasks for today: ${due.length} due${overdue.length ? `, ${overdue.length} overdue` : ''}`, html }).catch(e => console.error('Digest failed:', e.message));
  }
}

/* ---------- static + errors ---------- */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { if (!err.expose) console.error(err); res.status(err.status || 500).json({ error: err.expose ? err.message : (err.publicMessage || 'Something went wrong on the server') }); });

/* ---------- boot ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitForDb(maxMs = 5 * 60 * 1000) {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try { await q('SELECT 1'); return; }
    catch (e) {
      if (Date.now() - start > maxMs) throw e;
      console.log(`Database not ready (${e.code || e.message}); retrying in 5s (attempt ${attempt})`);
      await sleep(5000);
    }
  }
}

(async () => {
  await waitForDb();
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await loadProps();
  engage.init({ query: q, appUrl: APP_URL });
  app.listen(PORT, () => console.log(`27 Squared CRM listening on ${PORT} (${APP_URL}) — email: ${mailer.configured() ? 'on' : 'off'}, inbound: ${engage.imapConfigured() ? 'on' : 'off'}, docusign: ${docusign.configured() ? 'on' : 'off'}`));
  setInterval(() => dailyDigestTick().catch(e => console.error('Digest tick failed:', e.message)), 60 * 1000);
  setInterval(() => engage.runDueEnrollments().catch(e => console.error('Sequence tick failed:', e.message)), 60 * 1000);
  if (engage.imapConfigured()) { engage.pollInbox().catch(() => {}); setInterval(() => engage.pollInbox().catch(() => {}), Number(process.env.IMAP_POLL_SECONDS || 60) * 1000); }
})().catch(e => { console.error('Boot failed:', e); process.exit(1); });
