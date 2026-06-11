// Shared parameterized SQL filter builders used by the analytics routes
// and the Ask Nura tool functions. Each accepts the values either as a
// comma-separated string (query params) or an array (tool inputs).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toList(param) {
  if (Array.isArray(param)) return param.map(s => String(s).trim()).filter(Boolean);
  if (typeof param === 'string') return param.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

module.exports = function makeFilters(sql) {
  function addInFilter(request, values, column, paramPrefix) {
    const list = toList(values);
    if (!list.length) return '';
    const placeholders = list.map((v, i) => {
      request.input(`${paramPrefix}${i}`, sql.NVarChar, v);
      return `@${paramPrefix}${i}`;
    });
    return ` AND ISNULL(${column}, 'Unknown') IN (${placeholders.join(', ')})`;
  }

  return {
    addSitesFilter:      (request, sites)  => addInFilter(request, sites,  'Loc_ORGrp2',    'site'),
    addLocationsFilter:  (request, locs)   => addInFilter(request, locs,   'LocationGroup', 'loc'),
    addCaseBlocksFilter: (request, blocks) => addInFilter(request, blocks, 'CaseBlock',     'cb'),

    addDowFilter(dowParam, column = 'BlockDate') {
      const days = toList(dowParam).map(d => parseInt(d)).filter(n => !isNaN(n));
      if (!days.length) return '';
      return ` AND DATEPART(WEEKDAY, ${column}) IN (${days.join(', ')})`;
    },

    // Returns the value if it's a valid YYYY-MM-DD string, otherwise the fallback
    dateOr(value, fallback) {
      return typeof value === 'string' && DATE_RE.test(value) ? value : fallback;
    },

    isValidDate(value) {
      return typeof value === 'string' && DATE_RE.test(value);
    },
  };
};
