'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres service on Railway and reference its DATABASE_URL.');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set — using a random one; every deploy will log all users out.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

const STAGES = ['New lead', 'Contacted', 'Qualified', 'Proposal sent', 'Closed won'];

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
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
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, createdAt: u.created_at });

const contactOut = r => ({
  id: r.id, first: r.first_name, last: r.last_name, title: r.title, email: r.email, phone: r.phone,
  companyId: r.company_id, vertical: r.vertical, source: r.source, stage: r.stage, value: Number(r.value),
  notes: r.notes, lost: r.lost, lostAt: r.lost_at, wonAt: r.won_at, stageHistory: r.stage_history || [],
  ownerId: r.owner_id, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
const companyOut = r => ({
  id: r.id, name: r.name, domain: r.domain, phone: r.phone, vertical: r.vertical, size: r.size,
  city: r.city, state: r.state, notes: r.notes, createdAt: r.created_at,
});
const activityOut = r => ({ id: r.id, contactId: r.contact_id, userId: r.user_id, userName: r.user_name, type: r.type, text: r.text, at: r.created_at });

async function logActivity(contactId, userId, type, text) {
  await q('INSERT INTO activities (contact_id, user_id, type, text) VALUES ($1,$2,$3,$4)', [contactId, userId, type, text]);
}

/* ---------- auth ---------- */
app.get('/api/auth/status', wrap(async (req, res) => {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  res.json({ needsSetup: rows[0].n === 0, user: req.session.user || null });
}));

// First-run only: creates the admin account.
app.post('/api/auth/setup', wrap(async (req, res) => {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM users');
  if (rows[0].n > 0) return res.status(403).json({ error: 'Setup already completed' });
  const email = str(req.body.email).toLowerCase(), name = str(req.body.name), password = String(req.body.password || '');
  if (!email || !name || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required' });
  const hash = await bcrypt.hash(password, 11);
  const ins = await q('INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *', [email, name, hash, 'admin']);
  req.session.user = publicUser(ins.rows[0]);
  res.json({ user: req.session.user });
}));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase(), password = String(req.body.password || '');
  const { rows } = await q('SELECT * FROM users WHERE email=$1', [email]);
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
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
  const [contacts, companies, users] = await Promise.all([
    q('SELECT * FROM contacts ORDER BY created_at DESC'),
    q('SELECT * FROM companies ORDER BY name'),
    q('SELECT id, name, email, role, active, created_at FROM users ORDER BY name'),
  ]);
  res.json({
    user: req.session.user,
    contacts: contacts.rows.map(contactOut),
    companies: companies.rows.map(companyOut),
    users: users.rows.map(publicUser),
    stages: STAGES,
  });
}));

/* ---------- companies ---------- */
const companyFields = b => [str(b.name), str(b.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, ''), str(b.phone), str(b.vertical), str(b.size), str(b.city), str(b.state), str(b.notes)];

app.post('/api/companies', requireAuth, wrap(async (req, res) => {
  const f = companyFields(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Company name is required' });
  const { rows } = await q('INSERT INTO companies (name,domain,phone,vertical,size,city,state,notes,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [...f, req.session.user.id]);
  res.json(companyOut(rows[0]));
}));
app.put('/api/companies/:id', requireAuth, wrap(async (req, res) => {
  const f = companyFields(req.body);
  if (!f[0]) return res.status(400).json({ error: 'Company name is required' });
  const { rows } = await q('UPDATE companies SET name=$1,domain=$2,phone=$3,vertical=$4,size=$5,city=$6,state=$7,notes=$8,updated_at=now() WHERE id=$9 RETURNING *', [...f, req.params.id]);
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
  companyId: b.companyId ? Number(b.companyId) : null, vertical: str(b.vertical), source: str(b.source),
  stage: STAGES.includes(b.stage) ? b.stage : 'New lead', value: num(b.value), notes: str(b.notes),
  ownerId: b.ownerId ? Number(b.ownerId) : null,
});

app.post('/api/contacts', requireAuth, wrap(async (req, res) => {
  const f = contactFields(req.body);
  if (!f.first && !f.last) return res.status(400).json({ error: 'Add at least a first or last name' });
  const history = JSON.stringify([{ stage: f.stage, at: new Date().toISOString(), by: req.session.user.id }]);
  const wonAt = f.stage === 'Closed won' ? new Date() : null;
  const { rows } = await q(
    `INSERT INTO contacts (first_name,last_name,title,email,phone,company_id,vertical,source,stage,value,notes,owner_id,created_by,stage_history,won_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [f.first, f.last, f.title, f.email, f.phone, f.companyId, f.vertical, f.source, f.stage, f.value, f.notes, f.ownerId || req.session.user.id, req.session.user.id, history, wonAt]);
  res.json(contactOut(rows[0]));
}));

app.put('/api/contacts/:id', requireAuth, wrap(async (req, res) => {
  const f = contactFields(req.body);
  if (!f.first && !f.last) return res.status(400).json({ error: 'Add at least a first or last name' });
  const cur = (await q('SELECT * FROM contacts WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Contact not found' });
  let history = cur.stage_history || [], wonAt = cur.won_at;
  if (cur.stage !== f.stage) {
    history = [...history, { stage: f.stage, at: new Date().toISOString(), by: req.session.user.id }];
    if (f.stage === 'Closed won') wonAt = new Date();
    await logActivity(cur.id, req.session.user.id, 'Note', `Moved to ${f.stage}`);
  }
  const { rows } = await q(
    `UPDATE contacts SET first_name=$1,last_name=$2,title=$3,email=$4,phone=$5,company_id=$6,vertical=$7,source=$8,stage=$9,value=$10,notes=$11,owner_id=$12,stage_history=$13,won_at=$14,updated_at=now()
     WHERE id=$15 RETURNING *`,
    [f.first, f.last, f.title, f.email, f.phone, f.companyId, f.vertical, f.source, f.stage, f.value, f.notes, f.ownerId, JSON.stringify(history), wonAt, req.params.id]);
  res.json(contactOut(rows[0]));
}));

app.patch('/api/contacts/:id/stage', requireAuth, wrap(async (req, res) => {
  const stage = req.body.stage;
  if (!STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown stage' });
  const cur = (await q('SELECT * FROM contacts WHERE id=$1', [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: 'Contact not found' });
  if (cur.stage === stage && !cur.lost) return res.json(contactOut(cur));
  const history = [...(cur.stage_history || []), { stage, at: new Date().toISOString(), by: req.session.user.id }];
  const wonAt = stage === 'Closed won' ? new Date() : cur.won_at;
  const { rows } = await q('UPDATE contacts SET stage=$1, lost=FALSE, lost_at=NULL, stage_history=$2, won_at=$3, updated_at=now() WHERE id=$4 RETURNING *', [stage, JSON.stringify(history), wonAt, cur.id]);
  await logActivity(cur.id, req.session.user.id, 'Note', `Moved to ${stage}`);
  res.json(contactOut(rows[0]));
}));

app.patch('/api/contacts/:id/lost', requireAuth, wrap(async (req, res) => {
  const lost = !!req.body.lost;
  const { rows } = await q('UPDATE contacts SET lost=$1, lost_at=$2, updated_at=now() WHERE id=$3 RETURNING *', [lost, lost ? new Date() : null, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
  await logActivity(rows[0].id, req.session.user.id, 'Note', lost ? 'Marked lost' : 'Reopened');
  res.json(contactOut(rows[0]));
}));

app.delete('/api/contacts/:id', requireAuth, wrap(async (req, res) => {
  await q('DELETE FROM contacts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- activities ---------- */
app.get('/api/contacts/:id/activities', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.contact_id=$1 ORDER BY a.created_at DESC', [req.params.id]);
  res.json(rows.map(activityOut));
}));
app.post('/api/contacts/:id/activities', requireAuth, wrap(async (req, res) => {
  const text = str(req.body.text), type = str(req.body.type) || 'Note';
  if (!text) return res.status(400).json({ error: 'Activity text is required' });
  await logActivity(req.params.id, req.session.user.id, type, text);
  res.json({ ok: true });
}));

/* ---------- users (admin) ---------- */
app.post('/api/users', requireAdmin, wrap(async (req, res) => {
  const email = str(req.body.email).toLowerCase(), name = str(req.body.name), password = String(req.body.password || ''), role = req.body.role === 'admin' ? 'admin' : 'member';
  if (!email || !name || password.length < 8) return res.status(400).json({ error: 'Name, email and a password of 8+ characters are required' });
  const exists = await q('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rows[0]) return res.status(409).json({ error: 'A user with that email already exists' });
  const { rows } = await q('INSERT INTO users (email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING *', [email, name, await bcrypt.hash(password, 11), role]);
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

/* ---------- backup ---------- */
app.get('/api/export', requireAuth, wrap(async (req, res) => {
  const [contacts, companies, activities] = await Promise.all([q('SELECT * FROM contacts'), q('SELECT * FROM companies'), q('SELECT * FROM activities')]);
  res.setHeader('Content-Disposition', `attachment; filename="27sq-crm-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date(), contacts: contacts.rows, companies: companies.rows, activities: activities.rows });
}));

/* ---------- static + errors ---------- */
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Something went wrong on the server' }); });

/* ---------- boot ---------- */
(async () => {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  app.listen(PORT, () => console.log(`27 Squared CRM listening on ${PORT}`));
})().catch(e => { console.error('Boot failed:', e); process.exit(1); });
