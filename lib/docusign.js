'use strict';
// DocuSign eSignature via JWT grant (server-to-server, no browser login after one-time consent).
// Env:
//   DS_INTEGRATION_KEY  integration key (client id) from DocuSign Apps & Keys
//   DS_USER_ID          API username (GUID) of the DocuSign user to impersonate
//   DS_ACCOUNT_ID       API account id (GUID)
//   DS_PRIVATE_KEY      RSA private key PEM (newlines as \n are fine) — or DS_PRIVATE_KEY_B64 (base64 of the PEM)
//   DS_ENV              "production" (default) or "demo" (developer sandbox)
//   DS_BASE_PATH        optional override, e.g. https://na3.docusign.net/restapi (auto-discovered via /oauth/userinfo otherwise)
//   DS_WEBHOOK_SECRET   HMAC key configured on the DocuSign Connect configuration (optional but recommended)
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DEMO = (process.env.DS_ENV || 'production').toLowerCase() === 'demo';
const OAUTH_HOST = DEMO ? 'account-d.docusign.com' : 'account.docusign.com';
const SCOPES = 'signature impersonation';

function privateKey() {
  if (process.env.DS_PRIVATE_KEY_B64) return Buffer.from(process.env.DS_PRIVATE_KEY_B64, 'base64').toString('utf8');
  return (process.env.DS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}
function configured() {
  return !!(process.env.DS_INTEGRATION_KEY && process.env.DS_USER_ID && process.env.DS_ACCOUNT_ID && privateKey());
}
function consentUrl(redirect) {
  return `https://${OAUTH_HOST}/oauth/auth?response_type=code&scope=${encodeURIComponent(SCOPES)}&client_id=${encodeURIComponent(process.env.DS_INTEGRATION_KEY || '')}&redirect_uri=${encodeURIComponent(redirect || 'https://www.docusign.com')}`;
}

const err = (message, status = 502) => Object.assign(new Error(message), { status, expose: true });

let cached = { token: null, exp: 0, basePath: process.env.DS_BASE_PATH || null };

async function accessToken() {
  if (!configured()) throw err('DocuSign is not configured. Add DS_INTEGRATION_KEY, DS_USER_ID, DS_ACCOUNT_ID and DS_PRIVATE_KEY.', 400);
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const assertion = jwt.sign(
    { iss: process.env.DS_INTEGRATION_KEY, sub: process.env.DS_USER_ID, aud: OAUTH_HOST, scope: SCOPES },
    privateKey(), { algorithm: 'RS256', expiresIn: '1h' });
  const r = await fetch(`https://${OAUTH_HOST}/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (body.error === 'consent_required') throw err(`DocuSign consent required. Open this URL once while signed in as the API user: ${consentUrl()}`, 400);
    throw err(`DocuSign auth failed: ${body.error_description || body.error || r.status}`, 502);
  }
  cached.token = body.access_token; cached.exp = Date.now() + (body.expires_in || 3600) * 1000;
  if (!cached.basePath) {
    const ui = await fetch(`https://${OAUTH_HOST}/oauth/userinfo`, { headers: { Authorization: `Bearer ${cached.token}` } }).then(x => x.json());
    const acct = (ui.accounts || []).find(a => a.account_id === process.env.DS_ACCOUNT_ID) || (ui.accounts || []).find(a => a.is_default) || (ui.accounts || [])[0];
    if (!acct) throw err('DocuSign user has no accounts', 502);
    cached.basePath = `${acct.base_uri}/restapi`;
  }
  return cached.token;
}

async function api(method, pathname, body) {
  const token = await accessToken();
  const r = await fetch(`${cached.basePath}/v2.1/accounts/${process.env.DS_ACCOUNT_ID}${pathname}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw err(`DocuSign ${method} ${pathname} failed: ${data.message || data.errorCode || r.status}`, 502);
  return data;
}

async function status() {
  const base = { configured: configured(), env: DEMO ? 'demo' : 'production', consentUrl: configured() ? consentUrl() : null, webhookSecretSet: !!process.env.DS_WEBHOOK_SECRET };
  if (!configured()) return { ...base, ok: false, error: 'Not configured' };
  try { await accessToken(); return { ...base, ok: true, basePath: cached.basePath }; }
  catch (e) { return { ...base, ok: false, error: e.message }; }
}

async function listTemplates() {
  const data = await api('GET', '/templates?count=100&order=asc&order_by=name');
  return (data.envelopeTemplates || []).map(t => ({ id: t.templateId, name: t.name, description: t.description || '', lastModified: t.lastModified }));
}

async function templateRoles(templateId) {
  const data = await api('GET', `/templates/${encodeURIComponent(templateId)}`);
  const signers = (data.recipients?.signers || []).map(s => ({ roleName: s.roleName, name: s.name || '', email: s.email || '', order: Number(s.routingOrder || 1), type: 'signer' }));
  const ccs = (data.recipients?.carbonCopies || []).map(s => ({ roleName: s.roleName, name: s.name || '', email: s.email || '', order: Number(s.routingOrder || 1), type: 'cc' }));
  return { name: data.name, emailSubject: data.emailSubject || '', roles: [...signers, ...ccs].sort((a, b) => a.order - b.order) };
}

async function sendFromTemplate({ templateId, emailSubject, roles }) {
  const data = await api('POST', '/envelopes', { templateId, emailSubject, status: 'sent', templateRoles: roles });
  return { envelopeId: data.envelopeId, status: data.status };
}

async function envelopeStatus(envelopeId) {
  const data = await api('GET', `/envelopes/${encodeURIComponent(envelopeId)}`);
  return { status: data.status, completedDateTime: data.completedDateTime, sentDateTime: data.sentDateTime };
}

async function voidEnvelope(envelopeId, reason) {
  return api('PUT', `/envelopes/${encodeURIComponent(envelopeId)}`, { status: 'voided', voidedReason: reason });
}

// DocuSign Connect: HMAC-SHA256 of the raw body, base64, in X-DocuSign-Signature-1..N headers.
function verifyWebhook(headers, rawBody) {
  const secret = process.env.DS_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured: accept (status is re-verified on refresh anyway)
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  for (let i = 1; i <= 5; i++) {
    const sig = headers[`x-docusign-signature-${i}`];
    if (sig && sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true;
  }
  return false;
}

module.exports = { configured, status, listTemplates, templateRoles, sendFromTemplate, envelopeStatus, voidEnvelope, verifyWebhook, consentUrl };
