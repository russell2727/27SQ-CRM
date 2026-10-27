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
const catalog = require('./lib/catalog');
const quotePdf = require('./lib/quote-pdf');
const workflows = require('./lib/workflows');
const calendar = require('./lib/calendar');
const metrics = require('./lib/metrics');
const mcp = require('./lib/mcp');

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

/* ---------- pipelines (cached) ---------- */
let PIPES = [];
async function loadPipelines() { PIPES = (await q('SELECT * FROM pipelines ORDER BY sort, id')).rows; }
const defaultPipeline = () => PIPES.find(p => p.is_default) || PIPES[0];
const pipelineById = id => PIPES.find(p => String(p.id) === String(id)) || defaultPipeline();
const stageOf = (pipe, name) => (pipe?.stages || []).find(st => st.name === name) || null;
const isWon = (pipe, name) => !!stageOf(pipe, name)?.won;
const canSign = (pipe, name) => !!stageOf(pipe, name)?.sign;
const resolveStage = (pipe, name) => stageOf(pipe, name) ? name : (pipe.stages[0]?.name || 'New lead');
const STAGE_NAMES = pipe => (pipe?.stages || []).map(st => st.name);

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
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.created_at, bookingUrl: u.booking_url || '', calendarSync: u.calendar_sync !== false });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const contactOut = r => ({
  id: r.id, first: r.first_name, last: r.last_name, title: r.title, email: r.email, phone: r.phone, linkedin: r.linkedin || '',
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
  pipelineId: r.pipeline_id, valueAuto: r.value_auto, won: isWon(pipelineById(r.pipeline_id), r.stage), forecastCategory: r.forecast_category || null,
  probability: r.lost ? 0 : (stageOf(pipelineById(r.pipeline_id), r.stage)?.probability ?? 0),
});
const pipelineOut = r => ({ id: r.id, name: r.name, stages: r.stages || [], isDefault: r.is_default, sort: r.sort });
const productOut = r => ({ id: r.id, name: r.name, category: r.category, description: r.description, unit: r.unit, billing: r.billing, price: Number(r.price), tiers: r.tiers || [], active: r.active, sort: r.sort });
const itemOut = r => ({ id: r.id, dealId: r.deal_id, productId: r.product_id, name: r.name, description: r.description, unit: r.unit, billing: r.billing, qty: Number(r.qty), unitPrice: Number(r.unit_price), months: r.months, amount: Number(r.amount), sort: r.sort });
const quoteOut = r => ({ id: r.id, dealId: r.deal_id, number: r.number, title: r.title, intro: r.intro, terms: r.terms, items: r.items || [], oneTime: Number(r.one_time), monthly: Number(r.monthly), total: Number(r.total), validUntil: r.valid_until, status: r.status, sentTo: r.sent_to, sentAt: r.sent_at, createdBy: r.created_by, createdAt: r.created_at, hasPdf: !!r.has_pdf });
const formOut = r => ({ id: r.id, key: r.key, name: r.name, title: r.title, intro: r.intro, button: r.button, thanks: r.thanks, redirectUrl: r.redirect_url, fields: r.fields || [], createDeal: r.create_deal, pipelineId: r.pipeline_id, stage: r.stage, ownerId: r.owner_id, source: r.source, vertical: r.vertical, notify: r.notify, active: r.active, submissions: r.submissions, createdAt: r.created_at });
const workflowOut = r => ({ id: r.id, name: r.name, trigger: r.trigger, conditions: r.conditions || {}, actions: r.actions || [], active: r.active, runs: r.runs, lastRunAt: r.last_run_at, createdAt: r.created_at });
const meetingOut = r => ({ id: r.id, userId: r.user_id, contactId: r.contact_id, dealId: r.deal_id, title: r.title, startsAt: r.starts_at, endsAt: r.ends_at, link: r.link, status: r.status });
const dashboardOut = r => ({ id: r.id, name: r.name, widgets: r.widgets || [], range: r.range, emailWeekly: r.email_weekly, emailTo: r.email_to || [], sort: r.sort, createdBy: r.created_by });
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

app.put('/api/me', requireAuth, wrap(async (req, res) => {
  const url = str(req.body.bookingUrl); if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Booking link must start with http(s)://' });
  const { rows } = await q('UPDATE users SET booking_url=$2, calendar_sync=$3 WHERE id=$1 RETURNING *', [req.session.user.id, url, req.body.calendarSync !== false]);
  req.session.user = publicUser(rows[0]);
  res.json(req.session.user);
}));

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
  const [forms, wfs, meetings] = await Promise.all([q('SELECT * FROM forms ORDER BY name'), q('SELECT * FROM workflows ORDER BY name'), q("SELECT * FROM meetings WHERE status<>'cancelled' AND starts_at > now() - interval '1 day' ORDER BY starts_at")]);
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
    dashboards: (await q('SELECT * FROM dashboards ORDER BY sort, id')).rows.map(dashboardOut),
    widgetTypes: metrics.WIDGETS,
    forms: forms.rows.map(formOut),
    workflows: wfs.rows.map(workflowOut),
    meetings: meetings.rows.map(meetingOut),
    siteKey: SITE_KEY,
    pipelines: PIPES.map(pipelineOut),
    products: (await q('SELECT * FROM products ORDER BY sort, id')).rows.map(productOut),
    stages: STAGE_NAMES(defaultPipeline()),
    signStages: (defaultPipeline()?.stages || []).filter(st => st.sign).map(st => st.name),
    integrations: { docusign: docusign.configured(), email: mailer.configured(), inbound: engage.imapConfigured(), calendar: calendar.configured() },
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
const cleanLinkedin = v => { v = str(v); if (!v) return ''; if (!/^https?:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, ''); return /linkedin\.com\//i.test(v) ? v.slice(0, 300) : v.slice(0, 300); };
const contactFields = b => ({
  first: str(b.first), last: str(b.last), title: str(b.title), email: str(b.email).toLowerCase(), phone: str(b.phone), linkedin: cleanLinkedin(b.linkedin),
  companyId: intOrNull(b.companyId), vertical: str(b.vertical), source: str(b.source), notes: str(b.notes), ownerId: intOrNull(b.ownerId),
});

app.post('/api/contacts', requireAuth, wrap(async (req, res) => {
  const f = contactFields(req.body);
  if (!f.first && !f.last) return res.status(400).json({ error: 'Add at least a first or last name' });
  const { rows } = await q(
    `INSERT INTO contacts (first_name,last_name,title,email,phone,company_id,vertical,source,notes,owner_id,created_by,deal_migrated,custom,linkedin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12,$13) RETURNING *`,
    [f.first, f.last, f.title, f.email, f.phone, f.companyId, f.vertical, f.source, f.notes, f.ownerId || req.session.user.id, req.session.user.id, JSON.stringify(cleanCustom('contact', req.body.custom)), f.linkedin]);
  const contact = rows[0];
  let deal = null;
  if (req.body.createDeal) {
    deal = await createDeal({
      name: str(req.body.dealName) || (contact.company_id ? (await q('SELECT name FROM companies WHERE id=$1', [contact.company_id])).rows[0]?.name : '') || `${f.first} ${f.last}`.trim(),
      contactId: contact.id, companyId: contact.company_id, pipelineId: defaultPipeline().id, stage: resolveStage(defaultPipeline(), req.body.stage),
      value: num(req.body.value), vertical: f.vertical, source: f.source, ownerId: contact.owner_id, expectedClose: null, notes: '',
    }, req.session.user.id);
  }
  workflows.run('contact_created', { contact, deal }).catch(() => {});
  res.json({ contact: contactOut(contact), deal: deal && dealOut(deal) });
}));

app.put('/api/contacts/:id', requireAuth, wrap(async (req, res) => {
  const f = contactFields(req.body);
  if (!f.first && !f.last) return res.status(400).json({ error: 'Add at least a first or last name' });
  const { rows } = await q(
    `UPDATE contacts SET first_name=$1,last_name=$2,title=$3,email=$4,phone=$5,company_id=$6,vertical=$7,source=$8,notes=$9,owner_id=$10,custom=$12,linkedin=$13,updated_at=now() WHERE id=$11 RETURNING *`,
    [f.first, f.last, f.title, f.email, f.phone, f.companyId, f.vertical, f.source, f.notes, f.ownerId, req.params.id, JSON.stringify(cleanCustom('contact', req.body.custom)), f.linkedin]);
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
  pipelineId: pipelineById(b.pipelineId).id, stage: resolveStage(pipelineById(b.pipelineId), b.stage), value: num(b.value), vertical: str(b.vertical), source: str(b.source),
  expectedClose: dateOrNull(b.expectedClose), notes: str(b.notes), ownerId: intOrNull(b.ownerId), custom: cleanCustom('deal', b.custom),
  forecastCategory: ['pipeline', 'best', 'commit', 'omit'].includes(b.forecastCategory) ? b.forecastCategory : null,
});

async function createDeal(f, actorId) {
  const history = JSON.stringify([{ stage: f.stage, at: new Date().toISOString(), by: actorId }]);
  const pipe = pipelineById(f.pipelineId);
  const wonAt = isWon(pipe, f.stage) ? new Date() : null;
  const { rows } = await q(
    `INSERT INTO deals (name,contact_id,company_id,stage,value,vertical,source,expected_close,notes,owner_id,created_by,stage_history,won_at,custom,pipeline_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [f.name, f.contactId, f.companyId, f.stage, f.value, f.vertical, f.source, f.expectedClose, f.notes, f.ownerId || actorId, actorId, history, wonAt, JSON.stringify(f.custom || {}), pipe.id]);
  const d = rows[0];
  workflows.run('deal_created', { deal: d }).catch(() => {});
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
  const pipe = pipelineById(f.pipelineId);
  if (cur.stage !== f.stage || String(cur.pipeline_id) !== String(pipe.id)) {
    history = [...history, { stage: f.stage, pipelineId: pipe.id, at: new Date().toISOString(), by: me.id }];
    if (isWon(pipe, f.stage)) wonAt = new Date();
    await logActivity({ dealId: cur.id, contactId: cur.contact_id, userId: me.id, text: `Moved to ${f.stage}${String(cur.pipeline_id) !== String(pipe.id) ? ` (${pipe.name} pipeline)` : ''}` });
    if (isWon(pipe, f.stage) && cur.contact_id) await engage.stopAllForContact(cur.contact_id, 'stopped', 'deal closed won');
    await notifyUser(cur.owner_id, `${cur.name}: moved to ${f.stage}`, `<p>${esc(me.name)} moved <b>${esc(cur.name)}</b> to <b>${esc(f.stage)}</b>.</p><p><a href="${dealLink(cur.id)}">Open deal</a></p>`, me.id);
  }
  const value = cur.value_auto ? cur.value : f.value; // line items own the value when present
  const { rows } = await q(
    `UPDATE deals SET name=$1,contact_id=$2,company_id=$3,stage=$4,value=$5,vertical=$6,source=$7,expected_close=$8,notes=$9,owner_id=$10,stage_history=$11,won_at=$12,custom=$14,pipeline_id=$15,forecast_category=$16,updated_at=now()
     WHERE id=$13 RETURNING *`,
    [f.name, f.contactId, f.companyId, f.stage, value, f.vertical, f.source, f.expectedClose, f.notes, f.ownerId, JSON.stringify(history), wonAt, req.params.id, JSON.stringify(f.custom), pipe.id, f.forecastCategory]);
  if (cur.stage !== f.stage) { workflows.run('deal_stage', { deal: rows[0], fromStage: cur.stage }).catch(() => {}); if (isWon(pipe, f.stage)) workflows.run('deal_won', { deal: rows[0] }).catch(() => {}); }
  if (f.ownerId && String(f.ownerId) !== String(cur.owner_id)) {
    await notifyUser(f.ownerId, `Deal assigned to you: ${f.name}`, `<p>${esc(me.name)} assigned you the deal <b>${esc(f.name)}</b> (${esc(f.stage)}).</p><p><a href="${dealLink(cur.id)}">Open deal</a></p>`, me.id);
  }
  res.json(dealOut(rows[0]));
}));

async function moveStage(cur, stage, me) {
  const pipe = pipelineById(cur.pipeline_id);
  if (!stageOf(pipe, stage)) return { error: 'Unknown stage for this pipeline' };
  if (cur.stage === stage && !cur.lost) return { deal: cur };
  const history = [...(cur.stage_history || []), { stage, at: new Date().toISOString(), by: me.id }];
  const wonAt = isWon(pipe, stage) ? new Date() : cur.won_at;
  const { rows } = await q('UPDATE deals SET stage=$1, lost=FALSE, lost_at=NULL, stage_history=$2, won_at=$3, updated_at=now() WHERE id=$4 RETURNING *', [stage, JSON.stringify(history), wonAt, cur.id]);
  await logActivity({ dealId: cur.id, contactId: cur.contact_id, userId: me.id, text: `Moved to ${stage}` });
  if (isWon(pipe, stage) && cur.contact_id) await engage.stopAllForContact(cur.contact_id, 'stopped', 'deal closed won');
  await notifyUser(cur.owner_id, `${cur.name}: moved to ${stage}`, `<p>${esc(me.name)} moved <b>${esc(cur.name)}</b> to <b>${esc(stage)}</b>.</p><p><a href="${dealLink(cur.id)}">Open deal</a></p>`, me.id);
  workflows.run('deal_stage', { deal: rows[0], fromStage: cur.stage }).catch(() => {});
  if (isWon(pipe, stage)) workflows.run('deal_won', { deal: rows[0] }).catch(() => {});
  return { deal: rows[0] };
}
async function setLost(cur, lost, me) {
  const { rows } = await q('UPDATE deals SET lost=$1, lost_at=$2, updated_at=now() WHERE id=$3 RETURNING *', [lost, lost ? new Date() : null, cur.id]);
  await logActivity({ dealId: rows[0].id, contactId: rows[0].contact_id, userId: me.id, text: lost ? 'Marked lost' : 'Reopened' });
  if (lost && rows[0].contact_id) await engage.stopAllForContact(rows[0].contact_id, 'stopped', 'deal marked lost');
  if (lost) workflows.run('deal_lost', { deal: rows[0] }).catch(() => {});
  return rows[0];
}

app.patch('/api/deals/:id/stage', requireAuth, wrap(async (req, res) => {
  const cur = await dealById(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Deal not found' });
  const r = await moveStage(cur, req.body.stage, req.session.user);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(dealOut(r.deal));
}));

app.patch('/api/deals/:id/lost', requireAuth, wrap(async (req, res) => {
  const cur = await dealById(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Deal not found' });
  res.json(dealOut(await setLost(cur, !!req.body.lost, req.session.user)));
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
  const createDeals = !!req.body.createDeals, stage = resolveStage(defaultPipeline(), req.body.stage), pipeId = defaultPipeline().id;
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
    if (str(r.linkedin)) await q('UPDATE contacts SET linkedin=$2 WHERE id=$1', [ins.rows[0].id, cleanLinkedin(r.linkedin)]);
    const cust = cleanCustom('contact', r.custom); if (Object.keys(cust).length) await q('UPDATE contacts SET custom=$2 WHERE id=$1', [ins.rows[0].id, JSON.stringify(cust)]);
    if (email) existingEmails.add(email);
    created++;
    if (createDeals) {
      await q(`INSERT INTO deals (name,contact_id,company_id,stage,value,vertical,source,owner_id,created_by,stage_history,pipeline_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [coName || `${first} ${last}`.trim(), ins.rows[0].id, companyId, stage, num(r.value), str(r.vertical), str(r.source) || 'Import', ownerId, req.session.user.id,
          JSON.stringify([{ stage, at: new Date().toISOString(), by: req.session.user.id }]), pipeId]);
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

/* ---------- pipelines (admin) ---------- */
const cleanStages = stages => (Array.isArray(stages) ? stages : []).map(st => ({
  name: str(st.name).slice(0, 40), probability: Math.max(0, Math.min(100, Math.round(Number(st.probability) || 0))), won: !!st.won, sign: !!st.sign,
})).filter(st => st.name).filter((st, i, arr) => arr.findIndex(x => x.name === st.name) === i).slice(0, 10);

app.post('/api/pipelines', requireAdmin, wrap(async (req, res) => {
  const name = str(req.body.name), stages = cleanStages(req.body.stages);
  if (!name || stages.length < 2) return res.status(400).json({ error: 'A pipeline needs a name and at least two stages' });
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM pipelines')).rows[0].s;
  const { rows } = await q('INSERT INTO pipelines (name, stages, sort) VALUES ($1,$2,$3) RETURNING *', [name, JSON.stringify(stages), sort]);
  await loadPipelines(); res.json(pipelineOut(rows[0]));
}));
app.put('/api/pipelines/:id', requireAdmin, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM pipelines WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Pipeline not found' });
  const name = str(req.body.name) || cur.name;
  const stages = req.body.stages != null ? cleanStages(req.body.stages) : cur.stages;
  if (stages.length < 2) return res.status(400).json({ error: 'At least two stages are required' });
  // Renames: req.body.renames = {oldName: newName} moves deals along
  const renames = req.body.renames && typeof req.body.renames === 'object' ? req.body.renames : {};
  for (const [from, to] of Object.entries(renames)) if (str(from) && str(to) && from !== to) await q('UPDATE deals SET stage=$3 WHERE pipeline_id=$1 AND stage=$2', [cur.id, from, to]);
  // Deals sitting on a removed stage fall back to the first stage
  const names = stages.map(st => st.name);
  await q('UPDATE deals SET stage=$2 WHERE pipeline_id=$1 AND NOT (stage = ANY($3))', [cur.id, names[0], names]);
  if (req.body.isDefault) { await q('UPDATE pipelines SET is_default=FALSE'); }
  const { rows } = await q('UPDATE pipelines SET name=$2, stages=$3, is_default=CASE WHEN $4 THEN TRUE ELSE is_default END WHERE id=$1 RETURNING *', [cur.id, name, JSON.stringify(stages), !!req.body.isDefault]);
  await loadPipelines(); res.json(pipelineOut(rows[0]));
}));
app.delete('/api/pipelines/:id', requireAdmin, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM pipelines WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Pipeline not found' });
  if (cur.is_default || PIPES.length < 2) return res.status(400).json({ error: "Can't delete the default or only pipeline" });
  const def = defaultPipeline();
  await q('UPDATE deals SET pipeline_id=$2, stage=$3 WHERE pipeline_id=$1', [cur.id, def.id, def.stages[0].name]);
  await q('DELETE FROM pipelines WHERE id=$1', [cur.id]);
  await loadPipelines(); res.json({ ok: true });
}));

/* ---------- products (admin) ---------- */
const UNITS = ['each', 'record', 'message', 'email', 'piece', 'month', '1,000', 'hour'];
const productFields = b => ({
  name: str(b.name).slice(0, 120), category: str(b.category).slice(0, 60), description: str(b.description).slice(0, 500),
  unit: UNITS.includes(b.unit) ? b.unit : 'each', billing: b.billing === 'monthly' ? 'monthly' : 'one-time', price: num(b.price),
  tiers: (Array.isArray(b.tiers) ? b.tiers : []).map(t => ({ min: num(t.min), price: num(t.price) })).filter(t => Number.isFinite(t.min)).sort((a, b2) => a.min - b2.min).slice(0, 12),
  active: b.active !== false,
});
app.post('/api/products', requireAdmin, wrap(async (req, res) => {
  const f = productFields(req.body); if (!f.name) return res.status(400).json({ error: 'Product name is required' });
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM products')).rows[0].s;
  const { rows } = await q('INSERT INTO products (name,category,description,unit,billing,price,tiers,active,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [f.name, f.category, f.description, f.unit, f.billing, f.price, JSON.stringify(f.tiers), f.active, sort]);
  res.json(productOut(rows[0]));
}));
app.put('/api/products/:id', requireAdmin, wrap(async (req, res) => {
  const f = productFields(req.body); if (!f.name) return res.status(400).json({ error: 'Product name is required' });
  const { rows } = await q('UPDATE products SET name=$2,category=$3,description=$4,unit=$5,billing=$6,price=$7,tiers=$8,active=$9,updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, f.name, f.category, f.description, f.unit, f.billing, f.price, JSON.stringify(f.tiers), f.active]);
  if (!rows[0]) return res.status(404).json({ error: 'Product not found' });
  res.json(productOut(rows[0]));
}));
app.delete('/api/products/:id', requireAdmin, wrap(async (req, res) => {
  await q('DELETE FROM products WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));

/* ---------- deal line items ---------- */
const lineAmount = it => Math.round(Number(it.qty) * Number(it.unit_price ?? it.unitPrice) * (it.billing === 'monthly' ? Math.max(1, Number(it.months) || 1) : 1) * 100) / 100;
async function recalcDeal(dealId) {
  const { rows } = await q('SELECT * FROM deal_items WHERE deal_id=$1', [dealId]);
  if (!rows.length) { await q('UPDATE deals SET value_auto=FALSE, updated_at=now() WHERE id=$1', [dealId]); return null; }
  const total = rows.reduce((a, r) => a + Number(r.amount), 0);
  await q('UPDATE deals SET value=$2, value_auto=TRUE, updated_at=now() WHERE id=$1', [dealId, total]);
  return total;
}
app.get('/api/deals/:id/items', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM deal_items WHERE deal_id=$1 ORDER BY sort, id', [req.params.id]);
  res.json(rows.map(itemOut));
}));
app.post('/api/deals/:id/items', requireAuth, wrap(async (req, res) => {
  const d = await dealById(req.params.id); if (!d) return res.status(404).json({ error: 'Deal not found' });
  const product = req.body.productId ? (await q('SELECT * FROM products WHERE id=$1', [req.body.productId])).rows[0] : null;
  const qty = Math.max(0, Number(req.body.qty) || 1);
  const unitPrice = req.body.unitPrice != null && req.body.unitPrice !== '' ? num(req.body.unitPrice) : (product ? catalog.priceFor(product, qty) : 0);
  const it = {
    name: str(req.body.name) || product?.name || 'Line item', description: req.body.description != null ? str(req.body.description) : (product?.description || ''),
    unit: str(req.body.unit) || product?.unit || 'each', billing: (req.body.billing || product?.billing) === 'monthly' ? 'monthly' : 'one-time',
    qty, unit_price: unitPrice, months: Math.max(1, Math.min(60, Math.round(Number(req.body.months) || 1))),
  };
  it.amount = lineAmount(it);
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM deal_items WHERE deal_id=$1', [d.id])).rows[0].s;
  const { rows } = await q('INSERT INTO deal_items (deal_id,product_id,name,description,unit,billing,qty,unit_price,months,amount,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
    [d.id, product?.id || null, it.name, it.description, it.unit, it.billing, it.qty, it.unit_price, it.months, it.amount, sort]);
  const total = await recalcDeal(d.id);
  res.json({ item: itemOut(rows[0]), dealValue: total });
}));
app.put('/api/items/:id', requireAuth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM deal_items WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Line item not found' });
  const product = cur.product_id ? (await q('SELECT * FROM products WHERE id=$1', [cur.product_id])).rows[0] : null;
  const qty = req.body.qty != null ? Math.max(0, Number(req.body.qty) || 0) : Number(cur.qty);
  let unitPrice = req.body.unitPrice != null && req.body.unitPrice !== '' ? num(req.body.unitPrice) : Number(cur.unit_price);
  if (req.body.repriceFromTiers && product) unitPrice = catalog.priceFor(product, qty);
  const it = {
    name: req.body.name != null ? str(req.body.name) || cur.name : cur.name, description: req.body.description != null ? str(req.body.description) : cur.description,
    unit: req.body.unit != null ? str(req.body.unit) || cur.unit : cur.unit, billing: req.body.billing != null ? (req.body.billing === 'monthly' ? 'monthly' : 'one-time') : cur.billing,
    qty, unit_price: unitPrice, months: req.body.months != null ? Math.max(1, Math.min(60, Math.round(Number(req.body.months) || 1))) : cur.months,
  };
  it.amount = lineAmount(it);
  const { rows } = await q('UPDATE deal_items SET name=$2,description=$3,unit=$4,billing=$5,qty=$6,unit_price=$7,months=$8,amount=$9 WHERE id=$1 RETURNING *',
    [cur.id, it.name, it.description, it.unit, it.billing, it.qty, it.unit_price, it.months, it.amount]);
  const total = await recalcDeal(cur.deal_id);
  res.json({ item: itemOut(rows[0]), dealValue: total });
}));
app.delete('/api/items/:id', requireAuth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM deal_items WHERE id=$1', [req.params.id])).rows[0];
  if (cur) { await q('DELETE FROM deal_items WHERE id=$1', [cur.id]); await recalcDeal(cur.deal_id); }
  res.json({ ok: true, dealValue: cur ? (await dealById(cur.deal_id))?.value : null });
}));
app.post('/api/deals/:id/value', requireAuth, wrap(async (req, res) => {
  // Detach from line items and set a manual value
  const { rows } = await q('UPDATE deals SET value=$2, value_auto=FALSE, updated_at=now() WHERE id=$1 RETURNING *', [req.params.id, num(req.body.value)]);
  if (!rows[0]) return res.status(404).json({ error: 'Deal not found' });
  res.json(dealOut(rows[0]));
}));

/* ---------- quotes ---------- */
const DEFAULT_TERMS = `All deployments are prepaid. Invoicing is weekly for usage-based services unless otherwise agreed. Data hygiene and additional data appends are billed separately. Media is billed at cost; a 3.5% processing fee applies to credit card payments (none for ACH). Postage is estimated and billed at actual. Pricing follows the published 27 Squared Marketing rate grids and is valid through the date shown above.`;
async function quoteContext(d) {
  const contact = d.contact_id ? (await q('SELECT * FROM contacts WHERE id=$1', [d.contact_id])).rows[0] : null;
  const company = d.company_id ? (await q('SELECT * FROM companies WHERE id=$1', [d.company_id])).rows[0] : null;
  return { contact, company };
}
app.get('/api/deals/:id/quotes', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT id, deal_id, number, title, intro, terms, items, one_time, monthly, total, valid_until, status, sent_to, sent_at, created_by, created_at, (pdf IS NOT NULL) AS has_pdf FROM quotes WHERE deal_id=$1 ORDER BY created_at DESC', [req.params.id]);
  res.json(rows.map(quoteOut));
}));
app.post('/api/deals/:id/quotes', requireAuth, wrap(async (req, res) => {
  const d = await dealById(req.params.id); if (!d) return res.status(404).json({ error: 'Deal not found' });
  const items = (await q('SELECT * FROM deal_items WHERE deal_id=$1 ORDER BY sort, id', [d.id])).rows;
  if (!items.length) return res.status(400).json({ error: 'Add line items to the deal before generating a quote' });
  const { contact, company } = await quoteContext(d);
  const user = (await q('SELECT * FROM users WHERE id=$1', [req.session.user.id])).rows[0];
  const year = new Date().getFullYear();
  const n = (await q("SELECT COUNT(*)::int AS n FROM quotes WHERE number LIKE $1", [`Q-${year}-%`])).rows[0].n + 1;
  const number = `Q-${year}-${String(n).padStart(4, '0')}`;
  const snapshot = items.map(itemOut).map(i => ({ name: i.name, description: i.description, unit: i.unit, billing: i.billing, qty: i.qty, unit_price: i.unitPrice, months: i.months, amount: i.amount }));
  const oneTime = snapshot.filter(i => i.billing !== 'monthly').reduce((a, i) => a + i.amount, 0);
  const monthly = snapshot.filter(i => i.billing === 'monthly').reduce((a, i) => a + i.amount, 0);
  const validUntil = dateOrNull(req.body.validUntil) || new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const quote = {
    number, title: str(req.body.title) || `${company?.name || contact?.first_name || 'Client'} — ${d.name}`, intro: str(req.body.intro), terms: req.body.terms != null ? str(req.body.terms) : DEFAULT_TERMS,
    items: snapshot, one_time: oneTime, monthly, total: oneTime + monthly, valid_until: validUntil, created_at: new Date(),
  };
  const pdf = await quotePdf.build(quote, {
    contactName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '', contactTitle: contact?.title || '', companyName: company?.name || '',
    userName: user.name, userEmail: user.email,
  });
  const { rows } = await q(
    `INSERT INTO quotes (deal_id, number, title, intro, terms, items, one_time, monthly, total, valid_until, pdf, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, deal_id, number, title, intro, terms, items, one_time, monthly, total, valid_until, status, sent_to, sent_at, created_by, created_at, TRUE AS has_pdf`,
    [d.id, number, quote.title, quote.intro, quote.terms, JSON.stringify(snapshot), oneTime, monthly, oneTime + monthly, validUntil, pdf, user.id]);
  await logActivity({ dealId: d.id, contactId: d.contact_id, userId: user.id, type: 'Proposal', text: `Generated quote ${number} — ${quote.title} (${'$' + (oneTime + monthly).toLocaleString('en-US', { maximumFractionDigits: 0 })})` });
  res.json(quoteOut(rows[0]));
}));
app.get('/api/quotes/:id.pdf', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT number, title, pdf FROM quotes WHERE id=$1', [req.params.id]);
  const qt = rows[0]; if (!qt || !qt.pdf) return res.status(404).json({ error: 'Quote not found' });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="27SQ ${qt.number}.pdf"` });
  res.send(qt.pdf);
}));
app.post('/api/quotes/:id/send', requireAuth, wrap(async (req, res) => {
  if (!mailer.configured()) return res.status(400).json({ error: 'Email is not configured (Settings)' });
  const qt = (await q('SELECT * FROM quotes WHERE id=$1', [req.params.id])).rows[0];
  if (!qt) return res.status(404).json({ error: 'Quote not found' });
  const d = await dealById(qt.deal_id);
  const { contact } = await quoteContext(d);
  const to = str(req.body.to) || contact?.email;
  if (!to) return res.status(400).json({ error: 'Recipient email is required' });
  const user = (await q('SELECT * FROM users WHERE id=$1', [req.session.user.id])).rows[0];
  const fromAddr = (process.env.MAIL_FROM || '').match(/<([^>]+)>/)?.[1] || process.env.MAIL_FROM || process.env.SMTP_USER || '';
  const body = str(req.body.body) || `Hi ${contact?.first_name || 'there'},\n\nAttached is our proposal for ${d.name}. The investment summary is on page 1; terms follow.\n\nHappy to walk through it whenever suits you.`;
  await mailer.sendRaw({
    from: `${user.name} via 27 Squared <${fromAddr}>`, to, replyTo: [user.email, fromAddr],
    subject: str(req.body.subject) || `Proposal ${qt.number}: ${qt.title}`,
    text: body + `\n\n${user.name}\n27 Squared Marketing`,
    html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#000">${body.split(/\n\n/).map(pp => `<p>${esc(pp).replace(/\n/g, '<br>')}</p>`).join('')}<p style="margin-top:18px">${esc(user.name)}<br><span style="color:#636466">27 Squared Marketing</span></p></div>`,
    attachments: [{ filename: `27SQ ${qt.number}.pdf`, content: qt.pdf, contentType: 'application/pdf' }],
  });
  const { rows } = await q(`UPDATE quotes SET status='sent', sent_to=$2, sent_at=now() WHERE id=$1 RETURNING id, deal_id, number, title, intro, terms, items, one_time, monthly, total, valid_until, status, sent_to, sent_at, created_by, created_at, TRUE AS has_pdf`, [qt.id, to]);
  await q("INSERT INTO emails (direction, contact_id, deal_id, user_id, from_email, to_email, subject, body) VALUES ('out',$1,$2,$3,$4,$5,$6,$7)", [contact?.id || null, d.id, user.id, fromAddr, to, str(req.body.subject) || `Proposal ${qt.number}: ${qt.title}`, body]);
  await logActivity({ dealId: d.id, contactId: d.contact_id, userId: user.id, type: 'Proposal', text: `Sent quote ${qt.number} to ${to}` });
  res.json(quoteOut(rows[0]));
}));
app.patch('/api/quotes/:id/status', requireAuth, wrap(async (req, res) => {
  const status = ['draft', 'sent', 'accepted', 'declined'].includes(req.body.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'Unknown status' });
  const { rows } = await q('UPDATE quotes SET status=$2 WHERE id=$1 RETURNING id, deal_id, number, title, intro, terms, items, one_time, monthly, total, valid_until, status, sent_to, sent_at, created_by, created_at, (pdf IS NOT NULL) AS has_pdf', [req.params.id, status]);
  if (!rows[0]) return res.status(404).json({ error: 'Quote not found' });
  await logActivity({ dealId: rows[0].deal_id, userId: req.session.user.id, type: 'Proposal', text: `Quote ${rows[0].number} marked ${status}` });
  res.json(quoteOut(rows[0]));
}));

/* ---------- forms ---------- */
const FIELD_TYPES = ['text', 'email', 'tel', 'textarea', 'select', 'checkbox', 'number', 'date'];
const STD_FIELDS = { first: 'First name', last: 'Last name', email: 'Email', phone: 'Phone', company: 'Company', title: 'Title', linkedin: 'LinkedIn profile', message: 'Message' };
const cleanFields = fields => (Array.isArray(fields) ? fields : []).map(f => ({
  key: str(f.key).toLowerCase().replace(/[^a-z0-9_.]+/g, '_').slice(0, 40), label: str(f.label).slice(0, 80) || STD_FIELDS[f.key] || str(f.key),
  type: FIELD_TYPES.includes(f.type) ? f.type : (f.key === 'email' ? 'email' : f.key === 'phone' ? 'tel' : f.key === 'message' ? 'textarea' : 'text'),
  required: !!f.required, options: (Array.isArray(f.options) ? f.options : String(f.options || '').split(/\n|,/)).map(str).filter(Boolean).slice(0, 30),
})).filter(f => f.key).filter((f, i, a) => a.findIndex(x => x.key === f.key) === i).slice(0, 25);
const formFields = b => ({
  name: str(b.name).slice(0, 80), title: str(b.title).slice(0, 120), intro: str(b.intro).slice(0, 1000), button: str(b.button).slice(0, 40) || 'Submit',
  thanks: str(b.thanks).slice(0, 500) || "Thanks — we'll be in touch shortly.", redirectUrl: /^https?:\/\//i.test(str(b.redirectUrl)) ? str(b.redirectUrl) : '',
  fields: cleanFields(b.fields), createDeal: b.createDeal !== false, pipelineId: intOrNull(b.pipelineId), stage: str(b.stage), ownerId: intOrNull(b.ownerId),
  source: str(b.source) || 'Website', vertical: str(b.vertical), notify: b.notify !== false, active: b.active !== false,
});
app.post('/api/forms', requireAuth, wrap(async (req, res) => {
  const f = formFields(req.body); if (!f.name) return res.status(400).json({ error: 'Form name is required' });
  if (!f.fields.some(x => x.key === 'email')) return res.status(400).json({ error: 'The form needs an email field' });
  const key = crypto.randomBytes(8).toString('hex');
  const { rows } = await q(`INSERT INTO forms (key,name,title,intro,button,thanks,redirect_url,fields,create_deal,pipeline_id,stage,owner_id,source,vertical,notify,active,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [key, f.name, f.title, f.intro, f.button, f.thanks, f.redirectUrl, JSON.stringify(f.fields), f.createDeal, f.pipelineId, f.stage, f.ownerId, f.source, f.vertical, f.notify, f.active, req.session.user.id]);
  res.json(formOut(rows[0]));
}));
app.put('/api/forms/:id', requireAuth, wrap(async (req, res) => {
  const f = formFields(req.body); if (!f.name) return res.status(400).json({ error: 'Form name is required' });
  if (!f.fields.some(x => x.key === 'email')) return res.status(400).json({ error: 'The form needs an email field' });
  const { rows } = await q(`UPDATE forms SET name=$2,title=$3,intro=$4,button=$5,thanks=$6,redirect_url=$7,fields=$8,create_deal=$9,pipeline_id=$10,stage=$11,owner_id=$12,source=$13,vertical=$14,notify=$15,active=$16 WHERE id=$1 RETURNING *`,
    [req.params.id, f.name, f.title, f.intro, f.button, f.thanks, f.redirectUrl, JSON.stringify(f.fields), f.createDeal, f.pipelineId, f.stage, f.ownerId, f.source, f.vertical, f.notify, f.active]);
  if (!rows[0]) return res.status(404).json({ error: 'Form not found' });
  res.json(formOut(rows[0]));
}));
app.delete('/api/forms/:id', requireAuth, wrap(async (req, res) => { await q('DELETE FROM forms WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));
app.get('/api/forms/:id/submissions', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM form_submissions WHERE form_id=$1 ORDER BY created_at DESC LIMIT 200', [req.params.id]);
  res.json(rows.map(r => ({ id: r.id, contactId: r.contact_id, dealId: r.deal_id, data: r.data, pageUrl: r.page_url, at: r.created_at })));
}));

/* ---------- public: form page, embed, submit, tracking, identify ---------- */
let SITE_KEY = null;
async function ensureSiteKey() {
  const row = (await q("SELECT value FROM meta WHERE key='site_key'")).rows[0];
  if (row) { SITE_KEY = row.value; return; }
  SITE_KEY = crypto.randomBytes(8).toString('hex');
  await q("INSERT INTO meta (key,value) VALUES ('site_key',$1) ON CONFLICT (key) DO NOTHING", [SITE_KEY]);
}
const rl = new Map();
function rateLimited(ip, limit = 30) { // per 10 minutes
  const now = Date.now(); const e = rl.get(ip) || { n: 0, t: now };
  if (now - e.t > 600e3) { e.n = 0; e.t = now; }
  e.n++; rl.set(ip, e); return e.n > limit;
}
const cors = (req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); };
const clientIp = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function formPage(f, vid) {
  const field = x => {
    const req = x.required ? 'required' : '', id = `f_${x.key.replace(/\./g, '_')}`;
    const lab = `<label for="${id}">${esc(x.label)}${x.required ? ' <span class="req">*</span>' : ''}</label>`;
    if (x.type === 'textarea') return `<div class="field">${lab}<textarea id="${id}" name="${esc(x.key)}" rows="4" ${req}></textarea></div>`;
    if (x.type === 'select') return `<div class="field">${lab}<select id="${id}" name="${esc(x.key)}" ${req}><option value="">Choose…</option>${x.options.map(o => `<option>${esc(o)}</option>`).join('')}</select></div>`;
    if (x.type === 'checkbox') return `<div class="field check"><label><input type="checkbox" id="${id}" name="${esc(x.key)}" value="yes" ${req}> ${esc(x.label)}</label></div>`;
    return `<div class="field">${lab}<input id="${id}" type="${x.type}" name="${esc(x.key)}" ${req}></div>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(f.title || f.name)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet">
<style>:root{--m:#EC008C;--g:#636466;--line:#E2E2E5}*{box-sizing:border-box}body{margin:0;font-family:'Hanken Grotesk',Helvetica,Arial,sans-serif;color:#000;background:transparent;font-size:15px;line-height:1.45}
.wrap{max-width:560px;margin:0 auto;padding:8px 4px}h1{font-family:'Archivo',Arial,sans-serif;font-weight:800;text-transform:uppercase;font-size:20px;margin:0 0 6px;letter-spacing:.01em}.intro{color:var(--g);margin:0 0 18px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}.field{margin-bottom:12px}.field.check label{display:flex;gap:8px;align-items:center;font-weight:400;cursor:pointer}
label{display:block;font-size:12px;font-weight:500;color:var(--g);margin-bottom:4px}.req{color:var(--m)}
input,select,textarea{width:100%;font:inherit;border:1px solid var(--line);border-radius:6px;padding:9px 10px;background:#fff}input:focus,select:focus,textarea:focus{outline:2px solid var(--m);outline-offset:1px;border-color:var(--m)}
input[type=checkbox]{width:auto;margin:0}button{font:inherit;font-weight:600;background:var(--m);color:#fff;border:0;border-radius:6px;padding:11px 20px;cursor:pointer}button:hover{background:#C9007A}button[disabled]{opacity:.6}
.hp{position:absolute;left:-9999px}.msg{padding:14px 0;color:var(--g)}.msg.ok{color:#000}.err{color:#B42318;font-size:13px;margin-top:8px}@media(max-width:480px){.row{grid-template-columns:1fr}}</style></head>
<body><div class="wrap"><form id="f" novalidate>${f.title ? `<h1>${esc(f.title)}</h1>` : ''}${f.intro ? `<p class="intro">${esc(f.intro)}</p>` : ''}
<div class="row">${f.fields.filter(x => ['first', 'last'].includes(x.key)).map(field).join('')}</div>
${f.fields.filter(x => !['first', 'last'].includes(x.key)).map(field).join('')}
<input class="hp" type="text" name="website_url" tabindex="-1" autocomplete="off"><input type="hidden" name="_vid" value="${esc(vid || '')}"><input type="hidden" name="_page" id="pg">
<button type="submit">${esc(f.button)}</button><div class="err" id="e"></div></form><div class="msg ok" id="ok" style="display:none">${esc(f.thanks)}</div></div>
<script>(function(){var f=document.getElementById('f'),e=document.getElementById('e');try{document.getElementById('pg').value=document.referrer||location.href}catch(x){}
function h(){try{parent.postMessage({sq27:'height',h:document.body.scrollHeight+16},'*')}catch(x){}}h();window.addEventListener('load',h);new ResizeObserver(h).observe(document.body);
f.addEventListener('submit',function(ev){ev.preventDefault();e.textContent='';var req=f.querySelectorAll('[required]');for(var i=0;i<req.length;i++){var el=req[i];if((el.type==='checkbox'&&!el.checked)||(el.type!=='checkbox'&&!el.value.trim())){e.textContent='Please fill in the required fields.';el.focus();return}}
var d={};new FormData(f).forEach(function(v,k){d[k]=v});var b=f.querySelector('button');b.disabled=true;
fetch('/api/public/forms/${esc(f.key)}/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json().then(function(j){return[r.ok,j]})}).then(function(a){if(!a[0]){e.textContent=a[1].error||'Something went wrong';b.disabled=false;return}
${f.redirectUrl ? `try{parent.postMessage({sq27:'redirect',url:${JSON.stringify(f.redirectUrl)}},'*')}catch(x){}top.location.href=${JSON.stringify(f.redirectUrl)};` : `f.style.display='none';document.getElementById('ok').style.display='block';h();`}
}).catch(function(){e.textContent='Network error — please try again';b.disabled=false})})})();</script></body></html>`;
}

app.get('/f/:key', wrap(async (req, res) => {
  const f = (await q('SELECT * FROM forms WHERE key=$1 AND active', [req.params.key])).rows[0];
  if (!f) return res.status(404).send('Form not found');
  res.set({ 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.send(formPage(formOut(f), str(req.query.vid)));
}));
app.get('/f/:key/embed.js', (req, res) => {
  res.set({ 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=300' });
  res.send(`(function(){var s=document.currentScript,k=${JSON.stringify(req.params.key)},base=${JSON.stringify(APP_URL)};var m=document.cookie.match(/(?:^|; )_27sq=([^;]+)/);var vid=m?m[1]:'';
var d=document.createElement('div');d.className='sq27-form';var i=document.createElement('iframe');i.src=base+'/f/'+k+(vid?'?vid='+encodeURIComponent(vid):'');i.style.cssText='width:100%;border:0;min-height:320px;display:block';i.setAttribute('title','Contact form');i.setAttribute('scrolling','no');d.appendChild(i);s.parentNode.insertBefore(d,s);
window.addEventListener('message',function(ev){if(!ev.data||!ev.data.sq27)return;if(ev.source!==i.contentWindow)return;if(ev.data.sq27==='height')i.style.height=ev.data.h+'px';if(ev.data.sq27==='redirect')location.href=ev.data.url});})();`);
});
app.get('/track.js', (req, res) => {
  res.set({ 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=3600' });
  res.send(`(function(){var k=${JSON.stringify(SITE_KEY)},base=${JSON.stringify(APP_URL)};function uid(){return (Date.now().toString(36)+Math.random().toString(36).slice(2,12))}
var m=document.cookie.match(/(?:^|; )_27sq=([^;]+)/),v=m?m[1]:uid();document.cookie='_27sq='+v+'; path=/; max-age=31536000; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');
function send(){var p=JSON.stringify({k:k,vid:v,url:location.href,title:document.title,ref:document.referrer});if(navigator.sendBeacon){navigator.sendBeacon(base+'/api/public/track',new Blob([p],{type:'application/json'}))}else{fetch(base+'/api/public/track',{method:'POST',headers:{'Content-Type':'application/json'},body:p,keepalive:true}).catch(function(){})}}
send();var last=location.href;setInterval(function(){if(location.href!==last){last=location.href;send()}},1000);window.sq27={identify:function(email){fetch(base+'/api/public/identify/'+k,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,vid:v,url:location.href})}).catch(function(){})},vid:v};})();`);
});
app.options('/api/public/*', cors);
app.post('/api/public/track', cors, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.k !== SITE_KEY || !str(b.vid) || !str(b.url)) return res.status(400).json({ error: 'bad request' });
  if (rateLimited('t:' + clientIp(req), 600)) return res.status(429).json({ error: 'slow down' });
  const contact = (await q('SELECT id FROM contacts WHERE visitor_id=$1 LIMIT 1', [str(b.vid)])).rows[0];
  await q('INSERT INTO visits (visitor_id, contact_id, url, title, referrer) VALUES ($1,$2,$3,$4,$5)', [str(b.vid).slice(0, 64), contact?.id || null, str(b.url).slice(0, 1000), str(b.title).slice(0, 200), str(b.ref).slice(0, 1000)]);
  res.json({ ok: true });
}));

async function attachVisitor(contactId, vid) {
  if (!vid) return;
  await q('UPDATE contacts SET visitor_id=$2 WHERE id=$1 AND (visitor_id IS NULL OR visitor_id=\'\')', [contactId, vid]);
  const { rowCount } = await q('UPDATE visits SET contact_id=$1 WHERE visitor_id=$2 AND contact_id IS NULL', [contactId, vid]);
  if (rowCount) await logActivity({ contactId, type: 'Note', text: `Matched ${rowCount} earlier website visit${rowCount === 1 ? '' : 's'} to this contact` });
}

async function upsertContactFromWeb({ data, source, vertical, ownerId, vid, custom }) {
  const email = str(data.email).toLowerCase();
  let contact = email ? (await q('SELECT * FROM contacts WHERE lower(email)=$1 LIMIT 1', [email])).rows[0] : null;
  let companyId = contact?.company_id || null, created = false;
  const coName = str(data.company);
  if (coName && !companyId) {
    const co = (await q('SELECT id FROM companies WHERE lower(name)=$1 LIMIT 1', [coName.toLowerCase()])).rows[0] || (await q('INSERT INTO companies (name, vertical) VALUES ($1,$2) RETURNING id', [coName, vertical || ''])).rows[0];
    companyId = co.id;
  }
  if (!contact) {
    const ins = await q(`INSERT INTO contacts (first_name,last_name,title,email,phone,company_id,vertical,source,notes,owner_id,deal_migrated,visitor_id,custom)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12) RETURNING *`,
      [str(data.first).slice(0, 80), str(data.last).slice(0, 80), str(data.title).slice(0, 120), email, str(data.phone).slice(0, 40), companyId, vertical || '', source, str(data.message).slice(0, 2000), ownerId, vid || null, JSON.stringify(cleanCustom('contact', custom))]);
    contact = ins.rows[0]; created = true;
    if (str(data.linkedin)) await q('UPDATE contacts SET linkedin=$2 WHERE id=$1', [contact.id, cleanLinkedin(data.linkedin)]);
  } else {
    // fill blanks only
    await q(`UPDATE contacts SET first_name=COALESCE(NULLIF(first_name,''),$2), last_name=COALESCE(NULLIF(last_name,''),$3), phone=COALESCE(NULLIF(phone,''),$4), title=COALESCE(NULLIF(title,''),$5), company_id=COALESCE(company_id,$6), custom=custom || $7, linkedin=COALESCE(NULLIF(linkedin,''),$8), updated_at=now() WHERE id=$1`,
      [contact.id, str(data.first).slice(0, 80), str(data.last).slice(0, 80), str(data.phone).slice(0, 40), str(data.title).slice(0, 120), companyId, JSON.stringify(cleanCustom('contact', custom)), cleanLinkedin(data.linkedin)]);
    contact = (await q('SELECT * FROM contacts WHERE id=$1', [contact.id])).rows[0];
  }
  await attachVisitor(contact.id, vid);
  return { contact, created, companyId };
}

app.post('/api/public/forms/:key/submit', cors, wrap(async (req, res) => {
  const f = (await q('SELECT * FROM forms WHERE key=$1 AND active', [req.params.key])).rows[0];
  if (!f) return res.status(404).json({ error: 'Form not found' });
  const ip = clientIp(req);
  if (rateLimited('f:' + ip, 20)) return res.status(429).json({ error: 'Too many submissions, try again later' });
  const b = req.body || {};
  if (str(b.website_url)) return res.json({ ok: true }); // honeypot
  const data = {}, custom = {};
  for (const x of f.fields || []) {
    let v = b[x.key]; if (v == null) v = '';
    if (x.type === 'checkbox') v = v === 'yes' || v === true || v === 'on' || v === 'true';
    else v = str(v).slice(0, 2000);
    if (x.required && (v === '' || v === false)) return res.status(400).json({ error: `${x.label} is required` });
    if (x.key.startsWith('custom.')) custom[x.key.slice(7)] = v; else data[x.key] = v;
  }
  if (!data.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return res.status(400).json({ error: 'A valid email is required' });
  if (!data.first && !data.last) data.first = data.email.split('@')[0];
  const { contact, created, companyId } = await upsertContactFromWeb({ data, source: f.source, vertical: f.vertical, ownerId: f.owner_id, vid: str(b._vid), custom });
  let deal = null;
  if (f.create_deal) {
    const open = (await q('SELECT * FROM deals WHERE contact_id=$1 AND lost=FALSE AND won_at IS NULL LIMIT 1', [contact.id])).rows[0];
    if (!open) {
      const pipe = pipelineById(f.pipeline_id);
      deal = await createDeal({ name: str(data.company) || `${contact.first_name} ${contact.last_name}`.trim(), contactId: contact.id, companyId, pipelineId: pipe.id, stage: resolveStage(pipe, f.stage), value: 0, vertical: f.vertical, source: f.source, ownerId: f.owner_id, expectedClose: null, notes: '', custom: {} }, f.owner_id || null);
    } else deal = open;
  }
  const extra = Object.entries({ ...data, ...Object.fromEntries(Object.entries(custom).map(([k, v]) => ['custom.' + k, v])) }).filter(([k]) => !['first', 'last', 'email'].includes(k)).map(([k, v]) => `${k}: ${v}`).join(' · ');
  await q('INSERT INTO form_submissions (form_id, contact_id, deal_id, data, page_url, ip) VALUES ($1,$2,$3,$4,$5,$6)', [f.id, contact.id, deal?.id || null, JSON.stringify({ ...data, custom }), str(b._page).slice(0, 1000), ip]);
  await q('UPDATE forms SET submissions=submissions+1 WHERE id=$1', [f.id]);
  await logActivity({ contactId: contact.id, dealId: deal?.id || null, type: 'Note', text: `Form submitted: ${f.name}${extra ? ' — ' + extra.slice(0, 400) : ''}` });
  if (f.notify && (f.owner_id || contact.owner_id)) await notifyUser(f.owner_id || contact.owner_id, `${created ? 'New lead' : 'Form submission'}: ${contact.first_name} ${contact.last_name}`.trim(), `<p><b>${esc(f.name)}</b> submitted by ${esc(contact.first_name)} ${esc(contact.last_name)} &lt;${esc(contact.email)}&gt;${data.company ? ` at ${esc(data.company)}` : ''}.</p>${extra ? `<p>${esc(extra)}</p>` : ''}<p><a href="${APP_URL}/#contact/${contact.id}">Open contact</a></p>`, null);
  workflows.run('form_submitted', { contact, deal, form: f }).catch(() => {});
  if (created) workflows.run('contact_created', { contact, deal }).catch(() => {});
  res.json({ ok: true });
}));

// Identify webhook: SmartPiXL / One Connect / your own site can POST identified visitors here.
app.post('/api/public/identify/:key', cors, wrap(async (req, res) => {
  if (req.params.key !== SITE_KEY) return res.status(404).json({ error: 'not found' });
  if (rateLimited('i:' + clientIp(req), 300)) return res.status(429).json({ error: 'slow down' });
  const b = req.body || {};
  const email = str(b.email).toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'email required' });
  const { contact, created } = await upsertContactFromWeb({ data: { email, first: b.first || b.first_name, last: b.last || b.last_name, phone: b.phone, company: b.company, title: b.title }, source: str(b.source) || 'SmartPiXL', vertical: str(b.vertical), ownerId: intOrNull(b.ownerId), vid: str(b.vid), custom: b.custom });
  if (str(b.url)) { await q('INSERT INTO visits (visitor_id, contact_id, url, title, referrer) VALUES ($1,$2,$3,$4,$5)', [str(b.vid) || `id:${contact.id}`, contact.id, str(b.url).slice(0, 1000), str(b.title).slice(0, 200), str(b.ref).slice(0, 1000)]); }
  await logActivity({ contactId: contact.id, type: 'Note', text: `${created ? 'Identified website visitor' : 'Website visit identified'} via ${str(b.source) || 'SmartPiXL'}${str(b.url) ? ' — ' + str(b.url).slice(0, 200) : ''}` });
  if (created) { if (contact.owner_id) await notifyUser(contact.owner_id, `Identified visitor: ${email}`, `<p>${esc(str(b.source) || 'SmartPiXL')} identified <b>${esc(email)}</b>${str(b.url) ? ` on ${esc(str(b.url))}` : ''}.</p><p><a href="${APP_URL}/#contact/${contact.id}">Open contact</a></p>`, null); workflows.run('contact_created', { contact }).catch(() => {}); }
  res.json({ ok: true, contactId: contact.id, created });
}));

app.get('/api/contacts/:id/visits', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT url, title, referrer, created_at FROM visits WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 100', [req.params.id]);
  res.json(rows.map(r => ({ url: r.url, title: r.title, referrer: r.referrer, at: r.created_at })));
}));

/* ---------- workflows ---------- */
const cleanActions = acts => (Array.isArray(acts) ? acts : []).filter(a => workflows.ACTIONS.includes(a.type)).map(a => ({
  type: a.type, title: str(a.title).slice(0, 200), dueDays: a.dueDays === '' || a.dueDays == null ? null : Math.max(0, Number(a.dueDays) || 0), assignee: a.assignee === 'owner' ? 'owner' : (intOrNull(a.assignee) || 'owner'),
  subject: str(a.subject).slice(0, 300), message: str(a.message).slice(0, 2000), body: str(a.body).slice(0, 20000), sequenceId: intOrNull(a.sequenceId), userId: intOrNull(a.userId), stage: str(a.stage), text: str(a.text).slice(0, 2000),
})).slice(0, 10);
const cleanConditions = c => { c = c && typeof c === 'object' ? c : {}; return { pipelineId: intOrNull(c.pipelineId), stage: str(c.stage), fromStage: str(c.fromStage), vertical: str(c.vertical), source: str(c.source), ownerId: intOrNull(c.ownerId), formId: intOrNull(c.formId), days: c.days ? Math.max(1, Number(c.days) || 1) : null, minValue: c.minValue ? num(c.minValue) : null }; };
app.post('/api/workflows', requireAuth, wrap(async (req, res) => {
  const name = str(req.body.name), trigger = workflows.TRIGGERS.includes(req.body.trigger) ? req.body.trigger : null, actions = cleanActions(req.body.actions);
  if (!name || !trigger || !actions.length) return res.status(400).json({ error: 'Name, trigger and at least one action are required' });
  const { rows } = await q('INSERT INTO workflows (name,trigger,conditions,actions,active,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [name, trigger, JSON.stringify(cleanConditions(req.body.conditions)), JSON.stringify(actions), req.body.active !== false, req.session.user.id]);
  res.json(workflowOut(rows[0]));
}));
app.put('/api/workflows/:id', requireAuth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM workflows WHERE id=$1', [req.params.id])).rows[0]; if (!cur) return res.status(404).json({ error: 'Workflow not found' });
  const name = str(req.body.name) || cur.name, trigger = workflows.TRIGGERS.includes(req.body.trigger) ? req.body.trigger : cur.trigger;
  const actions = req.body.actions != null ? cleanActions(req.body.actions) : cur.actions; if (!actions.length) return res.status(400).json({ error: 'At least one action is required' });
  const { rows } = await q('UPDATE workflows SET name=$2,trigger=$3,conditions=$4,actions=$5,active=$6,updated_at=now() WHERE id=$1 RETURNING *', [cur.id, name, trigger, JSON.stringify(req.body.conditions != null ? cleanConditions(req.body.conditions) : cur.conditions), JSON.stringify(actions), req.body.active != null ? !!req.body.active : cur.active]);
  res.json(workflowOut(rows[0]));
}));
app.delete('/api/workflows/:id', requireAuth, wrap(async (req, res) => { await q('DELETE FROM workflows WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));
app.post('/api/workflows/scan', requireAdmin, wrap(async (req, res) => { await workflows.scanNoActivity(); res.json({ ok: true }); }));
app.get('/api/workflows/:id/runs', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT r.*, d.name AS deal_name, c.first_name, c.last_name FROM workflow_runs r LEFT JOIN deals d ON d.id=r.deal_id LEFT JOIN contacts c ON c.id=r.contact_id WHERE r.workflow_id=$1 ORDER BY r.ran_at DESC LIMIT 100', [req.params.id]);
  res.json(rows.map(r => ({ id: r.id, dealId: r.deal_id, dealName: r.deal_name, contactId: r.contact_id, contactName: [r.first_name, r.last_name].filter(Boolean).join(' '), summary: r.summary, at: r.ran_at })));
}));

/* ---------- meetings ---------- */
app.get('/api/meetings', requireAuth, wrap(async (req, res) => {
  const where = req.query.contactId ? ['contact_id=$1', req.query.contactId] : req.query.dealId ? ['deal_id=$1', req.query.dealId] : null;
  if (!where) return res.status(400).json({ error: 'contactId or dealId required' });
  const { rows } = await q(`SELECT * FROM meetings WHERE ${where[0]} ORDER BY starts_at DESC LIMIT 50`, [where[1]]);
  res.json(rows.map(meetingOut));
}));
app.post('/api/meetings/sync', requireAdmin, wrap(async (req, res) => { await calendar.sync(); res.json(calendar.status()); }));

/* ---------- dashboards & forecast ---------- */
const cleanWidgets = ws => (Array.isArray(ws) ? ws : []).filter(w => metrics.WIDGETS[w.type]).map(w => ({ type: w.type, size: [1, 2, 3].includes(Number(w.size)) ? Number(w.size) : 1, title: str(w.title).slice(0, 80) || undefined, options: w.options && typeof w.options === 'object' ? { pipelineId: intOrNull(w.options.pipelineId), days: intOrNull(w.options.days) } : {} })).slice(0, 24);
const RANGES = ['7d', '30d', '90d', 'mtd', 'qtd', 'ytd'];
const cleanRange = r => RANGES.includes(r) || /^custom:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(r) ? r : '30d';
app.post('/api/dashboards', requireAuth, wrap(async (req, res) => {
  const name = str(req.body.name); if (!name) return res.status(400).json({ error: 'Dashboard name is required' });
  const sort = (await q('SELECT COALESCE(MAX(sort),0)+1 AS s FROM dashboards')).rows[0].s;
  const { rows } = await q('INSERT INTO dashboards (name, widgets, range, email_weekly, email_to, sort, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
    [name, JSON.stringify(cleanWidgets(req.body.widgets)), cleanRange(req.body.range), !!req.body.emailWeekly, JSON.stringify((Array.isArray(req.body.emailTo) ? req.body.emailTo : []).map(Number).filter(Boolean)), sort, req.session.user.id]);
  res.json(dashboardOut(rows[0]));
}));
app.put('/api/dashboards/:id', requireAuth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM dashboards WHERE id=$1', [req.params.id])).rows[0]; if (!cur) return res.status(404).json({ error: 'Dashboard not found' });
  const { rows } = await q('UPDATE dashboards SET name=$2, widgets=$3, range=$4, email_weekly=$5, email_to=$6, updated_at=now() WHERE id=$1 RETURNING *',
    [cur.id, str(req.body.name) || cur.name, JSON.stringify(req.body.widgets != null ? cleanWidgets(req.body.widgets) : cur.widgets), req.body.range != null ? cleanRange(req.body.range) : cur.range,
      req.body.emailWeekly != null ? !!req.body.emailWeekly : cur.email_weekly, JSON.stringify(req.body.emailTo != null ? (Array.isArray(req.body.emailTo) ? req.body.emailTo : []).map(Number).filter(Boolean) : cur.email_to)]);
  res.json(dashboardOut(rows[0]));
}));
app.delete('/api/dashboards/:id', requireAuth, wrap(async (req, res) => {
  if ((await q('SELECT COUNT(*)::int AS n FROM dashboards')).rows[0].n < 2) return res.status(400).json({ error: "Can't delete the only dashboard" });
  await q('DELETE FROM dashboards WHERE id=$1', [req.params.id]); res.json({ ok: true });
}));
app.get('/api/dashboards/:id/data', requireAuth, wrap(async (req, res) => {
  const dash = (await q('SELECT * FROM dashboards WHERE id=$1', [req.params.id])).rows[0]; if (!dash) return res.status(404).json({ error: 'Dashboard not found' });
  res.json(await metrics.dashboardData(dash, req.query.range ? cleanRange(String(req.query.range)) : null));
}));
app.post('/api/dashboards/:id/email', requireAuth, wrap(async (req, res) => {
  const dash = (await q('SELECT * FROM dashboards WHERE id=$1', [req.params.id])).rows[0]; if (!dash) return res.status(404).json({ error: 'Dashboard not found' });
  if (!mailer.configured()) return res.status(400).json({ error: 'Email is not configured (Settings)' });
  const data = await metrics.dashboardData(dash);
  await mailer.send({ to: req.session.user.email, subject: `${dash.name} — ${data.range.label}`, html: metrics.digestHtml(dash.name, data) });
  res.json({ ok: true });
}));
app.get('/api/forecast', requireAuth, wrap(async (req, res) => { res.json(await metrics.forecast(Number(req.query.months) || 6)); }));
app.put('/api/quotas', requireAdmin, wrap(async (req, res) => {
  const items = (Array.isArray(req.body.quotas) ? req.body.quotas : []).filter(x => intOrNull(x.userId) && /^\d{4}-\d{2}$/.test(str(x.period)));
  for (const x of items) {
    if (!num(x.amount)) await q('DELETE FROM quotas WHERE user_id=$1 AND period=$2', [x.userId, x.period]);
    else await q('INSERT INTO quotas (user_id, period, amount) VALUES ($1,$2,$3) ON CONFLICT (user_id, period) DO UPDATE SET amount=EXCLUDED.amount', [x.userId, x.period, num(x.amount)]);
  }
  res.json({ ok: true, updated: items.length });
}));

/* ---------- API keys + inbound contacts (Zapier / Seamless / scripts) ---------- */
const hashKey = k => crypto.createHash('sha256').update(k).digest('hex');
app.get('/api/keys', requireAdmin, wrap(async (req, res) => {
  const { rows } = await q('SELECT k.id, k.name, k.prefix, k.last_used_at, k.uses, k.created_at, u.name AS created_by_name FROM api_keys k LEFT JOIN users u ON u.id=k.created_by ORDER BY k.created_at DESC');
  res.json(rows.map(r => ({ id: r.id, name: r.name, prefix: r.prefix, lastUsedAt: r.last_used_at, uses: r.uses, createdAt: r.created_at, createdBy: r.created_by_name })));
}));
app.post('/api/keys', requireAdmin, wrap(async (req, res) => {
  const name = str(req.body.name) || 'Integration';
  const key = 'sq27_' + crypto.randomBytes(24).toString('base64url');
  const { rows } = await q('INSERT INTO api_keys (name, key_hash, prefix, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [name, hashKey(key), key.slice(0, 10), req.session.user.id]);
  res.json({ id: rows[0].id, name, key }); // shown once
}));
app.delete('/api/keys/:id', requireAdmin, wrap(async (req, res) => { await q('DELETE FROM api_keys WHERE id=$1', [req.params.id]); res.json({ ok: true }); }));

async function authKey(key) {
  if (!key) return null;
  const { rows } = await q('UPDATE api_keys SET last_used_at=now(), uses=uses+1 WHERE key_hash=$1 RETURNING id, name, created_by', [hashKey(str(key))]);
  if (!rows[0]) return null;
  const u = rows[0].created_by ? (await q('SELECT id, name, email FROM users WHERE id=$1 AND active', [rows[0].created_by])).rows[0] : null;
  return u ? { ...u, keyName: rows[0].name } : { id: null, name: rows[0].name, email: null, keyName: rows[0].name };
}
const requireApiKey = wrap(async (req, res, next) => {
  const key = str(req.headers['x-api-key']) || str((req.headers.authorization || '').replace(/^Bearer\s+/i, '')) || str(req.query.key);
  if (!key) return res.status(401).json({ error: 'API key required (X-API-Key header)' });
  const { rows } = await q('UPDATE api_keys SET last_used_at=now(), uses=uses+1 WHERE key_hash=$1 RETURNING id, name', [hashKey(key)]);
  if (!rows[0]) return res.status(401).json({ error: 'Invalid API key' });
  req.apiKey = rows[0]; next();
});

// Accepts one contact object or {contacts:[...]}. Field names are forgiving: Seamless, Zapier, HubSpot-style keys all map.
const pick = (o, keys) => { for (const k of keys) { if (o[k] != null && String(o[k]).trim() !== '') return String(o[k]).trim(); } return ''; };
function normalizeInbound(o) {
  const name = pick(o, ['name', 'full_name', 'fullName']);
  let first = pick(o, ['first', 'first_name', 'firstName', 'firstname', 'given_name']), last = pick(o, ['last', 'last_name', 'lastName', 'lastname', 'surname', 'family_name']);
  if (!first && !last && name) { const parts = name.split(/\s+/); first = parts.shift() || ''; last = parts.join(' '); }
  const emails = [pick(o, ['email', 'email_address', 'work_email', 'business_email', 'emailAddress', 'primary_email']), ...(Array.isArray(o.emails) ? o.emails.map(e => typeof e === 'string' ? e : e?.email || e?.address || '') : [])].filter(Boolean);
  return {
    first, last, email: (emails[0] || '').toLowerCase(), phone: pick(o, ['phone', 'mobile', 'mobile_phone', 'direct_phone', 'work_phone', 'phone_number', 'cell']),
    title: pick(o, ['title', 'job_title', 'jobTitle', 'position']), company: pick(o, ['company', 'company_name', 'companyName', 'organization', 'account']),
    linkedin: pick(o, ['linkedin', 'linkedin_url', 'linkedinUrl', 'linkedin_profile', 'profile_url']), vertical: pick(o, ['vertical', 'industry']),
    source: pick(o, ['source']), notes: pick(o, ['notes', 'note', 'description']), list: pick(o, ['list', 'list_name', 'listName', 'lists']),
    city: pick(o, ['city']), state: pick(o, ['state', 'region']), domain: pick(o, ['domain', 'website', 'company_domain', 'company_website']),
    custom: o.custom && typeof o.custom === 'object' ? o.custom : {},
  };
}
async function ingestContacts({ list, source, ownerId, createDeals, pipelineId, stage: stageIn, via }) {
  const pipe = pipelineById(pipelineId); const stage = resolveStage(pipe, str(stageIn));
  const out = { created: 0, updated: 0, skipped: 0, deals: 0, ids: [] };
  for (const raw of list.slice(0, 500)) {
    const c = normalizeInbound(raw && typeof raw === 'object' ? raw : {});
    if (!c.email && !c.first && !c.last) { out.skipped++; continue; }
    const existing = c.email ? (await q('SELECT * FROM contacts WHERE lower(email)=$1 LIMIT 1', [c.email])).rows[0] : null;
    let companyId = existing?.company_id || null;
    if (c.company && !companyId) {
      const co = (await q('SELECT id FROM companies WHERE lower(name)=$1 LIMIT 1', [c.company.toLowerCase()])).rows[0] || (await q('INSERT INTO companies (name, vertical, domain, city, state) VALUES ($1,$2,$3,$4,$5) RETURNING id', [c.company, c.vertical, c.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), c.city, c.state])).rows[0];
      companyId = co.id;
    }
    const notes = [c.notes, c.list ? `Seamless list: ${c.list}` : ''].filter(Boolean).join('\n');
    let contact;
    if (existing) {
      await q(`UPDATE contacts SET first_name=COALESCE(NULLIF(first_name,''),$2), last_name=COALESCE(NULLIF(last_name,''),$3), phone=COALESCE(NULLIF(phone,''),$4), title=COALESCE(NULLIF(title,''),$5), company_id=COALESCE(company_id,$6), linkedin=COALESCE(NULLIF(linkedin,''),$7), custom=custom || $8, updated_at=now() WHERE id=$1`,
        [existing.id, c.first, c.last, c.phone, c.title, companyId, cleanLinkedin(c.linkedin), JSON.stringify(cleanCustom('contact', c.custom))]);
      contact = (await q('SELECT * FROM contacts WHERE id=$1', [existing.id])).rows[0]; out.updated++;
    } else {
      const ins = await q(`INSERT INTO contacts (first_name,last_name,title,email,phone,company_id,vertical,source,notes,owner_id,deal_migrated,linkedin,custom) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11,$12) RETURNING *`,
        [c.first, c.last, c.title, c.email, c.phone, companyId, c.vertical, c.source || source, notes, ownerId, cleanLinkedin(c.linkedin), JSON.stringify(cleanCustom('contact', c.custom))]);
      contact = ins.rows[0]; out.created++;
      await logActivity({ contactId: contact.id, type: 'Note', text: `Added via ${via}${c.list ? ` (list: ${c.list})` : ''}` });
      workflows.run('contact_created', { contact }).catch(() => {});
    }
    out.ids.push(contact.id);
    if (createDeals) {
      const open = (await q('SELECT id FROM deals WHERE contact_id=$1 AND lost=FALSE AND won_at IS NULL LIMIT 1', [contact.id])).rows[0];
      if (!open) { await createDeal({ name: c.company || `${c.first} ${c.last}`.trim(), contactId: contact.id, companyId, pipelineId: pipe.id, stage, value: 0, vertical: c.vertical, source: c.source || source, ownerId, expectedClose: null, notes: '', custom: {} }, ownerId); out.deals++; }
    }
  }
  return out;
}
app.post('/api/inbound/contacts', requireApiKey, wrap(async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : Array.isArray(body.contacts) ? body.contacts : [body];
  if (!list.length) return res.status(400).json({ error: 'No contacts in payload' });
  res.json(await ingestContacts({ list, source: str(body.source) || 'Seamless', ownerId: intOrNull(body.ownerId) || intOrNull(req.query.ownerId) || null, createDeals: body.createDeal === true || body.createDeals === true || req.query.createDeal === 'true', pipelineId: body.pipelineId, stage: body.stage, via: req.apiKey.name }));
}));

/* ---------- MCP (claude.ai custom connector) ---------- */
app.all('/mcp/:key', (req, res) => mcp.handle(req, res));
app.get('/.well-known/oauth-authorization-server', (req, res) => res.status(404).end()); // no OAuth: key is in the path

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
  if (!canSign(pipelineById(d.pipeline_id), d.stage)) return res.status(400).json({ error: 'Signatures can be sent once the deal reaches a signature stage (Proposal sent or Closed won)' });
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
  res.json({ appUrl: APP_URL, email: mailer.describe(), inbound: { configured: engage.imapConfigured(), host: process.env.IMAP_HOST || 'imap.gmail.com', mailbox: process.env.IMAP_USER || process.env.SMTP_USER || null, lastUid: (await q("SELECT value FROM meta WHERE key='imap_last_uid'")).rows[0]?.value || null }, docusign: await docusign.status(), webhookUrl: `${APP_URL}/api/docusign/webhook`, calendar: calendar.status(), siteKey: SITE_KEY, trackSnippet: `<script src="${APP_URL}/track.js" async></script>`, identifyUrl: `${APP_URL}/api/public/identify/${SITE_KEY}` });
}));
app.post('/api/settings/test-email', requireAdmin, wrap(async (req, res) => {
  await mailer.send({ to: req.session.user.email, subject: '27 Squared CRM — test email', html: '<p>Email notifications are working.</p>' });
  res.json({ ok: true });
}));

/* ---------- backup ---------- */
app.get('/api/export', requireAuth, wrap(async (req, res) => {
  const [contacts, companies, deals, activities, tasks, envelopes, emails, sequences, enrollments, properties, pipelines, products, dealItems, quotes, forms, formSubs, wfs, meetings, visits, dashboards, quotas] = await Promise.all([q('SELECT * FROM contacts'), q('SELECT * FROM companies'), q('SELECT * FROM deals'), q('SELECT * FROM activities'), q('SELECT * FROM tasks'), q('SELECT * FROM envelopes'), q('SELECT * FROM emails'), q('SELECT * FROM sequences'), q('SELECT * FROM enrollments'), q('SELECT * FROM properties'), q('SELECT * FROM pipelines'), q('SELECT * FROM products'), q('SELECT * FROM deal_items'), q('SELECT id, deal_id, number, title, intro, terms, items, one_time, monthly, total, valid_until, status, sent_to, sent_at, created_by, created_at FROM quotes'), q('SELECT * FROM forms'), q('SELECT * FROM form_submissions'), q('SELECT * FROM workflows'), q('SELECT * FROM meetings'), q('SELECT * FROM visits ORDER BY created_at DESC LIMIT 20000'), q('SELECT * FROM dashboards'), q('SELECT * FROM quotas')]);
  res.setHeader('Content-Disposition', `attachment; filename="27sq-crm-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date(), contacts: contacts.rows, companies: companies.rows, deals: deals.rows, activities: activities.rows, tasks: tasks.rows, envelopes: envelopes.rows, emails: emails.rows, sequences: sequences.rows, enrollments: enrollments.rows, properties: properties.rows, pipelines: pipelines.rows, products: products.rows, dealItems: dealItems.rows, quotes: quotes.rows, forms: forms.rows, formSubmissions: formSubs.rows, workflows: wfs.rows, meetings: meetings.rows, visits: visits.rows, dashboards: dashboards.rows, quotas: quotas.rows });
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
  // Monday: weekly dashboard digests
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: process.env.DIGEST_TZ || 'America/New_York', weekday: 'short' }).format(now);
  if (weekday === 'Mon') {
    const dashes = (await q('SELECT * FROM dashboards WHERE email_weekly')).rows;
    for (const dash of dashes) {
      try {
        const ids = (dash.email_to || []).map(Number); if (!ids.length) continue;
        const data = await metrics.dashboardData(dash, '7d');
        const html = metrics.digestHtml(dash.name, data);
        const recips = (await q('SELECT email FROM users WHERE active AND id = ANY($1)', [ids])).rows;
        for (const r of recips) mailer.send({ to: r.email, subject: `Weekly: ${dash.name}`, html }).catch(e => console.error('Dashboard digest failed:', e.message));
      } catch (e) { console.error('Dashboard digest failed:', e.message); }
    }
  }
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
  await loadPipelines();
  const seeded = await catalog.seedIfEmpty(q); if (seeded) console.log(`Seeded ${seeded} rate-card products`);
  await ensureSiteKey();
  engage.init({ query: q, appUrl: APP_URL });
  workflows.init({ query: q, appUrl: APP_URL, notifyUser, logActivity, pipelineById });
  calendar.init({ query: q, logActivity });
  metrics.init({ query: q, pipelineById });
  mcp.init({ q, authKey, createDeal, moveStage, setLost, logActivity, pipelineById, pipelines: () => PIPES, resolveStage, cleanCustom, cleanLinkedin, ingestContacts, engage, mailer, metrics });
  app.listen(PORT, () => console.log(`27 Squared CRM listening on ${PORT} (${APP_URL}) — email: ${mailer.configured() ? 'on' : 'off'}, inbound: ${engage.imapConfigured() ? 'on' : 'off'}, docusign: ${docusign.configured() ? 'on' : 'off'}, calendar: ${calendar.configured() ? 'on' : 'off'}`));
  setInterval(() => dailyDigestTick().catch(e => console.error('Digest tick failed:', e.message)), 60 * 1000);
  setInterval(() => engage.runDueEnrollments().catch(e => console.error('Sequence tick failed:', e.message)), 60 * 1000);
  setInterval(() => workflows.scanNoActivity().catch(e => console.error('Workflow scan failed:', e.message)), 60 * 60 * 1000);
  setTimeout(() => workflows.scanNoActivity().catch(() => {}), 30 * 1000);
  if (calendar.configured()) { calendar.sync().catch(() => {}); setInterval(() => calendar.sync().catch(e => console.error('Calendar sync failed:', e.message)), Number(process.env.CALENDAR_POLL_MINUTES || 10) * 60 * 1000); }
  if (engage.imapConfigured()) { engage.pollInbox().catch(() => {}); setInterval(() => engage.pollInbox().catch(() => {}), Number(process.env.IMAP_POLL_SECONDS || 60) * 1000); }
})().catch(e => { console.error('Boot failed:', e); process.exit(1); });
