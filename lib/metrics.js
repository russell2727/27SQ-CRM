'use strict';
// Dashboard widgets and forecasting, computed server-side.
let q, pipelineById;
function init({ query, pipelineById: pb }) { q = query; pipelineById = pb; }

const TZ = process.env.DIGEST_TZ || 'America/New_York';
const money0 = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

function stageMeta(d) { const pipe = pipelineById(d.pipeline_id); const st = (pipe?.stages || []).find(s => s.name === d.stage) || {}; return { pipe, st, prob: d.lost ? 0 : (st.probability ?? 0), won: !!st.won && !d.lost, open: !d.lost && !st.won }; }
function category(d) {
  const { prob, won, open } = stageMeta(d);
  if (won) return 'won';
  if (!open) return 'lost';
  if (d.forecast_category) return d.forecast_category;
  return prob >= 75 ? 'commit' : prob >= 50 ? 'best' : 'pipeline';
}
function ymLocal(date) { const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(new Date(date)).reduce((a, x) => (a[x.type] = x.value, a), {}); return `${p.year}-${p.month}`; }
function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); }

// Date range: '7d' | '30d' | '90d' | 'mtd' | 'qtd' | 'ytd' | 'custom:YYYY-MM-DD:YYYY-MM-DD'
function rangeBounds(range) {
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const y = Number(local.year), m = Number(local.month), d = Number(local.day);
  const from = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd, 12));
  let start, end = now, label;
  const days = { '7d': 7, '30d': 30, '90d': 90 }[range];
  if (days) { start = new Date(now.getTime() - days * 864e5); label = `Last ${days} days`; }
  else if (range === 'mtd') { start = from(y, m, 1); label = 'Month to date'; }
  else if (range === 'qtd') { start = from(y, m - ((m - 1) % 3), 1); label = 'Quarter to date'; }
  else if (range === 'ytd') { start = from(y, 1, 1); label = 'Year to date'; }
  else if (range && range.startsWith('custom:')) { const [, a, b] = range.split(':'); start = new Date(a + 'T00:00:00'); end = new Date(b + 'T23:59:59'); label = `${a} → ${b}`; }
  else { start = new Date(now.getTime() - 30 * 864e5); label = 'Last 30 days'; }
  return { start, end, label };
}

const WIDGETS = {
  kpis: 'Key numbers', forecast_by_month: 'Weighted forecast by close month', pipeline_by_stage: 'Open pipeline by stage', pipeline_by_owner: 'Open pipeline by owner',
  won_by_owner: 'Won revenue by owner', deals_over_time: 'New vs won deals over time', source_roi: 'Source performance', deals_by_vertical: 'Deals by vertical',
  activity_leaderboard: 'Activity leaderboard', email_performance: 'Email performance by sender', sequence_performance: 'Sequence performance', funnel: 'Stage funnel',
  top_companies: 'Top companies by won revenue', quotes: 'Quotes', tasks_by_user: 'Open & overdue tasks by user', quota_attainment: 'Quota attainment (this month)', forms: 'Form submissions', stale_deals: 'Stale deals (no activity 14+ days)',
};

async function loadAll() {
  const [deals, contacts, users, activities, emails, enrollments, sequences, quotes, tasks, envelopes, companies, forms, subs, quotas] = await Promise.all([
    q('SELECT * FROM deals'), q('SELECT id, first_name, last_name, company_id, source, vertical, owner_id, created_at FROM contacts'), q('SELECT id, name, email, active FROM users'),
    q("SELECT user_id, type, created_at, deal_id FROM activities WHERE created_at > now() - interval '400 days'"),
    q("SELECT user_id, direction, open_count, sent_at, enrollment_id, contact_id FROM emails WHERE sent_at > now() - interval '400 days'"),
    q('SELECT * FROM enrollments'), q('SELECT id, name FROM sequences'), q('SELECT deal_id, total, status, sent_at, created_at FROM quotes'),
    q('SELECT assignee_id, done, due_at FROM tasks'), q("SELECT status FROM envelopes"), q('SELECT id, name FROM companies'), q('SELECT id, name, submissions FROM forms'),
    q("SELECT form_id, created_at FROM form_submissions WHERE created_at > now() - interval '400 days'"), q('SELECT * FROM quotas'),
  ]);
  return { deals: deals.rows, contacts: contacts.rows, users: users.rows, activities: activities.rows, emails: emails.rows, enrollments: enrollments.rows, sequences: sequences.rows, quotes: quotes.rows, tasks: tasks.rows, envelopes: envelopes.rows, companies: companies.rows, forms: forms.rows, subs: subs.rows, quotas: quotas.rows };
}

function compute(type, D, { start, end }, options = {}) {
  const inRange = t => { const x = new Date(t); return x >= start && x <= end; };
  const userName = id => (D.users.find(u => u.id === id) || {}).name || 'Unassigned';
  const meta = D.deals.map(d => ({ d, ...stageMeta(d) }));
  const open = meta.filter(x => x.open), won = meta.filter(x => x.won);
  const wonIn = won.filter(x => inRange(x.d.won_at || x.d.created_at));
  const sum = arr => arr.reduce((a, x) => a + Number(x.d.value || 0), 0);
  const group = (arr, keyFn, valFn = () => 1) => { const m = {}; arr.forEach(x => { const k = keyFn(x); m[k] = (m[k] || 0) + valFn(x); }); return Object.entries(m); };
  const bars = (entries, money = false) => entries.sort((a, b) => b[1] - a[1]).map(([label, value]) => ({ label, value, money }));

  switch (type) {
    case 'kpis': {
      const lostIn = meta.filter(x => x.d.lost && inRange(x.d.lost_at || x.d.created_at));
      const emailsOut = D.emails.filter(e => e.direction === 'out' && inRange(e.sent_at)), opened = emailsOut.filter(e => e.open_count > 0), replies = D.emails.filter(e => e.direction === 'in' && inRange(e.sent_at));
      const meetingsHeld = D.activities.filter(a => a.type === 'Meeting' && inRange(a.created_at)).length;
      return { kpis: [
        { label: 'New contacts', value: D.contacts.filter(c => inRange(c.created_at)).length },
        { label: 'New deals', value: meta.filter(x => inRange(x.d.created_at)).length },
        { label: 'Deals won', value: wonIn.length, accent: true },
        { label: 'Won revenue', value: sum(wonIn), money: true, accent: true },
        { label: 'Win rate', value: (wonIn.length + lostIn.length) ? Math.round(wonIn.length / (wonIn.length + lostIn.length) * 100) + '%' : '—' },
        { label: 'Open pipeline', value: sum(open), money: true },
        { label: 'Weighted forecast', value: open.reduce((a, x) => a + Number(x.d.value || 0) * x.prob / 100, 0), money: true, accent: true },
        { label: 'Avg won deal', value: wonIn.length ? sum(wonIn) / wonIn.length : 0, money: true },
        { label: 'Emails sent', value: emailsOut.length },
        { label: 'Open rate', value: emailsOut.length ? Math.round(opened.length / emailsOut.length * 100) + '%' : '—' },
        { label: 'Replies', value: replies.length },
        { label: 'Meetings', value: meetingsHeld },
        { label: 'Awaiting signature', value: D.envelopes.filter(e => !['completed', 'declined', 'voided'].includes(e.status)).length },
      ] };
    }
    case 'forecast_by_month': {
      const m = {}; open.forEach(x => { const k = x.d.expected_close ? String(x.d.expected_close).slice(0, 7) : 'none'; m[k] = (m[k] || 0) + Number(x.d.value || 0) * x.prob / 100; });
      const entries = Object.entries(m).sort((a, b) => a[0] === 'none' ? 1 : b[0] === 'none' ? -1 : a[0].localeCompare(b[0]));
      return { bars: entries.map(([k, v]) => ({ label: k === 'none' ? 'No close date' : monthLabel(k), value: Math.round(v), money: true })), keepOrder: true };
    }
    case 'pipeline_by_stage': {
      const pipe = pipelineById(options.pipelineId); const names = (pipe?.stages || []).filter(s => !s.won).map(s => s.name);
      return { bars: names.map(n => ({ label: n, value: sum(open.filter(x => String(x.d.pipeline_id) === String(pipe.id) && x.d.stage === n)), money: true })), keepOrder: true, subtitle: pipe?.name };
    }
    case 'pipeline_by_owner': return { bars: bars(group(open, x => userName(x.d.owner_id), x => Number(x.d.value || 0)), true) };
    case 'won_by_owner': return { bars: bars(group(wonIn, x => userName(x.d.owner_id), x => Number(x.d.value || 0)), true) };
    case 'top_companies': return { bars: bars(group(wonIn.filter(x => x.d.company_id), x => (D.companies.find(c => c.id === x.d.company_id) || {}).name || '?', x => Number(x.d.value || 0)), true).slice(0, 8) };
    case 'deals_by_vertical': return { bars: bars(group(meta.filter(x => inRange(x.d.created_at)), x => x.d.vertical || 'Unassigned')) };
    case 'source_roi': {
      const srcs = [...new Set([...D.contacts.map(c => c.source), ...D.deals.map(d => d.source)].filter(Boolean))];
      const rows = srcs.map(s => { const cs = D.contacts.filter(c => c.source === s && inRange(c.created_at)); const ds = meta.filter(x => x.d.source === s); const w = ds.filter(x => x.won && inRange(x.d.won_at || x.d.created_at)); return { source: s, contacts: cs.length, deals: ds.filter(x => inRange(x.d.created_at)).length, won: w.length, revenue: sum(w), openValue: sum(ds.filter(x => x.open)) }; }).filter(r => r.contacts || r.deals || r.won).sort((a, b) => b.revenue - a.revenue || b.deals - a.deals);
      return { table: { columns: ['Source', 'Contacts', 'Deals', 'Won', 'Revenue', 'Open'], rows: rows.map(r => [r.source, r.contacts, r.deals, r.won, money0(r.revenue), money0(r.openValue)]) } };
    }
    case 'activity_leaderboard': {
      const acts = D.activities.filter(a => a.user_id && inRange(a.created_at));
      const types = ['Call', 'Email', 'Meeting', 'Note', 'Proposal'];
      const byUser = D.users.filter(u => u.active).map(u => { const mine = acts.filter(a => a.user_id === u.id); return [u.name, ...types.map(t => mine.filter(a => a.type === t).length), mine.length]; }).sort((a, b) => b[b.length - 1] - a[a.length - 1]);
      return { table: { columns: ['Rep', ...types, 'Total'], rows: byUser } };
    }
    case 'email_performance': {
      const rows = D.users.filter(u => u.active).map(u => { const out = D.emails.filter(e => e.direction === 'out' && e.user_id === u.id && inRange(e.sent_at)); const opened = out.filter(e => e.open_count > 0).length; const replies = D.emails.filter(e => e.direction === 'in' && inRange(e.sent_at) && out.some(o => o.contact_id === e.contact_id)).length; return [u.name, out.length, out.length ? Math.round(opened / out.length * 100) + '%' : '—', replies]; }).filter(r => r[1]).sort((a, b) => b[1] - a[1]);
      return { table: { columns: ['Sender', 'Sent', 'Open rate', 'Replies'], rows } };
    }
    case 'sequence_performance': {
      const rows = D.sequences.map(s => { const en = D.enrollments.filter(e => e.sequence_id === s.id && inRange(e.started_at)); const replied = en.filter(e => e.status === 'replied').length; return [s.name, en.length, en.filter(e => e.status === 'active').length, replied, en.length ? Math.round(replied / en.length * 100) + '%' : '—', en.filter(e => e.status === 'completed').length]; }).filter(r => r[1]);
      return { table: { columns: ['Sequence', 'Enrolled', 'Active', 'Replied', 'Reply rate', 'Completed'], rows } };
    }
    case 'funnel': {
      const pipe = pipelineById(options.pipelineId); const names = (pipe?.stages || []).map(s => s.name);
      const ds = meta.filter(x => String(x.d.pipeline_id) === String(pipe.id) && inRange(x.d.created_at));
      const reached = names.map(n => ds.filter(x => (x.d.stage_history || []).some(h => h.stage === n) || x.d.stage === n).length);
      return { funnel: names.map((n, i) => ({ label: n, value: reached[i], pct: i && reached[0] ? Math.round(reached[i] / reached[0] * 100) : null })), subtitle: `${pipe?.name} · deals created in range` };
    }
    case 'deals_over_time': {
      const days = Math.max(1, Math.round((end - start) / 864e5)); const weekly = days > 60; const buckets = [];
      for (let t = new Date(start); t <= end; t = new Date(t.getTime() + (weekly ? 7 : 1) * 864e5)) buckets.push(new Date(t));
      const idx = t => { const x = new Date(t); if (x < start || x > end) return -1; return Math.min(buckets.length - 1, Math.floor((x - start) / ((weekly ? 7 : 1) * 864e5))); };
      const created = new Array(buckets.length).fill(0), wonS = new Array(buckets.length).fill(0);
      meta.forEach(x => { const i = idx(x.d.created_at); if (i >= 0) created[i]++; }); won.forEach(x => { const i = idx(x.d.won_at || x.d.created_at); if (i >= 0) wonS[i]++; });
      return { series: { labels: buckets.map(b => b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })), lines: [{ name: 'New deals', values: created }, { name: 'Won', values: wonS, accent: true }] } };
    }
    case 'quotes': {
      const qs = D.quotes.filter(x => inRange(x.created_at));
      return { kpis: [{ label: 'Quotes created', value: qs.length }, { label: 'Quoted value', value: qs.reduce((a, x) => a + Number(x.total), 0), money: true }, { label: 'Sent', value: qs.filter(x => x.status !== 'draft').length }, { label: 'Accepted', value: qs.filter(x => x.status === 'accepted').length, accent: true }, { label: 'Accepted value', value: qs.filter(x => x.status === 'accepted').reduce((a, x) => a + Number(x.total), 0), money: true, accent: true }] };
    }
    case 'tasks_by_user': {
      const today = new Date().toISOString().slice(0, 10);
      const rows = D.users.filter(u => u.active).map(u => { const t = D.tasks.filter(x => x.assignee_id === u.id && !x.done); return [u.name, t.length, t.filter(x => x.due_at && String(x.due_at) < today).length]; }).filter(r => r[1]);
      return { table: { columns: ['Rep', 'Open tasks', 'Overdue'], rows } };
    }
    case 'forms': return { bars: bars(D.forms.map(f => [f.name, D.subs.filter(s => s.form_id === f.id && inRange(s.created_at)).length])) };
    case 'stale_deals': {
      const last = {}; D.activities.forEach(a => { if (a.deal_id) last[a.deal_id] = Math.max(last[a.deal_id] || 0, new Date(a.created_at).getTime()); });
      const cutoff = Date.now() - (Number(options.days) || 14) * 864e5;
      const rows = open.map(x => ({ x, t: Math.max(last[x.d.id] || 0, new Date(x.d.created_at).getTime()) })).filter(r => r.t < cutoff).sort((a, b) => a.t - b.t).slice(0, 12)
        .map(r => [r.x.d.name, r.x.d.stage, userName(r.x.d.owner_id), money0(r.x.d.value), Math.floor((Date.now() - r.t) / 864e5) + 'd']);
      return { table: { columns: ['Deal', 'Stage', 'Owner', 'Value', 'Idle'], rows, dealIds: open.map(x => x.d.id) } };
    }
    case 'quota_attainment': {
      const ym = ymLocal(new Date());
      const rows = D.users.filter(u => u.active).map(u => { const quota = Number((D.quotas.find(x => x.user_id === u.id && x.period === ym) || {}).amount || 0); const w = sum(won.filter(x => x.d.owner_id === u.id && ymLocal(x.d.won_at || x.d.created_at) === ym)); return [u.name, money0(quota), money0(w), quota ? Math.round(w / quota * 100) + '%' : '—']; }).filter(r => r[1] !== '$0' || r[2] !== '$0');
      return { table: { columns: ['Rep', 'Quota', 'Closed', 'Attainment'], rows }, subtitle: monthLabel(ym) };
    }
  }
  return {};
}

async function dashboardData(dash, rangeOverride) {
  const D = await loadAll();
  const range = rangeBounds(rangeOverride || dash.range);
  const widgets = (dash.widgets || []).map(w => ({ ...w, title: w.title || WIDGETS[w.type] || w.type, data: compute(w.type, D, range, w.options || {}) }));
  return { range: { ...range, key: rangeOverride || dash.range }, widgets };
}

/* ---------- forecast ---------- */
async function forecast(monthsAhead = 6) {
  const D = await loadAll();
  const meta = D.deals.map(d => ({ d, ...stageMeta(d), cat: category(d) }));
  const now = new Date(); const months = [];
  for (let i = -1; i < monthsAhead; i++) { const dt = new Date(now.getFullYear(), now.getMonth() + i, 1); months.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`); }
  const users = D.users.filter(u => u.active);
  const cell = (uid, ym) => {
    const mine = meta.filter(x => (uid == null || x.d.owner_id === uid));
    const closing = mine.filter(x => x.open && x.d.expected_close && String(x.d.expected_close).slice(0, 7) === ym && x.cat !== 'omit');
    const wonM = mine.filter(x => x.won && ymLocal(x.d.won_at || x.d.created_at) === ym);
    const v = arr => arr.reduce((a, x) => a + Number(x.d.value || 0), 0);
    const quota = uid == null ? D.quotas.filter(x => x.period === ym).reduce((a, x) => a + Number(x.amount), 0) : Number((D.quotas.find(x => x.user_id === uid && x.period === ym) || {}).amount || 0);
    const won = v(wonM), commit = v(closing.filter(x => x.cat === 'commit')), best = v(closing.filter(x => x.cat === 'best')), pipeline = v(closing.filter(x => x.cat === 'pipeline'));
    const weighted = closing.reduce((a, x) => a + Number(x.d.value || 0) * x.prob / 100, 0);
    return { quota, won, commit, best, pipeline, weighted: Math.round(weighted), forecast: won + commit, bestCase: won + commit + best, gap: Math.max(0, quota - (won + commit)), deals: closing.length };
  };
  const reps = users.map(u => ({ id: u.id, name: u.name, months: months.map(ym => cell(u.id, ym)) }));
  const team = { months: months.map(ym => cell(null, ym)) };
  const noClose = meta.filter(x => x.open && !x.d.expected_close).map(x => ({ id: x.d.id, name: x.d.name, stage: x.d.stage, value: Number(x.d.value || 0), ownerId: x.d.owner_id }));
  const dealsByMonth = {}; meta.filter(x => x.open && x.d.expected_close).forEach(x => { const ym = String(x.d.expected_close).slice(0, 7); (dealsByMonth[ym] = dealsByMonth[ym] || []).push({ id: x.d.id, name: x.d.name, stage: x.d.stage, value: Number(x.d.value || 0), prob: x.prob, cat: x.cat, ownerId: x.d.owner_id, expectedClose: x.d.expected_close }); });
  return { months: months.map(ym => ({ ym, label: monthLabel(ym) })), reps, team, noClose, dealsByMonth, quotas: D.quotas.map(x => ({ userId: x.user_id, period: x.period, amount: Number(x.amount) })) };
}

/* ---------- weekly email ---------- */
function digestHtml(name, data) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtV = k => k.money ? money0(k.value) : k.value;
  let html = `<h2 style="font-family:Helvetica,Arial,sans-serif;margin:0 0 4px">${esc(name)}</h2><p style="color:#636466;margin:0 0 16px">${esc(data.range.label)}</p>`;
  for (const w of data.widgets) {
    html += `<h3 style="font-family:Helvetica,Arial,sans-serif;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#636466;margin:18px 0 8px">${esc(w.title)}</h3>`;
    const d = w.data;
    if (d.kpis) html += `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${d.kpis.map(k => `<td style="padding:6px 18px 6px 0;border-top:3px solid ${k.accent ? '#EC008C' : '#000'}"><div style="font-size:20px;font-weight:bold">${esc(fmtV(k))}</div><div style="font-size:12px;color:#636466">${esc(k.label)}</div></td>`).join('')}</tr></table>`;
    else if (d.bars) { const max = Math.max(1, ...d.bars.map(b => b.value)); html += d.bars.length ? `<table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px">${d.bars.map(b => `<tr><td style="width:160px;font-size:13px;padding:2px 8px 2px 0">${esc(b.label)}</td><td><div style="height:10px;background:${b.money ? '#EC008C' : '#000'};width:${Math.round(b.value / max * 100)}%"></div></td><td style="width:80px;text-align:right;font-size:13px;color:#636466">${b.money ? money0(b.value) : b.value}</td></tr>`).join('')}</table>` : '<p style="color:#9C9DA1;font-size:13px">No data</p>'; }
    else if (d.table) html += d.table.rows.length ? `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr>${d.table.columns.map(c => `<th style="text-align:left;padding:4px 12px 4px 0;color:#636466;font-weight:normal;border-bottom:1px solid #E2E2E5">${esc(c)}</th>`).join('')}</tr>${d.table.rows.map(r => `<tr>${r.map(c => `<td style="padding:4px 12px 4px 0;border-bottom:1px solid #E2E2E5">${esc(c)}</td>`).join('')}</tr>`).join('')}</table>` : '<p style="color:#9C9DA1;font-size:13px">No data</p>';
    else if (d.funnel) html += `<table cellpadding="0" cellspacing="0" style="font-size:13px">${d.funnel.map(f => `<tr><td style="padding:2px 12px 2px 0">${esc(f.label)}</td><td style="padding:2px 12px 2px 0"><b>${f.value}</b></td><td style="color:#636466">${f.pct != null ? f.pct + '%' : ''}</td></tr>`).join('')}</table>`;
    else if (d.series) html += `<p style="font-size:13px">${d.series.lines.map(l => `${esc(l.name)}: <b>${l.values.reduce((a, b) => a + b, 0)}</b>`).join(' · ')}</p>`;
  }
  return html;
}

module.exports = { init, WIDGETS, dashboardData, forecast, digestHtml, rangeBounds, category };
