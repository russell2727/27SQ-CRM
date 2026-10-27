'use strict';
// Push a closed-won deal to 27SQ Launchpad (onboarding + campaign checklists).
// Env: LAUNCHPAD_URL (e.g. https://27sq-launchpad.onrender.com), LAUNCHPAD_SECRET (same value as Launchpad's CRM_WEBHOOK_SECRET)
const crypto = require('crypto');

let q;
function init({ query }) { q = query; }
const configured = () => !!(process.env.LAUNCHPAD_URL && process.env.LAUNCHPAD_SECRET);
const base = () => (process.env.LAUNCHPAD_URL || '').replace(/\/$/, '');

// Product category / name → Launchpad channel keys
function channelsFor(items) {
  const keys = new Set();
  for (const it of items) {
    const s = `${it.category || ''} ${it.name || ''}`.toLowerCase();
    if (/direct mail|postage|mail piece/.test(s)) keys.add('direct_mail');
    else if (/hercules|esp|in-platform email|\bemail\b/.test(s)) keys.add('email');
    else if (/\bsms\b|text message/.test(s)) keys.add('sms');
    else if (/ctv|ott|connected tv/.test(s)) keys.add('ctv');
    else if (/tiktok/.test(s)) keys.add('tiktok');
    else if (/meta|facebook|instagram/.test(s)) keys.add('meta');
    else if (/paid social|social media|campaign management/.test(s)) { keys.add('meta'); keys.add('tiktok'); }
    else if (/append|hygiene|identity graph|\bdata\b/.test(s)) keys.add('hygiene');
    else if (/creative/.test(s)) keys.add('creative');
  }
  return [...keys];
}

// Monthly budget estimate: sum of monthly-billed lines (one month), ignoring pass-through $0 placeholders.
function monthlyBudget(items) {
  return items.filter(i => i.billing === 'monthly').reduce((a, i) => a + Number(i.qty || 1) * Number(i.unit_price || 0), 0) || null;
}

async function buildPayload(dealId, opts = {}) {
  const d = (await q('SELECT * FROM deals WHERE id=$1', [dealId])).rows[0];
  if (!d) throw new Error('Deal not found');
  const [company, contact, owner, items] = await Promise.all([
    d.company_id ? q('SELECT * FROM companies WHERE id=$1', [d.company_id]).then(r => r.rows[0]) : null,
    d.contact_id ? q('SELECT * FROM contacts WHERE id=$1', [d.contact_id]).then(r => r.rows[0]) : null,
    d.owner_id ? q('SELECT * FROM users WHERE id=$1', [d.owner_id]).then(r => r.rows[0]) : null,
    q('SELECT di.*, p.category FROM deal_items di LEFT JOIN products p ON p.id=di.product_id WHERE di.deal_id=$1 ORDER BY di.sort', [dealId]).then(r => r.rows),
  ]);
  const channels = opts.channels && opts.channels.length ? opts.channels : channelsFor(items);
  const recurring = {};
  for (const k of channels) if ((k === 'sms' || k === 'email') && (opts.recurring === undefined ? true : opts.recurring)) recurring[k] = 7;
  const start = d.won_at ? new Date(d.won_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  const launch = opts.target_launch || new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
  return {
    external_id: `crm_deal_${d.id}`,
    company: company?.name || d.name,
    vertical: d.vertical || company?.vertical || contact?.vertical || '',
    primary_contact: contact ? `${contact.first_name} ${contact.last_name}`.trim() : null,
    contact_email: contact?.email || null,
    contact_phone: contact?.phone || company?.phone || null,
    website: company?.domain ? `https://${company.domain}` : null,
    account_lead_email: owner?.email || null,
    monthly_budget: monthlyBudget(items),
    contract_start: start,
    target_launch: launch,
    goals: null,
    notes: [d.notes, items.length ? 'Line items: ' + items.map(i => `${i.name} × ${Number(i.qty)} @ $${Number(i.unit_price)}${i.billing === 'monthly' ? '/mo' : ''}`).join('; ') : '', `CRM deal #${d.id} · $${Number(d.value).toLocaleString()}`].filter(Boolean).join('\n'),
    channels, recurring,
  };
}

async function push(dealId, opts = {}) {
  if (!configured()) throw new Error('Launchpad isn\'t connected — set LAUNCHPAD_URL and LAUNCHPAD_SECRET.');
  const payload = await buildPayload(dealId, opts);
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', process.env.LAUNCHPAD_SECRET).update(body).digest('hex');
  const r = await fetch(`${base()}/api/webhooks/crm`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': `sha256=${sig}`, 'Authorization': `Bearer ${process.env.LAUNCHPAD_SECRET}` }, body });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 200) }; }
  if (!r.ok) throw new Error(json.error || `Launchpad returned ${r.status}`);
  await q(`UPDATE deals SET custom = custom || $2::jsonb, updated_at=now() WHERE id=$1`,
    [dealId, JSON.stringify({ launchpad_client_id: json.client_id, launchpad_url: json.url, launchpad_pushed_at: new Date().toISOString() })]);
  return { ...json, payload };
}

async function status() {
  if (!configured()) return { configured: false };
  try { const r = await fetch(`${base()}/api/health`, { signal: AbortSignal.timeout(5000) }); return { configured: true, reachable: r.ok, url: base() }; }
  catch (e) { return { configured: true, reachable: false, url: base(), error: e.message }; }
}

module.exports = { init, configured, push, buildPayload, channelsFor, status, CHANNELS: ['meta', 'direct_mail', 'email', 'sms', 'hygiene', 'tiktok', 'ctv', 'creative'] };
