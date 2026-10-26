'use strict';
// Branded proposal / quote PDF in the 27 Squared look: magenta #EC008C, black, 75% grey #636466.
const PDFDocument = require('pdfkit');

const MAGENTA = '#EC008C', BLACK = '#000000', GREY = '#636466', LIGHT = '#F6F6F7', LINE = '#E2E2E5', TINT = '#FDE7F3';
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const unitPrice = n => { const v = Number(n || 0); return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 }); };
const qtyFmt = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const dateFmt = d => new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

function bug(doc, x, y, size) {
  const s = size / 2;
  const cells = [['2', BLACK], ['7', MAGENTA], ['S', MAGENTA], ['Q', BLACK]];
  cells.forEach(([ch, color], i) => {
    const cx = x + (i % 2) * s, cy = y + Math.floor(i / 2) * s;
    doc.rect(cx, cy, s, s).fill(color);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(s * 0.55).text(ch, cx, cy + s * 0.22, { width: s, align: 'center' });
  });
}

function header(doc, { number, date }) {
  bug(doc, 50, 40, 34);
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(13).text('27 SQUARED MARKETING', 92, 44, { characterSpacing: 0.5 });
  doc.fillColor(GREY).font('Helvetica').fontSize(8.5).text('Data Centric Consumer Engagement', 92, 61);
  doc.fillColor(GREY).font('Helvetica').fontSize(9).text(`${number}   ·   ${dateFmt(date)}`, 300, 48, { width: 262, align: 'right' });
  doc.moveTo(50, 90).lineTo(562, 90).lineWidth(2).strokeColor(MAGENTA).stroke();
}

function footer(doc, page, pages) {
  doc.fillColor(GREY).font('Helvetica').fontSize(8)
    .text('27 Squared Holdings d/b/a 27 Squared Marketing  ·  1000 NW 65th Street, Suite 305, Fort Lauderdale, FL 33309  ·  27SquaredMarketing.com', 50, 752, { width: 512, align: 'center', lineBreak: false });
  doc.text(`${page} / ${pages}`, 50, 764, { width: 512, align: 'center', lineBreak: false });
}

function sectionTitle(doc, text, y) {
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(12).text(text.toUpperCase(), 50, y, { characterSpacing: 0.8 });
  doc.moveTo(50, y + 17).lineTo(562, y + 17).lineWidth(0.5).strokeColor(LINE).stroke();
  return y + 28;
}

function itemsTable(doc, items, y, label) {
  if (!items.length) return y;
  doc.fillColor(MAGENTA).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), 50, y, { characterSpacing: 0.6 });
  y += 16;
  const cols = { name: 50, qty: 330, unit: 390, price: 440, amount: 500 };
  doc.fillColor(GREY).font('Helvetica').fontSize(8);
  doc.text('Item', cols.name, y); doc.text('Qty', cols.qty, y, { width: 55, align: 'right' }); doc.text('Unit', cols.unit, y, { width: 45 }); doc.text('Rate', cols.price, y, { width: 55, align: 'right' }); doc.text('Amount', cols.amount, y, { width: 62, align: 'right' });
  y += 12; doc.moveTo(50, y).lineTo(562, y).lineWidth(0.5).strokeColor(LINE).stroke(); y += 6;
  let subtotal = 0;
  for (const it of items) {
    if (y > 680) { doc.addPage(); y = 100; }
    const nameH = doc.font('Helvetica-Bold').fontSize(9.5).heightOfString(it.name, { width: 270 });
    const descH = it.description ? doc.font('Helvetica').fontSize(8).heightOfString(it.description, { width: 270 }) : 0;
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9.5).text(it.name, cols.name, y, { width: 270 });
    if (it.description) doc.fillColor(GREY).font('Helvetica').fontSize(8).text(it.description, cols.name, y + nameH + 1, { width: 270 });
    doc.fillColor(BLACK).font('Helvetica').fontSize(9.5);
    doc.text(it.billing === 'monthly' && it.months > 1 ? `${qtyFmt(it.qty)} × ${it.months}` : qtyFmt(it.qty), cols.qty, y, { width: 55, align: 'right' });
    doc.text(it.billing === 'monthly' && it.months > 1 ? 'mo' : it.unit, cols.unit, y, { width: 45 });
    doc.text(unitPrice(it.unit_price), cols.price, y, { width: 55, align: 'right' });
    doc.text(money(it.amount), cols.amount, y, { width: 62, align: 'right' });
    subtotal += Number(it.amount || 0);
    y += Math.max(nameH + descH + 8, 18);
  }
  doc.rect(50, y, 512, 18).fill(TINT);
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9.5).text(`${label} subtotal`, 58, y + 5).text(money(subtotal), cols.amount, y + 5, { width: 62, align: 'right' });
  return y + 28;
}

function build(quote, ctx) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 100, bottom: 8, left: 50, right: 50 }, bufferPages: true, info: { Title: `${quote.number} — ${quote.title}`, Author: '27 Squared Marketing' } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);

    const items = quote.items || [];
    const oneTime = items.filter(i => i.billing !== 'monthly'), monthly = items.filter(i => i.billing === 'monthly');
    const months = monthly.reduce((m, i) => Math.max(m, Number(i.months || 1)), 1);

    // Cover block
    let y = 110;
    doc.fillColor(GREY).font('Helvetica').fontSize(10).text('PROPOSAL', 50, y, { characterSpacing: 1.5 });
    y += 18;
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(24).text(quote.title, 50, y, { width: 512 });
    y += doc.heightOfString(quote.title, { width: 512 }) + 14;
    doc.fillColor(BLACK).font('Helvetica').fontSize(10.5);
    const kv = [['Prepared for', [ctx.contactName, ctx.contactTitle].filter(Boolean).join(', ') + (ctx.companyName ? `\n${ctx.companyName}` : '')], ['Prepared by', `${ctx.userName || '27 Squared Marketing'}\n${ctx.userEmail || ''}`], ['Valid until', quote.valid_until ? dateFmt(quote.valid_until + 'T12:00:00') : '30 days from issue']];
    const colW = 170;
    kv.forEach(([k, v], i) => {
      doc.fillColor(GREY).font('Helvetica').fontSize(8).text(k.toUpperCase(), 50 + i * colW, y, { characterSpacing: 0.6 });
      doc.fillColor(BLACK).font('Helvetica').fontSize(10).text(v.trim(), 50 + i * colW, y + 12, { width: colW - 12 });
    });
    y += 54;

    if (quote.intro) {
      y = sectionTitle(doc, 'Overview', y);
      doc.fillColor(BLACK).font('Helvetica').fontSize(10.5).text(quote.intro, 50, y, { width: 512, lineGap: 2.5 });
      y += doc.heightOfString(quote.intro, { width: 512, lineGap: 2.5 }) + 20;
    }

    y = sectionTitle(doc, 'Investment', y);
    y = itemsTable(doc, oneTime, y, 'One-time');
    y = itemsTable(doc, monthly, y, 'Monthly');
    if (y > 640) { doc.addPage(); y = 100; }
    // Totals
    const totalsX = 330;
    const lines = [];
    if (oneTime.length) lines.push(['One-time', money(quote.one_time)]);
    if (monthly.length) lines.push([`Monthly${months > 1 ? ` (×${months} months)` : ''}`, money(quote.monthly)]);
    lines.forEach(([k, v]) => {
      doc.fillColor(BLACK).font('Helvetica').fontSize(10).text(k, totalsX, y, { width: 150 }).text(v, 500, y, { width: 62, align: 'right' });
      y += 16;
    });
    doc.rect(totalsX, y, 232, 26).fill(MAGENTA);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(11).text('Total program', totalsX + 8, y + 8).text(money(quote.total), 470, y + 8, { width: 84, align: 'right' });
    y += 42;

    if (quote.terms) {
      const th = doc.font('Helvetica').fontSize(9.5).heightOfString(quote.terms, { width: 512, lineGap: 2 });
      if (y + 28 + th > 700) { doc.addPage(); y = 100; }
      y = sectionTitle(doc, 'Terms', y);
      doc.fillColor(BLACK).font('Helvetica').fontSize(9.5).text(quote.terms, 50, y, { width: 512, lineGap: 2 });
      y += doc.heightOfString(quote.terms, { width: 512, lineGap: 2 }) + 20;
    }

    if (y + 150 > 740) { doc.addPage(); y = 100; }
    y = sectionTitle(doc, 'Acceptance', y);
    doc.fillColor(GREY).font('Helvetica').fontSize(9).text('Signing below accepts this proposal and the pricing above. A Master Services Agreement and ordering SOW will follow for signature.', 50, y, { width: 512 });
    y += 36;
    [['Client', ctx.companyName || ''], ['27 Squared Marketing', '']].forEach(([who, name], i) => {
      const x = 50 + i * 266;
      doc.moveTo(x, y + 30).lineTo(x + 230, y + 30).lineWidth(0.7).strokeColor(BLACK).stroke();
      doc.fillColor(GREY).font('Helvetica').fontSize(8).text(`${who.toUpperCase()}  —  SIGNATURE`, x, y + 34, { characterSpacing: 0.5 });
      doc.moveTo(x, y + 70).lineTo(x + 230, y + 70).lineWidth(0.7).strokeColor(BLACK).stroke();
      doc.text('NAME / TITLE / DATE', x, y + 74, { characterSpacing: 0.5 });
      if (name) doc.fillColor(BLACK).font('Helvetica').fontSize(9).text(name, x, y + 10);
    });

    // headers & footers on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      header(doc, { number: quote.number, date: quote.created_at || new Date() });
      footer(doc, i + 1, range.count);
    }
    doc.end();
  });
}

module.exports = { build };
