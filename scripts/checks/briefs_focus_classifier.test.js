#!/usr/bin/env node
//
// Tests for the Briefs forward-layer focus classifier (BriefsForwardLayer.md §5:
// "all five outcomes + null-forward fallback").
//
// The classifier is the whole layer's judgement — it decides what a user is
// told to do first — so it is tested directly rather than through the route.
//
// Run: node --test scripts/checks/briefs_focus_classifier.test.js
//  or: npm run check:briefs-focus

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { classifyFocus, buildReason, FOCUS_ORDER } = require(
  path.join(__dirname, '..', '..', 'routes', 'briefs'));

const TARGET = 75;

test('over-allocated with a thin forward book is ACT', () => {
  assert.equal(classifyFocus('over_allocated', 41, TARGET), 'ACT');
  assert.equal(classifyFocus('misaligned', 52, TARGET), 'ACT');
});

test('over-allocated with a filling forward book is SELF_OK', () => {
  assert.equal(classifyFocus('over_allocated', 80, TARGET), 'SELF_OK');
  assert.equal(classifyFocus('misaligned', 75, TARGET), 'SELF_OK', 'exactly at target counts as met');
});

test('under-allocated and still booking is GROW', () => {
  assert.equal(classifyFocus('under_allocated', 92, TARGET), 'GROW');
  assert.equal(classifyFocus('under_allocated', 75, TARGET), 'GROW');
});

test('under-allocated but cooling forward is WATCH', () => {
  assert.equal(classifyFocus('under_allocated', 60, TARGET), 'WATCH');
});

test('the pipeline\'s own watch status stays WATCH regardless of forward fill', () => {
  assert.equal(classifyFocus('watch', 95, TARGET), 'WATCH');
  assert.equal(classifyFocus('watch', 10, TARGET), 'WATCH');
});

test('right-sized is OK', () => {
  assert.equal(classifyFocus('right_sized', 90, TARGET), 'OK');
  assert.equal(classifyFocus('right_sized', 20, TARGET), 'OK');
});

test('unknown forward fill never produces ACT or GROW', () => {
  // Null means "no forward block time", which is not the same as 0%. Calling a
  // block ACT on an absence of data would send someone to reclaim time from a
  // block nobody has measured.
  for (const nothing of [null, undefined]) {
    assert.equal(classifyFocus('over_allocated', nothing, TARGET), 'WATCH');
    assert.equal(classifyFocus('misaligned', nothing, TARGET), 'WATCH');
    assert.equal(classifyFocus('under_allocated', nothing, TARGET), 'WATCH');
    assert.equal(classifyFocus('right_sized', nothing, TARGET), 'OK');
  }
});

test('all five outcomes are reachable and ordered ACT first', () => {
  const produced = new Set([
    classifyFocus('over_allocated', 40, TARGET),
    classifyFocus('over_allocated', 90, TARGET),
    classifyFocus('under_allocated', 90, TARGET),
    classifyFocus('under_allocated', 40, TARGET),
    classifyFocus('right_sized', 90, TARGET),
  ]);
  assert.deepEqual([...produced].sort(), ['ACT', 'GROW', 'OK', 'SELF_OK', 'WATCH']);
  assert.equal(FOCUS_ORDER[0], 'ACT');
  assert.equal(FOCUS_ORDER[1], 'GROW');
});

test('an unrecognised status degrades to OK rather than throwing', () => {
  assert.equal(classifyFocus('something_new', 40, TARGET), 'OK');
});

test('the target is honoured, not hardcoded', () => {
  assert.equal(classifyFocus('over_allocated', 70, 65), 'SELF_OK');
  assert.equal(classifyFocus('over_allocated', 70, 80), 'ACT');
});

test('the reason quotes the numbers it classified with', () => {
  const r = buildReason('over_allocated', 52, 41, TARGET, 28);
  assert.match(r, /Over-allocated/);
  assert.match(r, /52% in-block/);
  assert.match(r, /41%/);
  assert.match(r, /75% target/);
  assert.match(r, /next 4 weeks/);
});

test('the reason says forward fill is unknown rather than implying zero', () => {
  const r = buildReason('over_allocated', 52, null, TARGET, 28);
  assert.match(r, /unknown/);
  assert.doesNotMatch(r, /0%/);
});

test('a missing in-block utilisation is described, not printed as a number', () => {
  const r = buildReason('watch', null, 80, TARGET, 28);
  assert.match(r, /no in-block utilisation recorded/);
});
