// lib/staffingShape.js
//
// The arithmetic of OR staffing alignment: demand has a shape by hour and day,
// the staffing plan is a rectangle, and the gap leaks money in both directions
// at once — idle staffed hours where the rectangle exceeds demand, overtime
// exposure where demand runs past its edge.
//
// This module is shared, and that is a hard requirement of both
// StaffingAlignment.md §2 and ISSCMIntegrationView.md: the Staffing page's
// ledger and the ISSCM engine's Pillar 2 coverage numbers must be the same
// function. Two implementations of "how much overtime does this day carry"
// would eventually disagree, and the panel exists to be believed.
//
// Pure: no I/O, no DB handle, no tenant lookups. Callers supply the shape.

// A demand shape is [{ minuteOfDay, rooms }] at a fixed slot width. DS_RR gives
// this directly; a tenant without DS_RR can derive the same shape from case
// in/out times, which the seeder itself demonstrates is equivalent.

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

function hhmmToMinutes(v) {
  if (v == null) return 0;
  if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes();
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v));
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

/**
 * Idle staffed room-hours: the rectangle standing above the demand curve,
 * inside the staffed window only. Rooms staffed and not used.
 */
function idleRoomHours(shape, plan, slotMinutes) {
  const start = hhmmToMinutes(plan.shiftStart);
  const end = hhmmToMinutes(plan.shiftEnd);
  const rooms = num(plan.staffedRooms);
  const h = num(slotMinutes) / 60;
  let idle = 0;
  for (const s of shape) {
    const t = num(s.minuteOfDay);
    if (t < start || t >= end) continue;
    idle += Math.max(0, rooms - num(s.rooms)) * h;
  }
  return idle;
}

/**
 * Overtime exposure: rooms still running after the staffed shift ends. Every
 * running room past the edge is exposure, whether or not the day was busy.
 */
function overtimeRoomHours(shape, plan, slotMinutes) {
  const end = hhmmToMinutes(plan.shiftEnd);
  const h = num(slotMinutes) / 60;
  let ot = 0;
  for (const s of shape) {
    if (num(s.minuteOfDay) < end) continue;
    ot += num(s.rooms) * h;
  }
  return ot;
}

/** Demand-hours that fall inside the rectangle, over staffed room-hours. */
function alignmentPct(shape, plan, slotMinutes) {
  const start = hhmmToMinutes(plan.shiftStart);
  const end = hhmmToMinutes(plan.shiftEnd);
  const rooms = num(plan.staffedRooms);
  const h = num(slotMinutes) / 60;
  const staffed = rooms * ((end - start) / 60);
  if (staffed <= 0) return null;
  let inside = 0;
  for (const s of shape) {
    const t = num(s.minuteOfDay);
    if (t < start || t >= end) continue;
    inside += Math.min(num(s.rooms), rooms) * h;
  }
  return (inside / staffed) * 100;
}

/** Peak simultaneous rooms, and when it happens. */
function peak(shape) {
  let best = { rooms: 0, minuteOfDay: null };
  for (const s of shape) {
    if (num(s.rooms) > best.rooms) best = { rooms: num(s.rooms), minuteOfDay: num(s.minuteOfDay) };
  }
  return best;
}

/** Rooms running at a given clock time. */
function roomsAt(shape, minuteOfDay) {
  let last = 0;
  for (const s of shape) {
    if (num(s.minuteOfDay) <= minuteOfDay) last = num(s.rooms);
  }
  return last;
}

/**
 * Rooms a day's booked volume implies: total booked minutes including turnover
 * over the length of one staffed shift, rounded up. The same
 * V4_FORECAST_COMPILE aggregation the Release Radar uses.
 */
function impliedRooms(bookedMinutes, plan) {
  const shiftMinutes = hhmmToMinutes(plan.shiftEnd) - hhmmToMinutes(plan.shiftStart);
  if (shiftMinutes <= 0) return 0;
  return Math.ceil(num(bookedMinutes) / shiftMinutes);
}

const DEFAULT_FLEX = {
  flexDownRooms: 2,   // slack before flexing down is worth recommending
  flexUpRooms: 1,     // shortfall before flexing up is
  bufferRooms: 1,     // rooms kept in hand when flexing down
};

/**
 * Should a day flex? Down when the plan carries rooms the booked volume cannot
 * fill, up when the volume needs more rooms than are planned.
 */
function flexFlag(plannedRooms, implied, cfg = DEFAULT_FLEX) {
  const slack = num(plannedRooms) - num(implied);
  if (slack >= num(cfg.flexDownRooms ?? DEFAULT_FLEX.flexDownRooms)) return 'FLEX_DOWN';
  if (slack <= -num(cfg.flexUpRooms ?? DEFAULT_FLEX.flexUpRooms)) return 'FLEX_UP';
  return null;
}

/**
 * What a day's staffing looks like once a decision adds room-hours to it.
 * This is the function ISSCM Pillar 2 judges with, so the panel's coverage
 * delta and the ledger's overtime column cannot drift apart.
 *
 * A day already at its practical ceiling spills everything new past shift end —
 * no OR packs its staffed hours perfectly, so the ceiling, not the arithmetic
 * total, is what new work has to fit under.
 */
function coverageImpact({ staffedRooms, shiftHours, requiredRoomHours,
                          pastShiftRoomHours = 0, coverageRatio = 1,
                          concurrencyPeak = 0, staffedRoomsDelta = 0 },
                        addedRoomHours, packingCeiling) {
  const roomsAfter = num(staffedRooms) + num(staffedRoomsDelta);
  const staffedBefore = num(staffedRooms) * num(shiftHours);
  const staffedAfter = roomsAfter * num(shiftHours);
  const ceilingBefore = staffedBefore * num(packingCeiling);
  const ceilingAfter = staffedAfter * num(packingCeiling);

  const requiredBefore = num(requiredRoomHours);
  const requiredAfter = requiredBefore + num(addedRoomHours);

  const spillBefore = Math.max(0, requiredBefore - ceilingBefore);
  const spillAfter = Math.max(0, requiredAfter - ceilingAfter);
  const ratio = num(coverageRatio) || 1;

  return {
    staffedRooms: num(staffedRooms),
    staffedRoomsAfter: roomsAfter,
    requiredBefore, requiredAfter,
    ceilingBefore, ceilingAfter,
    addedSpill: spillAfter - spillBefore,
    overtimeBefore: (num(pastShiftRoomHours) + spillBefore) * ratio,
    overtimeAfter: (num(pastShiftRoomHours) + spillAfter) * ratio,
    idleBefore: Math.max(0, staffedBefore - requiredBefore),
    idleAfter: Math.max(0, staffedAfter - requiredAfter),
    concurrencyHeadroomBefore: num(staffedRooms) - num(concurrencyPeak),
    concurrencyHeadroomAfter: roomsAfter - num(concurrencyPeak),
  };
}

/** A day's whole ledger row, from its shape and its plan. */
function ledgerRow(shape, plan, slotMinutes) {
  const p = peak(shape);
  return {
    idleRoomHours: round1(idleRoomHours(shape, plan, slotMinutes)),
    overtimeRoomHours: round1(overtimeRoomHours(shape, plan, slotMinutes)),
    alignmentPct: round1(alignmentPct(shape, plan, slotMinutes)),
    peakRooms: round1(p.rooms),
    peakMinuteOfDay: p.minuteOfDay,
    roomsAtShiftEnd: round1(roomsAt(shape, hhmmToMinutes(plan.shiftEnd))),
  };
}

/**
 * How many rooms to staff for a day's implied demand. Never the implied number
 * exactly: staffing to the peak means every room is running at the peak, and
 * the first case that overruns has nowhere to go. One room stays in hand.
 */
function recommendedRooms(implied, plannedRooms, cfg = DEFAULT_FLEX) {
  const buffer = num(cfg.bufferRooms ?? DEFAULT_FLEX.bufferRooms);
  const target = num(implied) + buffer;
  return Math.max(1, Math.min(num(plannedRooms), target));
}

module.exports = {
  hhmmToMinutes, recommendedRooms, idleRoomHours, overtimeRoomHours, alignmentPct, peak, roomsAt,
  impliedRooms, flexFlag, coverageImpact, ledgerRow, DEFAULT_FLEX,
};
