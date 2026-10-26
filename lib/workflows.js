'use strict';
// If/then automation. Events are fired from the API at mutation points; `no_activity` runs on an hourly scan.
const mailer = require('./mail');
const engage = require('./engage');

let q, APP_URL, hooks = {};
function init({ query, appUrl, notifyUser, logActivity, pipelineById }) { q = query; APP_URL = appUrl; hooks = { notifyUser, logActivity, pipelineById }; }

const TRIGGERS = ['deal_created', 'deal_stage', 'deal_won', 'deal_lost', 'contact_created', 'form_submitted', 'no_activity'];
const ACTIONS = ['create_task', 'notify_owner', 'email_contact', 'enroll_sequence', 'set_owner', 'set_stage', 'add_note'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function matches(wf, event, ctx) {
  if (wf.trigger !== event) return false;
  const c = wf.conditions || {}, d = ctx.deal, k = ctx.contact;
  if (c.pipelineId && d && String(d.pipeline_id) !== String(c.pipelineId)) return false;
  if (c.stage && d && d.stage !== c.stage) return false;
  if (c.fromStage && ctx.fromStage && ctx.fromStage !== c.fromStage) return false;
  if (c.vertical && ((d && d.vertical) || (k && k.vertical) || '') !== c.vertical) return false;
  if (c.source && ((d && d.source) || (k && k.source) || '') !== c.source) return false;
  if (c.ownerId && String((d && d.owner_id) || (k && k.owner_id) || '') !== String(c.ownerId)) return false;
  if (c.formId && ctx.form && String(ctx.form.id) !== String(c.formId)) return false;
  if (c.minValue && d && Number(d.value) < Number(c.minValue)) return false;
  return true;
}

async function run(event, ctx) {
  const { rows: wfs } = await q('SELECT * FROM workflows WHERE active AND trigger=$1', [event]);
  for (const wf of wfs) {
    if (!matches(wf, event, ctx)) continue;
    try { await execute(wf, ctx); } catch (e) { console.error(`Workflow "${wf.name}" failed:`, e.message); }
  }
}

async function execute(wf, ctx) {
  let deal = ctx.deal ? (await q('SELECT * FROM deals WHERE id=$1', [ctx.deal.id])).rows[0] : null;
  let contact = ctx.contact ? (await q('SELECT * FROM contacts WHERE id=$1', [ctx.contact.id])).rows[0] : (deal?.contact_id ? (await q('SELECT * FROM contacts WHERE id=$1', [deal.contact_id])).rows[0] : null);
  const ownerId = deal?.owner_id || contact?.owner_id || null;
  const owner = ownerId ? (await q('SELECT * FROM users WHERE id=$1', [ownerId])).rows[0] : null;
  const name = deal?.name || (contact ? `${contact.first_name} ${contact.last_name}`.trim() : '');
  const link = deal ? `${APP_URL}/#deal/${deal.id}` : contact ? `${APP_URL}/#contact/${contact.id}` : APP_URL;
  const done = [];
  for (const a of wf.actions || []) {
    try {
      switch (a.type) {
        case 'create_task': {
          const assignee = a.assignee === 'owner' || !a.assignee ? ownerId : Number(a.assignee);
          const due = a.dueDays != null && a.dueDays !== '' ? new Date(Date.now() + Number(a.dueDays) * 864e5).toISOString().slice(0, 10) : null;
          await q('INSERT INTO tasks (title,due_at,deal_id,contact_id,assignee_id) VALUES ($1,$2,$3,$4,$5)', [sub(a.title || 'Follow up', { name }), due, deal?.id || null, contact?.id || null, assignee || null]);
          done.push(`task "${sub(a.title || 'Follow up', { name })}"`); break;
        }
        case 'notify_owner': {
          if (owner) await mailer.send({ to: owner.email, subject: sub(a.subject || `Workflow: ${wf.name} — ${name}`, { name }), html: `<p>${esc(sub(a.message || `Workflow "${wf.name}" ran for ${name}.`, { name }))}</p><p><a href="${link}">Open in CRM</a></p>` }).catch(() => {});
          done.push('notified owner'); break;
        }
        case 'email_contact': {
          if (contact?.email && mailer.configured()) { await engage.sendTracked({ contact, deal, user: owner, to: contact.email, subject: a.subject || '', body: a.body || '' }); done.push(`emailed ${contact.email}`); }
          break;
        }
        case 'enroll_sequence': {
          const seq = a.sequenceId ? (await q('SELECT * FROM sequences WHERE id=$1 AND active', [a.sequenceId])).rows[0] : null;
          if (seq && contact) { const r = await engage.enroll({ sequence: seq, contactId: contact.id, dealId: deal?.id || null, userId: ownerId }); if (r.enrollment) { done.push(`enrolled in "${seq.name}"`); engage.runDueEnrollments().catch(() => {}); } }
          break;
        }
        case 'set_owner': {
          if (a.userId) {
            if (deal) await q('UPDATE deals SET owner_id=$2 WHERE id=$1', [deal.id, a.userId]);
            if (contact) await q('UPDATE contacts SET owner_id=$2 WHERE id=$1', [contact.id, a.userId]);
            const u = (await q('SELECT * FROM users WHERE id=$1', [a.userId])).rows[0];
            if (u) { await hooks.notifyUser(u.id, `Assigned to you: ${name}`, `<p>Workflow "${esc(wf.name)}" assigned you <b>${esc(name)}</b>.</p><p><a href="${link}">Open in CRM</a></p>`, null); done.push(`owner → ${u.name}`); }
          }
          break;
        }
        case 'set_stage': {
          if (deal && a.stage && a.stage !== deal.stage) {
            const pipe = hooks.pipelineById(deal.pipeline_id);
            const st = (pipe.stages || []).find(x => x.name === a.stage);
            if (st) {
              const hist = [...(deal.stage_history || []), { stage: a.stage, at: new Date().toISOString(), by: null, workflow: wf.id }];
              await q('UPDATE deals SET stage=$2, stage_history=$3, won_at=CASE WHEN $4 THEN now() ELSE won_at END, updated_at=now() WHERE id=$1', [deal.id, a.stage, JSON.stringify(hist), !!st.won]);
              await hooks.logActivity({ dealId: deal.id, contactId: deal.contact_id, text: `Moved to ${a.stage} (workflow: ${wf.name})` });
              done.push(`stage → ${a.stage}`);
            }
          }
          break;
        }
        case 'add_note': {
          await hooks.logActivity({ dealId: deal?.id || null, contactId: contact?.id || null, text: sub(a.text || '', { name }) });
          done.push('note added'); break;
        }
      }
    } catch (e) { console.error(`Workflow "${wf.name}" action ${a.type} failed:`, e.message); }
  }
  await q('INSERT INTO workflow_runs (workflow_id, deal_id, contact_id, summary) VALUES ($1,$2,$3,$4)', [wf.id, deal?.id || null, contact?.id || null, done.join('; ')]);
  await q('UPDATE workflows SET runs=runs+1, last_run_at=now() WHERE id=$1', [wf.id]);
}

const sub = (text, vars) => String(text || '').replace(/\{\{\s*name\s*\}\}/g, vars.name || '');

// Hourly: open deals with no activity for N days (per workflow), once per deal per N days.
async function scanNoActivity() {
  const { rows: wfs } = await q("SELECT * FROM workflows WHERE active AND trigger='no_activity'");
  for (const wf of wfs) {
    const days = Math.max(1, Number((wf.conditions || {}).days) || 14);
    const { rows: deals } = await q(`
      SELECT d.* FROM deals d
      WHERE d.lost=FALSE AND d.won_at IS NULL
        AND COALESCE((SELECT MAX(created_at) FROM activities a WHERE a.deal_id=d.id), d.created_at) < now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.workflow_id=$2 AND r.deal_id=d.id AND r.ran_at > now() - ($1 || ' days')::interval)
      LIMIT 100`, [String(days), wf.id]);
    for (const d of deals) {
      if (!matches(wf, 'no_activity', { deal: d })) continue;
      try { await execute(wf, { deal: d }); } catch (e) { console.error(`Workflow "${wf.name}" failed:`, e.message); }
    }
  }
}

module.exports = { init, run, scanNoActivity, TRIGGERS, ACTIONS };
