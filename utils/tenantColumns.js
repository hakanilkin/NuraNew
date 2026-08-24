// Safe to interpolate — values come from server-side config only, never user input
const columnMap = require('../config/tenantColumns.json')

// Build a case-insensitive lookup table so 'OHS Health System' matches 'OHS', etc.
// Keys in tenantColumns.json are treated as case-insensitive prefixes of the actual
// tenant name stored in the session (TenantName from the Tenants table).
const keysLower = Object.keys(columnMap)
  .filter(k => k !== 'default')
  .map(k => ({ key: k, lower: k.toLowerCase() }))

function normalizeTenantName(tenantName) {
  if (!tenantName) return 'default'
  const n = tenantName.trim().toLowerCase()
  // Exact match first
  const exact = keysLower.find(e => e.lower === n)
  if (exact) return exact.key
  // Prefix match (e.g. 'OHS Health System' matches key 'OHS')
  const prefix = keysLower.find(e => n.startsWith(e.lower))
  if (prefix) return prefix.key
  return 'default'
}

function getTenantConfig(tenantName) {
  const normalized = normalizeTenantName(tenantName)
  return columnMap[normalized] ?? columnMap['default']
}

function getFeatures(tenantName) {
  return getTenantConfig(tenantName).features ?? {}
}

// Return a tenant-specific param (e.g. hospital_filter).
// Returns null if not configured for this tenant.
// Safe to interpolate — values come from server-side config only, never user input
function getParam(tenantName, key) {
  return getTenantConfig(tenantName).params?.[key] ?? null
}

// Resolve a logical column name to the tenant's actual DB column name.
// Returns null if the column does not exist for this tenant.
// Returns logicalName unchanged if it is not in the mapping (passthrough).
function resolveColumn(tenantName, logicalName) {
  const cfg = getTenantConfig(tenantName)
  if (logicalName in cfg.columns) return cfg.columns[logicalName]
  return logicalName
}

// Build a safe SQL fragment: "ActualCol AS alias" or "NULL AS alias" when the
// column doesn't exist for this tenant.  alias is optional.
// Safe to interpolate — values come from server-side config only, never user input
function resolveColumnSQL(tenantName, logicalName, alias) {
  const actual = resolveColumn(tenantName, logicalName)
  if (actual === null) return alias ? `NULL AS ${alias}` : 'NULL'
  return alias ? `${actual} AS ${alias}` : actual
}

// ── Unit category mapping ──────────────────────────────────────────────────
//
// Several inpatient pages bucket a department into a unit category. That
// mapping used to be a CASE expression hardcoded to NHS department codes
// ('%2E%', '%ICU%', '%PCU%', …) and applied to every tenant, so any tenant
// whose departments are named differently saw almost everything fall into
// 'Other'. It is now per-tenant config: config/tenantColumns.json ->
// unit_category_map. A tenant without one inherits 'default', which still
// holds the NHS patterns, so existing behaviour is unchanged.

const DEFAULT_FALLBACK = 'Other'

function getUnitCategoryMap(tenantName) {
  const cfg = getTenantConfig(tenantName)
  const map = cfg.unit_category_map ?? columnMap['default']?.unit_category_map
  return map ?? { column: 'DEP_LASTDEPT', fallback: DEFAULT_FALLBACK, rules: [] }
}

// Config-only values, never user input — but escape quotes anyway so a stray
// apostrophe in a department pattern can never break or extend the statement.
const sqlLiteral = v => `'${String(v).replace(/'/g, "''")}'`

// Build the CASE expression that resolves a department column to its unit
// category. `column` overrides the configured source column (bed placement
// classifies DEST_DEPTNAME rather than DEP_LASTDEPT).
// Safe to interpolate — every value comes from server-side config.
function buildUnitCategorySQL(tenantName, { column, alias, indent = '    ' } = {}) {
  const map = getUnitCategoryMap(tenantName)
  const col = column || map.column || 'DEP_LASTDEPT'
  const fallback = map.fallback ?? DEFAULT_FALLBACK

  const whens = (map.rules ?? []).map(rule => {
    const tests = (rule.contains ?? []).map(p => `${col} LIKE ${sqlLiteral(`%${p}%`)}`)
    if (!tests.length) return null
    const cond = tests.length > 1 ? `(${tests.join(' OR ')})` : tests[0]
    return `${indent}  WHEN ${cond} THEN ${sqlLiteral(rule.category)}`
  }).filter(Boolean)

  const body = whens.length ? whens.join('\n') + '\n' : ''
  const expr = `CASE\n${body}${indent}  ELSE ${sqlLiteral(fallback)}\n${indent}END`
  return alias ? `${expr} AS ${alias}` : expr
}

// The same mapping in JavaScript, for classifying values already in hand.
// Kept next to the SQL builder so the two cannot drift apart.
function classifyUnit(tenantName, deptName) {
  const map = getUnitCategoryMap(tenantName)
  const fallback = map.fallback ?? DEFAULT_FALLBACK
  if (deptName === null || deptName === undefined || deptName === '') return fallback
  const n = String(deptName).toUpperCase()
  for (const rule of map.rules ?? []) {
    if ((rule.contains ?? []).some(pat => n.includes(String(pat).toUpperCase()))) {
      return rule.category
    }
  }
  return fallback
}

module.exports = {
  getTenantConfig, getFeatures, getParam, resolveColumn, resolveColumnSQL,
  getUnitCategoryMap, buildUnitCategorySQL, classifyUnit,
}
