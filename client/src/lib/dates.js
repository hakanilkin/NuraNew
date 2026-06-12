// Shared date-filter defaults for the analytics pages.

export function subtractMonths(dateStr, months) {
  const d = new Date(dateStr)
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

export const TODAY = new Date().toISOString().slice(0, 10)

// Max available dates from the tenant database ({ maxCaseDate, maxBlockDate }).
// Cached for the page lifetime — a tenant switch does a full reload, which
// resets the cache. Resolves to {} on failure so callers fall back to TODAY.
let metaPromise = null
export function fetchDateMeta() {
  if (!metaPromise) {
    metaPromise = fetch('/api/meta/dates')
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}))
  }
  return metaPromise
}
