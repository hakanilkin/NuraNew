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

module.exports = { getTenantConfig, getFeatures, getParam, resolveColumn, resolveColumnSQL }
