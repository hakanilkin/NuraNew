// routes/opentimePublic.js
//
// Public, unauthenticated response pages for the Open Time demo — the pages a
// practice or surgeon lands on when they click a link in the (simulated) email.
// Plain server-rendered HTML with form POSTs, so it works with no JS and is easy
// to show in a demo. Mounted BEFORE requireAuth in server.js.

const express = require('express');
const store   = require('../lib/openTimeStore');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(title, inner) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --blue:#2563eb; --green:#15803d; --amber:#b45309; --red:#b91c1c; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; background:#f3f4f6; color:var(--ink); }
  .wrap { max-width:560px; margin:6vh auto; padding:0 18px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:16px; box-shadow:0 4px 20px rgba(0,0,0,0.06); overflow:hidden; }
  .head { padding:20px 26px; background:linear-gradient(135deg,#1e3a8a,#2563eb); color:#fff; }
  .head h1 { margin:0; font-size:19px; }
  .head p { margin:6px 0 0; font-size:13px; opacity:.85; }
  .body { padding:24px 26px; }
  .meta { border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:22px; background:#fafbfe; }
  .row { display:flex; justify-content:space-between; font-size:14px; padding:4px 0; }
  .row .k { color:var(--muted); } .row .v { font-weight:600; }
  .q { font-size:15px; font-weight:600; margin:0 0 16px; }
  .btns { display:flex; flex-direction:column; gap:10px; }
  button { font:inherit; font-size:15px; font-weight:600; padding:13px 16px; border-radius:11px; border:1px solid var(--line); background:#fff; color:var(--ink); cursor:pointer; text-align:left; display:flex; align-items:center; gap:11px; }
  button:hover { border-color:#c7cdd6; }
  button .dot { width:11px; height:11px; border-radius:50%; flex:0 0 auto; }
  .b-yes .dot { background:var(--green); } .b-no .dot { background:var(--red); } .b-defer .dot { background:var(--amber); }
  .b-claim .dot { background:var(--green); } .b-pass .dot { background:var(--muted); }
  .note { font-size:12px; color:var(--muted); margin-top:20px; line-height:1.5; }
  .result { text-align:center; padding:14px 0 4px; }
  .result .badge { display:inline-block; padding:8px 18px; border-radius:999px; font-weight:700; font-size:15px; }
  .g { background:#dcfce7; color:var(--green); } .r { background:#fee2e2; color:var(--red); } .a { background:#fef3c7; color:var(--amber); }
  .demo { text-align:center; font-size:11px; color:#9ca3af; margin-top:14px; letter-spacing:.03em; }
</style></head><body><div class="wrap"><div class="card">${inner}</div>
<div class="demo">NURA · OR OPEN TIME (DEMO)</div></div></body></html>`;
}

function metaBlock(o) {
  const hrs = o.durationMins ? (o.durationMins / 60).toFixed(1) + ' hrs' : (o.blockTimeMins ? (o.blockTimeMins / 60).toFixed(1) + ' hrs' : '—');
  return `<div class="meta">
    <div class="row"><span class="k">Case block</span><span class="v">${esc(o.caseBlock)}</span></div>
    <div class="row"><span class="k">Site</span><span class="v">${esc(o.site)}</span></div>
    <div class="row"><span class="k">Date</span><span class="v">${esc(o.blockDate)}</span></div>
    <div class="row"><span class="k">Service</span><span class="v">${esc(o.service || '—')}</span></div>
    <div class="row"><span class="k">Block time</span><span class="v">${esc(hrs)}</span></div>
  </div>`;
}

module.exports = function openTimePublicRoutes() {
  const router = express.Router();

  /* ── Release request response ─────────────────────────────────────────── */

  router.get('/r/:token', (req, res) => {
    const found = store.lookupToken(req.params.token);
    if (!found || found.kind !== 'request') {
      return res.status(404).send(page('Link not found', `<div class="body"><p>This link is not valid.</p></div>`));
    }
    const reqObj = found.request;
    if (reqObj.status !== 'SENT') return res.send(confirmationPage(reqObj.response));

    res.send(page('OR block release', `
      <div class="head"><h1>Will you use this OR block?</h1><p>A response helps us reallocate unused time early.</p></div>
      <div class="body">
        ${metaBlock(reqObj)}
        <p class="q">Please let us know:</p>
        <form method="post" class="btns">
          <button class="b-yes"   name="response" value="RELEASE"><span class="dot"></span>Yes — release this block</button>
          <button class="b-no"    name="response" value="KEEP"><span class="dot"></span>No — we'll use it, keep it</button>
          <button class="b-defer" name="response" value="DEFER"><span class="dot"></span>Need more time — check back later</button>
        </form>
        <p class="note">You're receiving this because your block is forecast to be under-utilized. Releasing early lets another team book the time.</p>
      </div>`));
  });

  router.post('/r/:token', (req, res) => {
    const result = store.respondToRequest(req.params.token, (req.body || {}).response);
    if (!result) return res.status(400).send(page('Unable to record', `<div class="body"><p>Sorry, we couldn't record that response.</p></div>`));
    res.send(confirmationPage(result.request.response));
  });

  function confirmationPage(response) {
    const map = {
      RELEASE: { cls: 'g', txt: 'Block released', sub: 'Thank you. This time is now available for another team to book.' },
      KEEP:    { cls: 'r', txt: 'Block kept',     sub: 'Got it — your block stays as scheduled.' },
      DEFER:   { cls: 'a', txt: "We'll check back", sub: "No problem — we'll reach out again closer to the date." },
    };
    const m = map[response] || map.KEEP;
    return page('Response recorded', `
      <div class="head"><h1>Response recorded</h1></div>
      <div class="body"><div class="result"><span class="badge ${m.cls}">${esc(m.txt)}</span></div>
      <p class="note" style="text-align:center">${esc(m.sub)}</p></div>`);
  }

  /* ── Fill offer response ──────────────────────────────────────────────── */

  router.get('/o/:token', (req, res) => {
    const found = store.lookupToken(req.params.token);
    if (!found || found.kind !== 'offer') {
      return res.status(404).send(page('Link not found', `<div class="body"><p>This link is not valid.</p></div>`));
    }
    const { slot, offer } = found;
    if (slot.status === 'BOOKED' && offer.status !== 'CLAIMED') {
      return res.send(page('Time already booked', `<div class="head"><h1>This time was just booked</h1></div>
        <div class="body"><p class="note" style="text-align:center">Another team claimed this open time. Thanks for considering it.</p></div>`));
    }
    if (offer.status !== 'SENT') return res.send(offerConfirmation(offer.response));

    res.send(page('Open OR time available', `
      <div class="head"><h1>Open OR time is available</h1><p>Would you like to book this released block?</p></div>
      <div class="body">
        ${metaBlock(slot)}
        <p class="q">This time is offered to ${esc(offer.candidate)}:</p>
        <form method="post" class="btns">
          <button class="b-claim" name="response" value="CLAIM"><span class="dot"></span>Yes — book this time for us</button>
          <button class="b-pass"  name="response" value="PASS"><span class="dot"></span>No thanks — pass</button>
        </form>
        <p class="note">First to claim gets the time. We'll confirm the booking with your office.</p>
      </div>`));
  });

  router.post('/o/:token', (req, res) => {
    const result = store.respondToOffer(req.params.token, (req.body || {}).response);
    if (!result) return res.status(400).send(page('Unable to record', `<div class="body"><p>Sorry, we couldn't record that response.</p></div>`));
    res.send(offerConfirmation(result.offer.response));
  });

  function offerConfirmation(response) {
    const m = response === 'CLAIM'
      ? { cls: 'g', txt: 'Time booked', sub: "Great — we'll confirm the booking with your office." }
      : { cls: 'r', txt: 'Passed',      sub: 'Thanks for letting us know.' };
    return page('Response recorded', `
      <div class="head"><h1>Response recorded</h1></div>
      <div class="body"><div class="result"><span class="badge ${m.cls}">${esc(m.txt)}</span></div>
      <p class="note" style="text-align:center">${esc(m.sub)}</p></div>`);
  }

  return router;
};
