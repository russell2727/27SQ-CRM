'use strict';
// Remote MCP server for the CRM. Mounted at /mcp/<api key> (stateless Streamable HTTP).
// Add it in claude.ai → Settings → Connectors → Add custom connector → that URL. Actions are attributed to the key's creator.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

let C = null; // context injected from server.js
function init(ctx) { C = ctx; }

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

function buildServer(actor) {
  const { q } = C;
  const server = new McpServer({ name: '27 Squared CRM', version: '1.0.0' });
  const userName = async id => id ? (await q('SELECT name FROM users WHERE id=$1', [id])).rows[0]?.name || '' : '';
  const brief = {
    contact: async r => ({ id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' '), email: r.email, phone: r.phone, title: r.title, company: r.company_id ? (await q('SELECT name FROM companies WHERE id=$1', [r.company_id])).rows[0]?.name : null, companyId: r.company_id, vertical: r.vertical, source: r.source, owner: await userName(r.owner_id), linkedin: r.linkedin || null, custom: r.custom || {}, lastEmailedAt: r.last_emailed_at, lastRepliedAt: r.last_replied_at, createdAt: r.created_at }),
    deal: async r => ({ id: r.id, name: r.name, stage: r.stage, pipeline: C.pipelineById(r.pipeline_id)?.name, value: Number(r.value), probability: r.lost ? 0 : (C.pipelineById(r.pipeline_id)?.stages || []).find(s => s.name === r.stage)?.probability ?? 0, lost: r.lost, won: !!r.won_at && !r.lost, contactId: r.contact_id, companyId: r.company_id, owner: await userName(r.owner_id), expectedClose: r.expected_close, forecastCategory: r.forecast_category, createdAt: r.created_at }),
  };
  const resolveContact = async ref => {
    if (!ref) return null;
    if (/^\d+$/.test(String(ref))) return (await q('SELECT * FROM contacts WHERE id=$1', [ref])).rows[0] || null;
    if (String(ref).includes('@')) return (await q('SELECT * FROM contacts WHERE lower(email)=$1 LIMIT 1', [String(ref).toLowerCase()])).rows[0] || null;
    return (await q("SELECT * FROM contacts WHERE (first_name || ' ' || last_name) ILIKE $1 ORDER BY updated_at DESC LIMIT 1", [`%${ref}%`])).rows[0] || null;
  };
  const resolveDeal = async ref => {
    if (!ref) return null;
    if (/^\d+$/.test(String(ref))) return (await q('SELECT * FROM deals WHERE id=$1', [ref])).rows[0] || null;
    return (await q('SELECT * FROM deals WHERE name ILIKE $1 ORDER BY updated_at DESC LIMIT 1', [`%${ref}%`])).rows[0] || null;
  };

  server.registerTool('get_setup', { title: 'CRM setup', description: 'Users, pipelines with stages, custom properties, sequences, forms. Call first to learn ids and valid stage names.', inputSchema: {} }, async () => {
    const [users, props, seqs, forms, products] = await Promise.all([q('SELECT id, name, email, role FROM users WHERE active ORDER BY name'), q('SELECT object, key, label, type, options FROM properties ORDER BY object, sort'), q('SELECT id, name, active, jsonb_array_length(steps) AS steps FROM sequences ORDER BY name'), q('SELECT id, key, name, active FROM forms ORDER BY name'), q('SELECT id, name, category, unit, billing, price FROM products WHERE active ORDER BY sort')]);
    return text({ actingAs: { id: actor.id, name: actor.name }, users: users.rows, pipelines: C.pipelines().map(p => ({ id: p.id, name: p.name, default: p.is_default, stages: p.stages })), customProperties: props.rows, sequences: seqs.rows, forms: forms.rows, rateCard: products.rows, verticals: ['Debt consolidation', 'Personal lending', 'Mortgage', 'Automotive', 'Powersports', 'RV / Marine', 'eCommerce', 'Other'] });
  });

  server.registerTool('find_contacts', { title: 'Find contacts', description: 'Search contacts by name, email, company, title or vertical. Returns up to `limit` matches.', inputSchema: { query: z.string().describe('Free text; matches name, email, title, company'), vertical: z.string().optional(), ownerId: z.number().optional(), limit: z.number().int().min(1).max(100).default(25) } }, async ({ query, vertical, ownerId, limit }) => {
    const { rows } = await q(`SELECT c.* FROM contacts c LEFT JOIN companies co ON co.id=c.company_id WHERE ($1='' OR (c.first_name||' '||c.last_name) ILIKE $2 OR c.email ILIKE $2 OR c.title ILIKE $2 OR co.name ILIKE $2) AND ($3::text IS NULL OR c.vertical=$3) AND ($4::int IS NULL OR c.owner_id=$4) ORDER BY c.updated_at DESC LIMIT $5`, [query || '', `%${query || ''}%`, vertical || null, ownerId || null, limit]);
    return text({ count: rows.length, contacts: await Promise.all(rows.map(brief.contact)) });
  });

  server.registerTool('get_contact', { title: 'Get contact', description: 'Full contact profile: deals, open tasks, recent activity, emails, meetings, sequence enrollments.', inputSchema: { contact: z.string().describe('Contact id, email, or name') } }, async ({ contact }) => {
    const c = await resolveContact(contact); if (!c) return fail('Contact not found');
    const [deals, tasks, acts, emails, meetings, enr] = await Promise.all([
      q('SELECT * FROM deals WHERE contact_id=$1 ORDER BY created_at DESC', [c.id]), q('SELECT id, title, due_at, done, assignee_id FROM tasks WHERE contact_id=$1 AND done=FALSE ORDER BY due_at NULLS LAST', [c.id]),
      q('SELECT a.type, a.text, a.created_at, u.name AS by FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.contact_id=$1 ORDER BY a.created_at DESC LIMIT 20', [c.id]),
      q('SELECT direction, subject, open_count, sent_at FROM emails WHERE contact_id=$1 ORDER BY sent_at DESC LIMIT 10', [c.id]), q("SELECT title, starts_at, status FROM meetings WHERE contact_id=$1 ORDER BY starts_at DESC LIMIT 5", [c.id]),
      q('SELECT e.status, e.current_step, e.next_send_at, s.name FROM enrollments e JOIN sequences s ON s.id=e.sequence_id WHERE e.contact_id=$1 ORDER BY e.started_at DESC LIMIT 5', [c.id])]);
    return text({ ...(await brief.contact(c)), notes: c.notes, deals: await Promise.all(deals.rows.map(brief.deal)), openTasks: tasks.rows, recentActivity: acts.rows, emails: emails.rows, meetings: meetings.rows, sequences: enr.rows });
  });

  const contactShape = { first: z.string().optional(), last: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), title: z.string().optional(), company: z.string().optional().describe('Company name; matched or created'), linkedin: z.string().optional(), vertical: z.string().optional(), source: z.string().optional(), notes: z.string().optional(), ownerId: z.number().optional(), custom: z.record(z.any()).optional().describe('Custom property values keyed by property key') };
  server.registerTool('add_contacts', { title: 'Add contacts', description: 'Create one or many contacts (dedupes by email; existing contacts get blanks filled). Optionally open a deal per contact. Use for Seamless/list pushes.', inputSchema: { contacts: z.array(z.object(contactShape)).min(1).max(500), createDeal: z.boolean().default(false), stage: z.string().optional(), pipelineId: z.number().optional(), ownerId: z.number().optional().describe('Defaults to you'), source: z.string().optional().describe('Default source for new contacts, e.g. Seamless') } }, async (a) => {
    const r = await C.ingestContacts({ list: a.contacts, source: a.source || 'Claude', ownerId: a.ownerId || actor.id, createDeals: a.createDeal, pipelineId: a.pipelineId, stage: a.stage, via: `Claude (${actor.name})` });
    return text(r);
  });

  server.registerTool('update_contact', { title: 'Update contact', description: 'Change fields on a contact. Only provided fields change.', inputSchema: { contact: z.string().describe('Contact id, email, or name'), ...contactShape } }, async ({ contact, ...f }) => {
    const c = await resolveContact(contact); if (!c) return fail('Contact not found');
    let companyId = c.company_id;
    if (f.company) { const co = (await q('SELECT id FROM companies WHERE lower(name)=$1 LIMIT 1', [f.company.toLowerCase()])).rows[0] || (await q('INSERT INTO companies (name) VALUES ($1) RETURNING id', [f.company])).rows[0]; companyId = co.id; }
    const custom = { ...(c.custom || {}), ...C.cleanCustom('contact', f.custom || {}) };
    const { rows } = await q(`UPDATE contacts SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name), email=COALESCE($4,email), phone=COALESCE($5,phone), title=COALESCE($6,title), company_id=$7, linkedin=COALESCE($8,linkedin), vertical=COALESCE($9,vertical), source=COALESCE($10,source), notes=COALESCE($11,notes), owner_id=COALESCE($12,owner_id), custom=$13, updated_at=now() WHERE id=$1 RETURNING *`,
      [c.id, f.first ?? null, f.last ?? null, f.email ? f.email.toLowerCase() : null, f.phone ?? null, f.title ?? null, companyId, f.linkedin ? C.cleanLinkedin(f.linkedin) : null, f.vertical ?? null, f.source ?? null, f.notes ?? null, f.ownerId ?? null, JSON.stringify(custom)]);
    return text(await brief.contact(rows[0]));
  });

  server.registerTool('find_companies', { title: 'Find companies', description: 'Search companies by name or domain, with contact and deal counts.', inputSchema: { query: z.string().default(''), limit: z.number().int().min(1).max(100).default(25) } }, async ({ query, limit }) => {
    const { rows } = await q(`SELECT co.*, (SELECT COUNT(*) FROM contacts c WHERE c.company_id=co.id)::int AS contacts, (SELECT COUNT(*) FROM deals d WHERE d.company_id=co.id AND d.lost=FALSE AND d.won_at IS NULL)::int AS open_deals, (SELECT COALESCE(SUM(value),0) FROM deals d WHERE d.company_id=co.id AND d.won_at IS NOT NULL AND d.lost=FALSE) AS won FROM companies co WHERE $1='' OR co.name ILIKE $2 OR co.domain ILIKE $2 ORDER BY co.name LIMIT $3`, [query, `%${query}%`, limit]);
    return text(rows.map(r => ({ id: r.id, name: r.name, domain: r.domain, vertical: r.vertical, size: r.size, city: r.city, state: r.state, contacts: r.contacts, openDeals: r.open_deals, wonRevenue: Number(r.won) })));
  });

  server.registerTool('list_deals', { title: 'List deals', description: 'Open deals (default) or all, filterable by stage, owner, pipeline, contact or company. Sorted by value.', inputSchema: { stage: z.string().optional(), ownerId: z.number().optional(), pipelineId: z.number().optional(), contactId: z.number().optional(), companyId: z.number().optional(), status: z.enum(['open', 'won', 'lost', 'all']).default('open'), limit: z.number().int().min(1).max(200).default(50) } }, async (a) => {
    const where = ['($1::text IS NULL OR stage=$1)', '($2::int IS NULL OR owner_id=$2)', '($3::int IS NULL OR pipeline_id=$3)', '($4::int IS NULL OR contact_id=$4)', '($5::int IS NULL OR company_id=$5)'];
    if (a.status === 'open') where.push('lost=FALSE AND won_at IS NULL'); else if (a.status === 'won') where.push('won_at IS NOT NULL AND lost=FALSE'); else if (a.status === 'lost') where.push('lost=TRUE');
    const { rows } = await q(`SELECT * FROM deals WHERE ${where.join(' AND ')} ORDER BY value DESC LIMIT $6`, [a.stage || null, a.ownerId || null, a.pipelineId || null, a.contactId || null, a.companyId || null, a.limit]);
    const deals = await Promise.all(rows.map(brief.deal));
    return text({ count: deals.length, totalValue: deals.reduce((s, d) => s + d.value, 0), weighted: Math.round(deals.reduce((s, d) => s + d.value * d.probability / 100, 0)), deals });
  });

  server.registerTool('get_deal', { title: 'Get deal', description: 'Deal with contact, company, line items, quotes, envelopes, tasks, recent activity.', inputSchema: { deal: z.string().describe('Deal id or name') } }, async ({ deal }) => {
    const d = await resolveDeal(deal); if (!d) return fail('Deal not found');
    const [c, co, items, quotes, envs, tasks, acts] = await Promise.all([
      d.contact_id ? q('SELECT * FROM contacts WHERE id=$1', [d.contact_id]) : { rows: [] }, d.company_id ? q('SELECT name, domain FROM companies WHERE id=$1', [d.company_id]) : { rows: [] },
      q('SELECT name, qty, unit, unit_price, billing, months, amount FROM deal_items WHERE deal_id=$1 ORDER BY sort', [d.id]), q('SELECT number, title, total, status, sent_to, sent_at, created_at FROM quotes WHERE deal_id=$1 ORDER BY created_at DESC', [d.id]),
      q('SELECT template_name, signer_email, status, sent_at, completed_at FROM envelopes WHERE deal_id=$1 ORDER BY sent_at DESC', [d.id]), q('SELECT id, title, due_at, done FROM tasks WHERE deal_id=$1 AND done=FALSE', [d.id]),
      q('SELECT a.type, a.text, a.created_at, u.name AS by FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.deal_id=$1 ORDER BY a.created_at DESC LIMIT 20', [d.id])]);
    return text({ ...(await brief.deal(d)), notes: d.notes, custom: d.custom, stageHistory: d.stage_history, contact: c.rows[0] ? await brief.contact(c.rows[0]) : null, company: co.rows[0] || null, lineItems: items.rows, quotes: quotes.rows, envelopes: envs.rows, openTasks: tasks.rows, recentActivity: acts.rows });
  });

  server.registerTool('create_deal', { title: 'Create deal', description: 'Open a deal for a contact and/or company.', inputSchema: { name: z.string(), contact: z.string().optional().describe('Contact id, email or name'), companyId: z.number().optional(), stage: z.string().optional(), pipelineId: z.number().optional(), value: z.number().optional(), vertical: z.string().optional(), source: z.string().optional(), expectedClose: z.string().optional().describe('YYYY-MM-DD'), ownerId: z.number().optional(), notes: z.string().optional() } }, async (a) => {
    const c = a.contact ? await resolveContact(a.contact) : null; if (a.contact && !c) return fail('Contact not found');
    const pipe = C.pipelineById(a.pipelineId);
    const d = await C.createDeal({ name: a.name, contactId: c?.id || null, companyId: a.companyId || c?.company_id || null, pipelineId: pipe.id, stage: C.resolveStage(pipe, a.stage), value: a.value || 0, vertical: a.vertical || c?.vertical || '', source: a.source || c?.source || '', expectedClose: a.expectedClose || null, notes: a.notes || '', ownerId: a.ownerId || actor.id, custom: {} }, actor.id);
    return text(await brief.deal(d));
  });

  server.registerTool('update_deal', { title: 'Update deal', description: 'Move stage, set value, owner, expected close, forecast category, mark lost/reopen. Only provided fields change.', inputSchema: { deal: z.string(), stage: z.string().optional(), value: z.number().optional(), ownerId: z.number().optional(), expectedClose: z.string().optional(), forecastCategory: z.enum(['pipeline', 'best', 'commit', 'omit']).optional(), lost: z.boolean().optional(), name: z.string().optional(), notes: z.string().optional() } }, async (a) => {
    const d = await resolveDeal(a.deal); if (!d) return fail('Deal not found');
    const pipe = C.pipelineById(d.pipeline_id);
    if (a.stage && a.stage !== d.stage) { const r = await C.moveStage(d, a.stage, actor); if (r.error) return fail(r.error); }
    if (a.lost != null && a.lost !== d.lost) await C.setLost(d, a.lost, actor);
    await q('UPDATE deals SET value=CASE WHEN value_auto THEN value ELSE COALESCE($2,value) END, owner_id=COALESCE($3,owner_id), expected_close=COALESCE($4::date,expected_close), forecast_category=COALESCE($5,forecast_category), name=COALESCE($6,name), notes=COALESCE($7,notes), updated_at=now() WHERE id=$1', [d.id, a.value ?? null, a.ownerId ?? null, a.expectedClose || null, a.forecastCategory ?? null, a.name ?? null, a.notes ?? null]);
    return text(await brief.deal((await q('SELECT * FROM deals WHERE id=$1', [d.id])).rows[0]));
  });

  server.registerTool('log_activity', { title: 'Log activity', description: 'Add a note, call, email, meeting or proposal entry to a contact and/or deal timeline.', inputSchema: { contact: z.string().optional(), deal: z.string().optional(), type: z.enum(['Note', 'Call', 'Email', 'Meeting', 'Proposal']).default('Note'), text: z.string() } }, async (a) => {
    const c = a.contact ? await resolveContact(a.contact) : null, d = a.deal ? await resolveDeal(a.deal) : null;
    if (!c && !d) return fail('Provide a contact or deal');
    await C.logActivity({ contactId: c?.id || d?.contact_id || null, dealId: d?.id || null, userId: actor.id, type: a.type, text: a.text });
    return text({ ok: true });
  });

  server.registerTool('create_task', { title: 'Create task', description: 'Create a follow-up task, optionally linked to a deal or contact and due on a date.', inputSchema: { title: z.string(), dueAt: z.string().optional().describe('YYYY-MM-DD'), assigneeId: z.number().optional().describe('Defaults to you'), deal: z.string().optional(), contact: z.string().optional() } }, async (a) => {
    const d = a.deal ? await resolveDeal(a.deal) : null, c = a.contact ? await resolveContact(a.contact) : null;
    const { rows } = await q('INSERT INTO tasks (title,due_at,deal_id,contact_id,assignee_id,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, due_at', [a.title, a.dueAt || null, d?.id || null, c?.id || d?.contact_id || null, a.assigneeId || actor.id, actor.id]);
    return text(rows[0]);
  });

  server.registerTool('list_tasks', { title: 'List tasks', description: 'Open tasks, optionally for one user; flags overdue.', inputSchema: { assigneeId: z.number().optional(), includeDone: z.boolean().default(false) } }, async (a) => {
    const { rows } = await q('SELECT t.id, t.title, t.due_at, t.done, u.name AS assignee, d.name AS deal, (c.first_name||\' \'||c.last_name) AS contact FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id LEFT JOIN deals d ON d.id=t.deal_id LEFT JOIN contacts c ON c.id=t.contact_id WHERE ($1::int IS NULL OR t.assignee_id=$1) AND ($2 OR t.done=FALSE) ORDER BY t.done, t.due_at NULLS LAST LIMIT 200', [a.assigneeId || null, a.includeDone]);
    const today = new Date().toISOString().slice(0, 10);
    return text(rows.map(r => ({ ...r, overdue: !r.done && r.due_at && String(r.due_at) < today })));
  });

  server.registerTool('complete_task', { title: 'Complete task', description: 'Mark a task done.', inputSchema: { taskId: z.number() } }, async ({ taskId }) => { await q('UPDATE tasks SET done=TRUE, done_at=now() WHERE id=$1', [taskId]); return text({ ok: true }); });

  server.registerTool('send_email', { title: 'Send email', description: 'Send a tracked one-to-one email to a contact from your name via connect@. Merge tags like {{first_name}} work. Confirm with the user before sending.', inputSchema: { contact: z.string(), subject: z.string(), body: z.string().describe('Plain text; blank line = paragraph'), deal: z.string().optional() } }, async (a) => {
    const c = await resolveContact(a.contact); if (!c) return fail('Contact not found'); if (!c.email) return fail('Contact has no email');
    const d = a.deal ? await resolveDeal(a.deal) : null;
    if (!C.mailer.configured()) return fail('Email is not configured in the CRM');
    const user = (await q('SELECT * FROM users WHERE id=$1', [actor.id])).rows[0];
    const e = await C.engage.sendTracked({ contact: c, deal: d, user, to: c.email, subject: a.subject, body: a.body });
    return text({ ok: true, to: e.to_email, subject: e.subject });
  });

  server.registerTool('enroll_in_sequence', { title: 'Enroll in sequence', description: 'Enroll one or more contacts in an email sequence (sender = you unless senderId given). Confirm with the user first.', inputSchema: { sequence: z.string().describe('Sequence id or name'), contacts: z.array(z.string()).min(1).describe('Contact ids, emails or names'), senderId: z.number().optional() } }, async (a) => {
    const seq = /^\d+$/.test(a.sequence) ? (await q('SELECT * FROM sequences WHERE id=$1', [a.sequence])).rows[0] : (await q('SELECT * FROM sequences WHERE name ILIKE $1 LIMIT 1', [`%${a.sequence}%`])).rows[0];
    if (!seq) return fail('Sequence not found'); if (!seq.active) return fail('Sequence is paused');
    const out = { enrolled: 0, skipped: [] };
    for (const ref of a.contacts) { const c = await resolveContact(ref); if (!c) { out.skipped.push(`${ref}: not found`); continue; } const r = await C.engage.enroll({ sequence: seq, contactId: c.id, dealId: null, userId: a.senderId || actor.id }); if (r.enrollment) out.enrolled++; else out.skipped.push(`${c.email || ref}: ${r.skipped}`); }
    C.engage.runDueEnrollments().catch(() => {});
    return text(out);
  });

  server.registerTool('pipeline_summary', { title: 'Pipeline summary', description: 'Open pipeline by stage and owner with weighted forecast; won/lost in the last N days.', inputSchema: { days: z.number().int().default(30), pipelineId: z.number().optional() } }, async (a) => {
    const pipe = C.pipelineById(a.pipelineId);
    const { rows } = await q('SELECT d.*, u.name AS owner FROM deals d LEFT JOIN users u ON u.id=d.owner_id WHERE d.pipeline_id=$1', [pipe.id]);
    const open = rows.filter(d => !d.lost && !d.won_at), since = Date.now() - a.days * 864e5;
    const prob = d => (pipe.stages.find(s => s.name === d.stage) || {}).probability || 0;
    const byStage = pipe.stages.filter(s => !s.won).map(s => { const ds = open.filter(d => d.stage === s.name); return { stage: s.name, probability: s.probability, deals: ds.length, value: ds.reduce((x, d) => x + Number(d.value), 0) }; });
    const byOwner = {}; open.forEach(d => { const k = d.owner || 'Unassigned'; byOwner[k] = byOwner[k] || { deals: 0, value: 0, weighted: 0 }; byOwner[k].deals++; byOwner[k].value += Number(d.value); byOwner[k].weighted += Number(d.value) * prob(d) / 100; });
    const won = rows.filter(d => d.won_at && !d.lost && new Date(d.won_at) > since), lost = rows.filter(d => d.lost && new Date(d.lost_at || d.created_at) > since);
    return text({ pipeline: pipe.name, openDeals: open.length, openValue: open.reduce((x, d) => x + Number(d.value), 0), weighted: Math.round(open.reduce((x, d) => x + Number(d.value) * prob(d) / 100, 0)), byStage, byOwner, lastDays: a.days, won: { count: won.length, value: won.reduce((x, d) => x + Number(d.value), 0) }, lost: { count: lost.length, value: lost.reduce((x, d) => x + Number(d.value), 0) } });
  });

  server.registerTool('forecast', { title: 'Forecast', description: 'Monthly forecast per rep: quota, won, commit, best case, pipeline, weighted, gap.', inputSchema: { months: z.number().int().min(1).max(12).default(3) } }, async ({ months }) => {
    const F = await C.metrics.forecast(months);
    return text({ months: F.months.map(m => m.label), reps: F.reps.map(r => ({ name: r.name, months: r.months.map(m => ({ quota: m.quota, won: m.won, commit: m.commit, best: m.best, pipeline: m.pipeline, weighted: m.weighted, forecast: m.forecast, gap: m.gap })) })), team: F.team.months.map(m => ({ quota: m.quota, won: m.won, commit: m.commit, best: m.best, pipeline: m.pipeline, forecast: m.forecast, gap: m.gap })), dealsWithoutCloseDate: F.noClose.length });
  });

  server.registerTool('recent_activity', { title: 'Recent activity', description: 'What happened across the CRM in the last N hours: stage moves, emails, replies, form submissions, tasks.', inputSchema: { hours: z.number().int().default(48), limit: z.number().int().max(200).default(60) } }, async (a) => {
    const { rows } = await q("SELECT a.type, a.text, a.created_at, u.name AS by, d.name AS deal, (c.first_name||' '||c.last_name) AS contact FROM activities a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN deals d ON d.id=a.deal_id LEFT JOIN contacts c ON c.id=a.contact_id WHERE a.created_at > now() - ($1 || ' hours')::interval ORDER BY a.created_at DESC LIMIT $2", [String(a.hours), a.limit]);
    return text(rows);
  });

  return server;
}

// Express handler: POST /mcp/:key (also GET/DELETE for protocol completeness). Stateless: new server+transport per request.
async function handle(req, res) {
  try {
    const actor = await C.authKey(req.params.key);
    if (!actor) { res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid API key' }, id: null }); return; }
    if (req.method !== 'POST') { res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }); return; }
    const server = buildServer(actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error:', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

module.exports = { init, handle };
