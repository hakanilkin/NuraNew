// lib/tenantData.js
//
// Resolving a tenant's model-data directory and reading JSON out of it. Shared
// by routes/atlas.js (which serves the files) and routes/briefs.js (which
// merges one of them with live forward volume), so there is exactly one place
// that turns a tenant name into a path.

const path = require('path');
const fs   = require('fs');

const { getParam } = require('../utils/tenantColumns');

// Root of all tenant data directories
const DATA_DIR = path.join(__dirname, '..', 'public', 'data');

// Resolve a per-tenant data directory, sanitizing the tenant name to prevent
// path traversal. Only lowercase alphanumeric chars are kept.
//
// A tenant whose display name does not match its pipeline output directory can
// set a `data_dir` param in config/tenantColumns.json — Bright Memorial Health
// writes to public/data/demo, not public/data/brightmemorialhealth. The param
// is sanitized the same way, so it cannot escape DATA_DIR either. Tenants
// without one resolve exactly as before.
function tenantDataDir(tenantName) {
  const sanitize = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const configured = sanitize(getParam(tenantName, 'data_dir'));
  const safe = configured || sanitize(tenantName || 'nhs') || 'nhs';
  return path.join(DATA_DIR, safe);
}

// Read a JSON file at an absolute filePath. Throws an Error with message
// 'not_found' when the file is missing, so callers can tell that apart from a
// parse or permission failure.
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      const e = new Error('not_found');
      e.filePath = filePath;
      throw e;
    }
    throw err;
  }
  return JSON.parse(raw);
}

module.exports = { DATA_DIR, tenantDataDir, readJsonFile };
