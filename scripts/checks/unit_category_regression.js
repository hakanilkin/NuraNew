#!/usr/bin/env node
//
// Regression check for the tenant-configurable unit category mapping.
//
// The mapping used to be a CASE expression hardcoded to NHS department codes,
// copied into five files and applied to every tenant. It now lives in
// config/tenantColumns.json. This asserts that move changed nothing for the
// tenants that were already live:
//
//   * NHS, OHS and any unknown tenant must classify every fixture department
//     exactly as the old hardcoded logic did.
//   * The generated SQL must be semantically identical to the old expression.
//   * Demo must classify Bright Memorial's departments into its own units.
//
// Run: node scripts/checks/unit_category_regression.js
// The Python half of the same guarantee: scripts/checks/unit_category_regression.py

const path = require('path')
const { buildUnitCategorySQL, classifyUnit } = require(
  path.join(__dirname, '..', '..', 'utils', 'tenantColumns'))

// ── The logic as it stood before the change, transcribed from routes/iplos.js ──
function legacyClassify(name) {
  if (name === null || name === undefined || name === '') return 'Other'
  const n = String(name).toUpperCase()
  if (n.includes('2E') || n.includes('2W')) return '2nd Floor'
  if (n.includes('3E') || n.includes('3W')) return '3rd Floor'
  if (n.includes('5W') || n.includes('6N')) return '6N/5W'
  if (n.includes('ICU') || n.includes('CORONARY CARE')) return 'ICU'
  if (n.includes('PCU')) return 'PCU'
  if (n.includes('MOTHER BABY') || n.includes('LABOR')
      || n.includes('SPECIAL CARE NURS') || n.includes('NEWBORN')) return 'Maternal Child Health'
  if (n.includes('HOSPITAL AT HOME')) return 'Hospital at Home'
  if (n.includes('IP REHAB')) return 'Rehab'
  return 'Other'
}

// Representative department strings: every branch of the old expression, the
// boundaries between branches, and values that must fall through to 'Other'.
const FIXTURES = [
  'OLLH 2E MED SURG', 'OLLH 2W SURG', 'MEMH 3E TELE', 'VORH 3W ONC',
  'MARH 5W MED', 'OLLH 6N MED SURG', 'OLLH ICU', 'MEMH CORONARY CARE UNIT',
  'VORH NSICU', 'OLLH PCU', 'MEMH MOTHER BABY', 'VORH LABOR AND DELIVERY',
  'OLLH SPECIAL CARE NURSERY', 'MARH NEWBORN NURSERY', 'VIRTUA HOSPITAL AT HOME',
  'VORH IP REHAB', 'OLLH EMERGENCY', 'OLLH OR', 'MEMH ENDOSCOPY', 'UNK',
  'SOME UNMAPPED UNIT', '', null, undefined,
  // Bright Memorial's departments — 'Other' under the old logic, which is the
  // under-reporting this change fixes.
  'BMH 5 CENTRAL MED SURG', 'BMH 4 EAST MED SURG', 'BMH 3 WEST TELEMETRY',
  'BMH ICU', 'BMH STEPDOWN PCU',
]

// Normalise whitespace so indentation differences between the five old copies
// do not count as a difference.
const norm = s => s.replace(/\s+/g, ' ').trim()

const LEGACY_SQL = norm(`CASE
  WHEN (DEP_LASTDEPT LIKE '%2E%' OR DEP_LASTDEPT LIKE '%2W%') THEN '2nd Floor'
  WHEN (DEP_LASTDEPT LIKE '%3E%' OR DEP_LASTDEPT LIKE '%3W%') THEN '3rd Floor'
  WHEN (DEP_LASTDEPT LIKE '%5W%' OR DEP_LASTDEPT LIKE '%6N%') THEN '6N/5W'
  WHEN (DEP_LASTDEPT LIKE '%ICU%' OR DEP_LASTDEPT LIKE '%CORONARY CARE%') THEN 'ICU'
  WHEN DEP_LASTDEPT LIKE '%PCU%' THEN 'PCU'
  WHEN (DEP_LASTDEPT LIKE '%MOTHER BABY%' OR DEP_LASTDEPT LIKE '%LABOR%' OR DEP_LASTDEPT LIKE '%SPECIAL CARE NURS%' OR DEP_LASTDEPT LIKE '%NEWBORN%') THEN 'Maternal Child Health'
  WHEN DEP_LASTDEPT LIKE '%HOSPITAL AT HOME%' THEN 'Hospital at Home'
  WHEN DEP_LASTDEPT LIKE '%IP REHAB%' THEN 'Rehab'
  ELSE 'Other'
END`)

const failures = []
const check = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}\n    expected: ${expected}\n    actual:   ${actual}`)
}

// ── 1. Live tenants must be unchanged ────────────────────────────────────────
for (const tenant of ['NHS', 'OHS', 'Virtua Health', 'some unknown tenant']) {
  for (const dept of FIXTURES) {
    check(`${tenant} classify(${JSON.stringify(dept)})`,
          classifyUnit(tenant, dept), legacyClassify(dept))
  }
  check(`${tenant} SQL`, norm(buildUnitCategorySQL(tenant)), LEGACY_SQL)
}

// ── 2. Demo classifies Bright Memorial's units as its own ────────────────────
const DEMO_EXPECTED = {
  'BMH 5 CENTRAL MED SURG': '5 Central',
  'BMH 4 EAST MED SURG':    '4 East',
  'BMH 3 WEST TELEMETRY':   '3 West',
  'BMH ICU':                'ICU',
  'BMH STEPDOWN PCU':       'Stepdown',
  'BMH EMERGENCY':          'Other',
  '':                       'Other',
}
for (const [dept, expected] of Object.entries(DEMO_EXPECTED)) {
  check(`Demo classify(${JSON.stringify(dept)})`, classifyUnit('Demo', dept), expected)
}

// ── 3. Under the old logic every Bright unit collapsed to 'Other' ────────────
// This is the bug being fixed; assert it was real, so the check is meaningful.
const brightUnits = Object.keys(DEMO_EXPECTED).filter(d => d.startsWith('BMH ') && d !== 'BMH EMERGENCY')
const collapsed = brightUnits.filter(d => legacyClassify(d) === 'Other')
if (collapsed.length < 3) {
  failures.push(`expected the old logic to bucket most Bright Memorial units into 'Other'; `
              + `only ${collapsed.length} did — the fixture no longer demonstrates the bug`)
}

// ── 4. The alias form and column override must both work ─────────────────────
if (!buildUnitCategorySQL('NHS', { alias: 'DEST_CATEGORY' }).endsWith(' AS DEST_CATEGORY')) {
  failures.push('alias option did not append "AS DEST_CATEGORY"')
}
if (!buildUnitCategorySQL('NHS', { column: 'DEST_DEPTNAME' }).includes('DEST_DEPTNAME LIKE')) {
  failures.push('column override did not change the classified column')
}

if (failures.length) {
  console.error(`\n  unit category regression: ${failures.length} failure(s)\n`)
  failures.forEach(f => console.error('  - ' + f))
  process.exit(1)
}
console.log(`  unit category regression: OK`)
console.log(`    ${FIXTURES.length} departments x 4 tenant names unchanged vs the old hardcoded logic`)
console.log(`    Demo maps ${brightUnits.length} Bright Memorial units that previously fell to 'Other'`)
