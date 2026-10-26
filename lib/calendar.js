'use strict';
// Google Calendar sync via a service account with domain-wide delegation (read-only).
// Env: GOOGLE_SA_JSON_B64 — base64 of the service-account JSON key. Scope to delegate in Admin console:
//   https://www.googleapis.com/auth/calendar.readonly
// Each active user's primary calendar is scanned; events whose attendees match a contact email are logged.
const jwt = require('jsonwebtoken');

let q, hooks = {};
function init({ query, logActivity }) { q = query; hooks = { logActivity }; }

function creds() {
  if (!process.env.GOOGLE_SA_JSON_B64) return null;
  try { return JSON.parse(Buffer.from(process.env.GOOGLE_SA_JSON_B64, 'base64').toString('utf8')); } catch { return null; }
}
function configured() { const c = creds(); return !!(c && c.client_email && c.private_key); }

const tokens = new Map(); // user email -> {token, exp}
async function tokenFor(userEmail) {
  const cached = tokens.get(userEmail);
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const c = creds();
  const assertion = jwt.sign({ iss: c.client_email, sub: userEmail, scope: 'https://www.googleapis.com/auth/calendar.readonly', aud: 'https://oauth2.googleapis.com/token' }, c.private_key, { algorithm: 'RS256', expiresIn: '1h' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google auth for ${userEmail}: ${body.error_description || body.error || r.status}`);
  tokens.set(userEmail, { token: body.access_token, exp: Date.now() + (body.expires_in || 3600) * 1000 });
  return body.access_token;
}

async function listEvents(userEmail, daysBack = 2, daysAhead = 45) {
  const token = await tokenFor(userEmail);
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin: new Date(Date.now() - daysBack * 864e5).toISOString(), timeMax: new Date(Date.now() + daysAhead * 864e5).toISOString() });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Calendar list for ${userEmail}: ${body.error?.message || r.status}`);
  return body.items || [];
}

let busy = false, lastError = null, lastSync = null;
async function sync() {
  if (!configured() || busy) return;
  busy = true; const errors = [];
  try {
    const users = (await q('SELECT * FROM users WHERE active AND calendar_sync')).rows;
    const contacts = (await q("SELECT id, email, owner_id FROM contacts WHERE email<>''")).rows;
    const byEmail = new Map(contacts.map(c => [c.email.toLowerCase(), c]));
    const teamEmails = new Set(users.map(u => u.email.toLowerCase()));
    for (const u of users) {
      let events; try { events = await listEvents(u.email); } catch (e) { errors.push(e.message); console.error('Calendar sync:', e.message); continue; }
      for (const ev of events) {
        if (ev.status === 'cancelled' && !ev.id) continue;
        const attendees = (ev.attendees || []).map(a => (a.email || '').toLowerCase()).filter(e => e && !teamEmails.has(e));
        const matched = attendees.map(e => byEmail.get(e)).filter(Boolean);
        if (!matched.length) continue;
        const start = ev.start?.dateTime || (ev.start?.date ? ev.start.date + 'T09:00:00' : null); if (!start) continue;
        const end = ev.end?.dateTime || (ev.end?.date ? ev.end.date + 'T10:00:00' : null);
        const link = ev.hangoutLink || ev.htmlLink || '';
        for (const c of matched) {
          const eventKey = `${ev.id}:${c.id}`;
          const existing = (await q('SELECT * FROM meetings WHERE event_id=$1', [eventKey])).rows[0];
          const status = ev.status === 'cancelled' ? 'cancelled' : (end && new Date(end) < new Date() ? 'held' : 'scheduled');
          if (!existing) {
            const deal = (await q('SELECT id FROM deals WHERE contact_id=$1 AND lost=FALSE AND won_at IS NULL ORDER BY updated_at DESC LIMIT 1', [c.id])).rows[0];
            await q('INSERT INTO meetings (event_id,user_id,contact_id,deal_id,title,starts_at,ends_at,link,status,logged_held) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
              [eventKey, u.id, c.id, deal?.id || null, ev.summary || '(no title)', start, end, link, status, status === 'held']);
            if (status !== 'cancelled') await hooks.logActivity({ contactId: c.id, dealId: deal?.id || null, userId: u.id, type: 'Meeting', text: `${status === 'held' ? 'Meeting held' : 'Meeting scheduled'}: ${ev.summary || '(no title)'} — ${fmt(start)}` });
          } else {
            if (existing.status !== status || existing.title !== (ev.summary || '(no title)') || new Date(existing.starts_at).getTime() !== new Date(start).getTime()) {
              await q('UPDATE meetings SET status=$2, title=$3, starts_at=$4, ends_at=$5, link=$6 WHERE event_id=$1', [eventKey, status, ev.summary || '(no title)', start, end, link]);
              if (status === 'cancelled' && existing.status !== 'cancelled') await hooks.logActivity({ contactId: c.id, dealId: existing.deal_id, userId: u.id, type: 'Meeting', text: `Meeting cancelled: ${ev.summary || ''}` });
            }
            if (status === 'held' && !existing.logged_held) {
              await q('UPDATE meetings SET logged_held=TRUE WHERE event_id=$1', [eventKey]);
              await hooks.logActivity({ contactId: c.id, dealId: existing.deal_id, userId: u.id, type: 'Meeting', text: `Meeting held: ${ev.summary || '(no title)'}` });
            }
          }
        }
      }
    }
    lastError = errors.length ? errors.join('; ').slice(0, 500) : null; lastSync = new Date();
  } finally { busy = false; }
}
const fmt = iso => new Date(iso).toLocaleString('en-US', { timeZone: process.env.DIGEST_TZ || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';

function status() { return { configured: configured(), serviceAccount: creds()?.client_email || null, lastSync, lastError }; }

module.exports = { init, configured, sync, status };
