#!/usr/bin/env node
//
// Seed the Open Time workflow store for the Bright Memorial demo tenant.
//
// The store (lib/openTimeStore.js) keys everything by TenantID, so the demo
// tenant gets its own bucket and nothing here touches NHS or OHS. Cleaning up
// the junk entries under other tenants is a separate workstream — this script
// only ever adds, and only under the tenant id you pass it.
//
// Usage:
//   node scripts/demo/seed_opentime_store.js --tenant-id 3
//   node scripts/demo/seed_opentime_store.js --tenant-id 3 --force
//
// The tenant id is the one the app assigned when you registered Bright Memorial
// Health on the Admin page. It is not knowable ahead of time, so it is required.

const fs   = require('fs');
const path = require('path');

const store = require(path.join(__dirname, '..', '..', 'lib', 'openTimeStore.js'));

const ROSTER = path.join(__dirname, 'roster.json');
const MARKER = '[demo-seed]';      // lets a re-run detect its own earlier work

const MAIN_SITE = 'Bright Memorial Hospital';
const ASC_SITE  = 'Bright Surgery Center';
const DOMAIN    = 'brightmemorial.demo';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function practiceEmail(service) {
  return `${service.toLowerCase().replace(/[^a-z]+/g, '-')}-scheduling@${DOMAIN}`;
}

// The next N occurrences of a weekday, as YYYY-MM-DD.
function nextWeekdays(weekday, n, skipDays = 7) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() + skipDays);
  while (out.length < n) {
    if (d.getDay() === weekday) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      d.setDate(d.getDate() + 7);
    } else {
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

function main() {
  const tenantId = arg('--tenant-id');
  const force    = process.argv.includes('--force');
  if (!tenantId) {
    console.error('  --tenant-id is required. Find it on the Admin page after registering');
    console.error('  "Bright Memorial Health", then re-run:');
    console.error('    node scripts/demo/seed_opentime_store.js --tenant-id <id>');
    process.exit(1);
  }

  if (!fs.existsSync(ROSTER)) {
    console.error(`  ${ROSTER} not found — run: python scripts/demo/roster.py --seed 42`);
    process.exit(1);
  }
  const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
  const cast   = roster.cast;

  const existing = store.listRequests(tenantId).filter(r => (r.reason || '').includes(MARKER));
  if (existing.length && !force) {
    console.log(`  Tenant ${tenantId} already has ${existing.length} seeded requests — nothing to do.`);
    console.log('  Pass --force to add another set (the store has no delete).');
    return;
  }

  // ST-1's block is the headline: the Thursday Ortho A instances the radar
  // flags. The rest are ordinary traffic so the queue does not look staged.
  const thursdays = nextWeekdays(4, 3, 10);      // 4 = Thursday
  const tuesdays  = nextWeekdays(2, 2, 10);
  const fridays   = nextWeekdays(5, 2, 10);

  const requests = [
    {
      blockDate: thursdays[0], site: MAIN_SITE, caseBlock: 'Ortho A', service: 'Orthopedics',
      riskScore: 87, blockTimeMins: 480,
      recipientName: cast.st1_light_block_owner,
      recipientEmail: practiceEmail('Orthopedics'),
      subject: `Ortho A — Thursday ${thursdays[0]}: release unused block time?`,
      body: 'Ortho A has run at 58% of its Thursday block over the last eight weeks, and '
          + `${thursdays[0]} is currently forecast to fill about 44%. If the practice does not `
          + 'expect to fill it, releasing now gives another service enough notice to book it.',
      respond: 'RELEASE', book: true,
    },
    {
      blockDate: thursdays[1], site: MAIN_SITE, caseBlock: 'Ortho A', service: 'Orthopedics',
      riskScore: 81, blockTimeMins: 480,
      recipientName: cast.st1_light_block_owner,
      recipientEmail: practiceEmail('Orthopedics'),
      subject: `Ortho A — Thursday ${thursdays[1]}: forecast fill 41%`,
      body: 'Same pattern the following week. Confirm whether the block is needed.',
      respond: null,                       // still outstanding — the queue has live work
    },
    {
      blockDate: tuesdays[0], site: MAIN_SITE, caseBlock: 'Uro/Gyn', service: 'Urology',
      riskScore: 64, blockTimeMins: 480,
      recipientName: 'Uro/Gyn scheduling',
      recipientEmail: practiceEmail('Urology'),
      subject: `Uro/Gyn — Tuesday ${tuesdays[0]}: partial release?`,
      body: 'Two cases booked against a full day. Releasing the afternoon would still leave '
          + 'the morning intact.',
      respond: 'KEEP',
    },
    {
      blockDate: fridays[0], site: MAIN_SITE, caseBlock: 'Colorectal', service: 'Colorectal',
      riskScore: 58, blockTimeMins: 480,
      recipientName: 'Colorectal scheduling',
      recipientEmail: practiceEmail('Colorectal'),
      subject: `Colorectal — Friday ${fridays[0]}: block is lightly booked`,
      body: 'Friday volume is light across the board. Let us know by Monday.',
      respond: 'DEFER',
    },
    {
      blockDate: thursdays[2], site: MAIN_SITE, caseBlock: 'Plastics', service: 'Plastics',
      riskScore: 52, blockTimeMins: 480,
      recipientName: 'Plastics scheduling',
      recipientEmail: practiceEmail('Plastics'),
      subject: `Plastics — Thursday ${thursdays[2]}: confirm block need`,
      body: 'Routine check ahead of the four-week deadline.',
      respond: null,
    },
    {
      blockDate: tuesdays[0], site: MAIN_SITE, caseBlock: 'General B', service: 'General Surgery',
      riskScore: 61, blockTimeMins: 360,
      recipientName: 'General Surgery scheduling',
      recipientEmail: practiceEmail('General Surgery'),
      subject: `General B — ${tuesdays[0]}: release the afternoon?`,
      body: 'The afternoon has been unused for three consecutive weeks.',
      respond: 'RELEASE', book: true,
    },
    {
      blockDate: fridays[0], site: ASC_SITE, caseBlock: 'ASC Plastics', service: 'Plastics',
      riskScore: 57, blockTimeMins: 420,
      recipientName: 'ASC Plastics scheduling',
      recipientEmail: practiceEmail('Plastics'),
      subject: `ASC Plastics — Friday ${fridays[0]}: light book`,
      body: 'Two short cases against a full surgery-centre day.',
      // Left unclaimed on purpose: the Board needs inventory on screen.
      respond: 'RELEASE', book: false,
    },
    {
      blockDate: thursdays[1], site: MAIN_SITE, caseBlock: 'ENT', service: 'ENT',
      riskScore: 49, blockTimeMins: 240,
      recipientName: 'ENT scheduling',
      recipientEmail: practiceEmail('ENT'),
      subject: `ENT — Thursday ${thursdays[1]}: partial release`,
      body: 'Morning only is booked.',
      respond: 'RELEASE', book: true,
    },
    {
      blockDate: tuesdays[1], site: MAIN_SITE, caseBlock: 'Uro/Gyn', service: 'Urology',
      riskScore: 44, blockTimeMins: 300,
      recipientName: 'Urology scheduling',
      recipientEmail: practiceEmail('Urology'),
      subject: `Uro/Gyn — Tuesday ${tuesdays[1]}: half the day open`,
      body: 'Three cases against a full list.',
      // Released and never offered: the Board's first list needs something in
      // it that has had nothing done to it yet.
      respond: 'RELEASE', offer: false, book: false,
    },
    {
      blockDate: fridays[1], site: MAIN_SITE, caseBlock: 'Colorectal', service: 'Colorectal',
      riskScore: 52, blockTimeMins: 360,
      recipientName: 'Colorectal scheduling',
      recipientEmail: practiceEmail('Colorectal'),
      subject: `Colorectal — Friday ${fridays[1]}: light book`,
      body: 'One case on the list a fortnight out.',
      // Offered and declined, so the Board shows a second attempt with the
      // history that stops a scheduler handing back the same dead end.
      respond: 'RELEASE', book: false, declineAll: true,
    },
  ];

  // Enough answered history that the funnel reads as a working capability
  // rather than a fresh install: most released time gets booked, some is still
  // on the Board as inventory to work.
  const releasedSlots = [];
  for (const r of requests) {
    const created = store.createRequest(tenantId, {
      ...r,
      reason: `${MARKER} radar flagged low forecast fill`,
      deadlineAt: new Date(Date.now() + 5 * 864e5).toISOString(),
    });
    if (r.respond) {
      const out = store.respondToRequest(created.token, r.respond);
      if (r.respond === 'RELEASE' && out.slot) {
        releasedSlots.push({ slot: out.slot, book: r.book,
                             offer: r.offer, declineAll: r.declineAll });
      }
    }
  }
  const released = releasedSlots[0]?.slot ?? null;

  // Every released slot is offered to ranked candidates. Spine leads because its
  // forward pipeline is the one that is surging.
  for (const { slot, offer } of releasedSlots) {
    if (offer === false) continue;
    store.createOffers(tenantId, slot.id, [
      { candidate: cast.st1_spine_surge, service: 'Spine', matchScore: 94,
        recipientEmail: practiceEmail('Spine') },
      { candidate: cast.st5_turnover_offender, service: 'Robotics-General', matchScore: 71,
        recipientEmail: practiceEmail('Robotics') },
      { candidate: 'General Surgery scheduling', service: 'General Surgery', matchScore: 63,
        recipientEmail: practiceEmail('General Surgery') },
    ]);
  }

  // Book most but not all, so the fill rate lands in a believable band and the
  // Board still has inventory on screen. "Released but still open" is the
  // scheduler's next hour of work, not a failure.
  for (const { slot, book } of releasedSlots) {
    if (!book) continue;
    const offer = store.getSlot(tenantId, slot.id)?.offers?.[0];
    if (offer) store.respondToOffer(offer.token, 'CLAIM');
  }

  // One slot where everybody said no. The store returns it to OPEN, so it lands
  // back on "needs an offer" carrying who already declined — which is the
  // difference between a useful queue and a list handing back a dead end.
  for (const { slot, declineAll } of releasedSlots) {
    if (!declineAll) continue;
    for (const o of store.getSlot(tenantId, slot.id)?.offers ?? []) {
      if (o.status === 'SENT') store.respondToOffer(o.token, 'PASS');
    }
  }

  // A few of the resulting EMR entries are already done; the rest are the
  // scheduler's queue.
  const pending = store.listTasks(tenantId, 'PENDING');
  for (const task of pending.slice(0, Math.max(0, pending.length - 4))) {
    store.completeTask(tenantId, task.id, { completedBy: 'j.alvarez@brightmemorial.demo' });
  }

  // Strategic goals drive the candidate ranking; Spine is the growth target.
  store.setGoals(tenantId, [
    { service: 'Spine', weight: 3 },
    { service: 'Robotics-General', weight: 2 },
    { service: 'Orthopedics', weight: 1 },
  ]);

  const reqs  = store.listRequests(tenantId);
  const slots = store.listSlots(tenantId);
  const sum   = store.summary(tenantId);
  const tasks = store.listTasks(tenantId, 'ALL');
  console.log(`  Tenant ${tenantId}: ${reqs.length} requests, ${slots.length} open-time slots`);
  console.log(`  Funnel: ${sum.hoursReleased}h released, ${sum.hoursBooked}h booked `
            + `(fill rate ${sum.fillRatePct}%), ${sum.hoursStillOpen}h still open`);
  console.log(`  Fulfillment: ${tasks.filter(t => t.status === 'PENDING').length} to enter, `
            + `${tasks.filter(t => t.status === 'DONE').length} done`);
  if (released) {
    console.log(`  Released slot ${released.caseBlock} ${released.blockDate} with `
              + `${store.getSlot(tenantId, released.id).offers.length} ranked offers`);
  }
  console.log('  Other tenants untouched.');
}

main();
