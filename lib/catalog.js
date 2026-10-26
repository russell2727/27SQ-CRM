'use strict';
// 27 Squared Marketing rate card. Seeded once into `products` when the table is empty; edit in Settings afterward.
const SEED = [
  { name: 'Premium Phone & Email Append', category: 'Data', unit: 'record', billing: 'one-time', price: 0.03, description: 'Phone and email append; ~65% average append rate' },
  { name: 'Data Hygiene', category: 'Data', unit: 'record', billing: 'one-time', price: 0.0052, description: 'Validation, dedupe, suppression' },
  { name: 'One Connect Platform', category: 'Platform', unit: 'month', billing: 'monthly', price: 2499, description: 'SmartPiXL visitor identification, 60,000+ contacts/mo, unlimited segments, AI agent' },
  { name: 'In-Platform Email', category: 'Platform', unit: '1,000', billing: 'one-time', price: 2.50, description: 'Email deployment from One Connect, per 1,000 sends' },
  { name: 'Hercules ESP', category: 'Email', unit: 'email', billing: 'one-time', price: 0.05, tiers: [{ min: 0, price: 0.05 }, { min: 100000, price: 0.04 }, { min: 500000, price: 0.03 }, { min: 1000000, price: 0.02 }], description: 'Email deployment engine; volume-tiered' },
  { name: 'SMS (consented records)', category: 'SMS', unit: 'message', billing: 'one-time', price: 0.05, tiers: [{ min: 0, price: 0.05 }, { min: 500000, price: 0.04 }, { min: 3000000, price: 0.03 }], description: '162-character max; volume-tiered' },
  { name: 'Direct Mail — 8.5x14 with #10 envelope', category: 'Direct Mail', unit: 'piece', billing: 'one-time', price: 0.59, tiers: [{ min: 0, price: 0.59 }, { min: 250000, price: 0.57 }, { min: 500000, price: 0.56 }, { min: 1000000, price: 0.552 }, { min: 2000000, price: 0.537 }], description: 'Print, custom 1-color #10, 5-day turn, managed in-home dates, 15 programmatic touches; postage separate' },
  { name: 'Postage (estimated)', category: 'Direct Mail', unit: 'piece', billing: 'one-time', price: 0.405, description: 'Before postage discounts' },
  { name: 'Paid Social Media (pass-through)', category: 'Paid Social', unit: 'month', billing: 'monthly', price: 0, description: 'Meta / TikTok media spend, billed at cost' },
  { name: 'Paid Social Management', category: 'Paid Social', unit: 'month', billing: 'monthly', price: 0, description: '20% of media; enter the monthly fee' },
  { name: 'CTV / OTT Media (pass-through)', category: 'CTV', unit: 'month', billing: 'monthly', price: 100000, description: 'Full-episode non-skippable CTV via Amazon Ad Network, 15x/mo frequency' },
  { name: 'CTV Management', category: 'CTV', unit: 'month', billing: 'monthly', price: 12000, description: 'Campaign management for CTV' },
  { name: 'Campaign Management', category: 'Services', unit: 'month', billing: 'monthly', price: 12000, description: 'Meta / TikTok campaign management' },
  { name: 'Technology & Tracking', category: 'Services', unit: 'month', billing: 'monthly', price: 2995, description: 'SmartPiXL + One Connect, GA/GTM, AI agent, up to 10,000 emails/day to identified visitors' },
  { name: 'Onboarding & Creative Development', category: 'Services', unit: 'each', billing: 'one-time', price: 4995, description: '4 native creatives, 2 revisions each' },
  { name: 'Creative Development', category: 'Services', unit: 'each', billing: 'one-time', price: 5500, description: 'Flat creative development fee' },
  { name: 'Agency Fee', category: 'Services', unit: 'month', billing: 'monthly', price: 5000, description: 'Monthly agency retainer' },
];

async function seedIfEmpty(q) {
  const { rows } = await q('SELECT COUNT(*)::int AS n FROM products');
  if (rows[0].n > 0) return 0;
  let i = 0;
  for (const p of SEED) {
    await q('INSERT INTO products (name,category,description,unit,billing,price,tiers,sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [p.name, p.category, p.description || '', p.unit, p.billing, p.price, JSON.stringify(p.tiers || []), i++]);
  }
  return i;
}

// Resolve a unit price from tiers for a quantity; falls back to base price.
function priceFor(product, qty) {
  const tiers = (product.tiers || []).slice().sort((a, b) => Number(a.min) - Number(b.min));
  if (!tiers.length) return Number(product.price) || 0;
  let p = Number(tiers[0].price);
  for (const t of tiers) if (Number(qty) >= Number(t.min)) p = Number(t.price);
  return p;
}

module.exports = { SEED, seedIfEmpty, priceFor };
