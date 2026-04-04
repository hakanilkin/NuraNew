// ── Constants ─────────────────────────────────────────────────────
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun',
                     'Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Helpers ──────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(num, den) {
  return den > 0 ? (num / den) * 100 : null;
}

function fmtPct(val) {
  return val != null ? val.toFixed(1) + '%' : '';
}

// DOW numbers (SQL Server DATEFIRST=7: 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri)
const WEEKDAYS  = [2, 3, 4, 5, 6];
const DOW_LABEL = { 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri' };

// ── Accumulate raw sums into a target object ──────────────────────
function accum(t, s) {
  t.CaseCount        = (t.CaseCount        || 0) + (s.CaseCount        || 0);
  t.SumPrimeTime     = (t.SumPrimeTime     || 0) + (s.SumPrimeTime     || 0);
  t.SumBlockTime     = (t.SumBlockTime     || 0) + (s.SumBlockTime     || 0);
  t.SumNonPrimeTime  = (t.SumNonPrimeTime  || 0) + (s.SumNonPrimeTime  || 0);
  t.SumTotalTime     = (t.SumTotalTime     || 0) + (s.SumTotalTime     || 0);
  t.SumReleasedTime  = (t.SumReleasedTime  || 0) + (s.SumReleasedTime  || 0);
}

// ── Render one <td> data cell ─────────────────────────────────────
// ctx = { block, service, week, dow } for individual data cells → enables hover tooltip.
// Omit ctx for grand-total cells.
function fmtCell(s, extraClass, ctx) {
  const cls = ['data-cell', extraClass].filter(Boolean).join(' ');
  if (!s || (!s.CaseCount && !s.SumBlockTime && !(s.SumReleasedTime > 0))) {
    return `<td class="${cls}"></td>`;
  }
  const ptVal  = s.SumBlockTime > 0 ? pct(s.SumPrimeTime, s.SumBlockTime) : null;
  const ptCls  = ptVal == null ? '' : ptVal >= 70 ? 'good' : ptVal >= 35 ? 'warn' : 'low';
  const ctxAttrs = ctx
    ? ` data-block="${escHtml(ctx.block)}"` +
      (ctx.service != null ? ` data-service="${escHtml(ctx.service)}"` : '') +
      ` data-dow="${ctx.dow}"` +
      (ctx.week != null ? ` data-week="${ctx.week}"` : '')
    : '';
  return `<td class="${cls}"${ctxAttrs}>
    <div class="cell-inner">
      <div class="cell-col">
        <div class="cell-cases">${s.CaseCount}</div>
      </div>
      <div class="cell-divider"></div>
      <div class="cell-col">
        <div class="cell-ptu ${ptCls}">${fmtPct(ptVal)}</div>
      </div>
    </div>
  </td>`;
}

// ── Build pivot HTML from flat API rows ───────────────────────────
function buildPivot(rows) {
  // Resolve the dominant (non-blank) service per CaseBlock
  const blockService = {};
  rows.forEach(r => {
    if (r.Service && !blockService[r.CaseBlock]) blockService[r.CaseBlock] = r.Service;
  });

  // Nest: pivot[block][service][week][dow] = raw row
  const pivot = {};
  rows.forEach(r => {
    const b = r.CaseBlock, sv = r.Service || blockService[b] || '', w = r.WeekOfMonth, d = r.DayOfWeek;
    if (!pivot[b])         pivot[b]      = {};
    if (!pivot[b][sv])     pivot[b][sv]  = {};
    if (!pivot[b][sv][w])  pivot[b][sv][w] = {};
    if (pivot[b][sv][w][d]) accum(pivot[b][sv][w][d], r);
    else                    pivot[b][sv][w][d] = r;
  });

  const blocks     = Object.keys(pivot).sort();
  const grandByDow = {};
  const grandAll   = {};
  let html = '';
  let blockIdx = 0;

  blocks.forEach(block => {
    const svcMap     = pivot[block];
    const services   = Object.keys(svcMap).sort();
    const blockByDow = {};
    const blockAll   = {};
    const bgClass    = blockIdx % 2 === 0 ? 'block-even' : 'block-odd';
    blockIdx++;

    // Total rowspan for CaseBlock = total week rows across all services + 1 block total
    let blockRowspan = 1;
    services.forEach(sv => {
      blockRowspan += Object.keys(svcMap[sv]).length;
    });

    services.forEach((sv, si) => {
      const weekMap    = svcMap[sv];
      const weeks      = Object.keys(weekMap).map(Number).sort((a, b) => a - b);
      const svcRowspan = weeks.length;

      weeks.forEach((week, wi) => {
        const rowSums = {};
        html += `<tr class="week-row ${bgClass}">`;

        // CaseBlock cell — only on very first row of this block
        if (si === 0 && wi === 0) {
          html += `<td class="block-cell" rowspan="${blockRowspan}">${escHtml(block)}</td>`;
        }
        // Service cell — first row of each service group
        if (wi === 0) {
          html += `<td class="service-cell" rowspan="${svcRowspan}">${escHtml(sv)}</td>`;
        }

        html += `<td class="week-cell">Wk ${week}</td>`;

        WEEKDAYS.forEach(dow => {
          const cell = weekMap[week][dow] || null;
          if (cell) {
            accum(rowSums, cell);
            if (!blockByDow[dow]) blockByDow[dow] = {};
            accum(blockByDow[dow], cell);
            accum(blockAll, cell);
            if (!grandByDow[dow]) grandByDow[dow] = {};
            accum(grandByDow[dow], cell);
            accum(grandAll, cell);
          }
          html += fmtCell(cell, '', cell ? { block, service: sv, week, dow } : null);
        });

        html += fmtCell(rowSums, 'col-total');
        html += '</tr>';
      });
    });

    // ── Block total row ────────────────────────────────────────
    html += `<tr class="subtotal-row ${bgClass}">`;
    html += `<td colspan="2" class="week-cell subtotal-label">Block Total</td>`;
    WEEKDAYS.forEach(dow => {
      const s = blockByDow[dow] || null;
      html += fmtCell(s, 'subtotal-cell', s ? { block, dow } : null);
    });
    html += fmtCell(blockAll, 'subtotal-cell col-total');
    html += '</tr>';
  });

  // ── Grand total row ────────────────────────────────────────────
  html += `<tr class="grand-row">`;
  html += `<td colspan="3" class="grand-label">Grand Total</td>`;
  WEEKDAYS.forEach(dow => html += fmtCell(grandByDow[dow] || null, 'grand-cell'));
  html += fmtCell(grandAll, 'grand-cell col-total');
  html += '</tr>';

  return html;
}

// ── Monthly detail (for hover tooltips) ──────────────────────────
// Keyed by "block|service|week|dow" → { month → raw row }
let monthlyDetail = {};

async function loadMonthlyDetail() {
  try {
    const res = await fetch(`/api/blockutil/monthly-detail?${buildQS()}`);
    if (!res.ok) return;
    const rows = await res.json();
    const blockSvc = {};
    rows.forEach(r => { if (r.Service && !blockSvc[r.CaseBlock]) blockSvc[r.CaseBlock] = r.Service; });

    monthlyDetail = {};
    rows.forEach(r => {
      const sv  = r.Service || blockSvc[r.CaseBlock] || '';
      const key = `${r.CaseBlock}|${sv}|${r.WeekOfMonth}|${r.DayOfWeek}`;
      if (!monthlyDetail[key]) monthlyDetail[key] = {};
      if (monthlyDetail[key][r.Month]) accum(monthlyDetail[key][r.Month], r);
      else                             monthlyDetail[key][r.Month] = r;
    });
  } catch (e) {
    console.warn('Monthly detail load failed:', e.message);
  }
}

// Returns the last 3 months ending at filterState.endDate
function monthsInRange() {
  const e = new Date(filterState.endDate + 'T00:00:00');
  const months = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(e.getFullYear(), e.getMonth() - i, 1);
    months.push({ month: d.getMonth() + 1, label: MONTH_NAMES[d.getMonth()] });
  }
  return months;
}

// ── Hover tooltip ─────────────────────────────────────────────────
function initTooltip() {
  const tt = document.createElement('div');
  tt.id = 'bu-tooltip';
  tt.className = 'bu-tooltip';
  tt.innerHTML = `
    <div class="bu-tt-header">
      <span id="bu-tt-block"></span>
      <span id="bu-tt-meta"></span>
    </div>
    <table class="bu-tt-table">
      <thead>
        <tr>
          <th>Month</th>
          <th>Cases</th>
          <th>PT%</th>
          <th>NPT%</th>
          <th>Released</th>
        </tr>
      </thead>
      <tbody id="bu-tt-body"></tbody>
    </table>`;
  document.body.appendChild(tt);

  const wrap = document.getElementById('pivot-wrap');
  let activeCell = null;

  wrap.addEventListener('mouseover', e => {
    const cell = e.target.closest('td[data-block]');
    if (cell === activeCell) return;
    activeCell = cell;
    if (cell) showTooltip(cell);
    else      hideTooltip();
  });

  wrap.addEventListener('mouseleave', () => {
    activeCell = null;
    hideTooltip();
  });
}

function showTooltip(cell) {
  const block   = cell.dataset.block;
  const service = cell.dataset.service;   // undefined on block-total cells
  const dow     = parseInt(cell.dataset.dow);
  const weekStr = cell.dataset.week;

  document.getElementById('bu-tt-block').textContent = block;

  let byMonth;
  if (weekStr != null) {
    // Individual data cell
    const week = parseInt(weekStr);
    byMonth = monthlyDetail[`${block}|${service || ''}|${week}|${dow}`] || {};
    document.getElementById('bu-tt-meta').textContent =
      `${service ? service + ' · ' : ''}Wk ${week} · ${DOW_LABEL[dow]}`;
  } else if (service != null) {
    // Service total cell — aggregate all weeks for this block+service+DOW
    byMonth = {};
    Object.keys(monthlyDetail).forEach(key => {
      const parts = key.split('|');
      const kb = parts[0], ksv = parts[1], kd = parts[3];
      if (kb === block && ksv === service && parseInt(kd) === dow) {
        Object.keys(monthlyDetail[key]).forEach(month => {
          if (!byMonth[month]) byMonth[month] = {};
          accum(byMonth[month], monthlyDetail[key][month]);
        });
      }
    });
    document.getElementById('bu-tt-meta').textContent = `${service} Total · ${DOW_LABEL[dow]}`;
  } else {
    // Block total cell — aggregate all services+weeks for this block+DOW
    byMonth = {};
    Object.keys(monthlyDetail).forEach(key => {
      const parts = key.split('|');
      const kb = parts[0], kd = parts[3];
      if (kb === block && parseInt(kd) === dow) {
        Object.keys(monthlyDetail[key]).forEach(month => {
          if (!byMonth[month]) byMonth[month] = {};
          accum(byMonth[month], monthlyDetail[key][month]);
        });
      }
    });
    document.getElementById('bu-tt-meta').textContent = `Block Total · ${DOW_LABEL[dow]}`;
  }

  const months = monthsInRange();
  document.getElementById('bu-tt-body').innerHTML = months.map(({ month, label }) => {
    const d = byMonth[month];
    const hasReleased = d && d.SumReleasedTime > 0;
    if (!d || (!d.CaseCount && !d.SumBlockTime && !hasReleased)) {
      return `<tr><td class="bu-tt-month">${label}</td><td></td><td></td><td></td><td></td></tr>`;
    }
    const ptVal  = d.SumBlockTime > 0 ? pct(d.SumPrimeTime, d.SumBlockTime) : null;
    const nptVal = pct(d.SumNonPrimeTime, d.SumTotalTime);
    const ptCls  = ptVal == null ? '' : ptVal >= 70 ? 'good' : ptVal >= 35 ? 'warn' : 'low';
    const released = hasReleased ? Math.round(d.SumReleasedTime).toLocaleString() : '';
    return `<tr>
      <td class="bu-tt-month">${label}</td>
      <td>${d.CaseCount || 0}</td>
      <td class="${ptCls}">${fmtPct(ptVal)}</td>
      <td>${fmtPct(nptVal)}</td>
      <td>${released}</td>
    </tr>`;
  }).join('');

  const tt   = document.getElementById('bu-tooltip');
  const rect = cell.getBoundingClientRect();
  const ttW  = 440;

  // Show first so we can measure height
  tt.style.visibility = 'hidden';
  tt.style.display    = 'block';

  let left = rect.right + 10;
  if (left + ttW > window.innerWidth - 8) left = Math.max(8, rect.left - ttW - 10);

  let top = rect.top;
  const ttH = tt.offsetHeight;
  if (top + ttH > window.innerHeight - 8) top = Math.max(8, window.innerHeight - ttH - 8);

  tt.style.left       = left + 'px';
  tt.style.top        = top  + 'px';
  tt.style.visibility = '';
}

function hideTooltip() {
  const tt = document.getElementById('bu-tooltip');
  if (tt) tt.style.display = 'none';
}

// ── Filter state ──────────────────────────────────────────────────
let filterState = {
  locations:   ['VORH OR'],
  caseBlocks:  [],
  startDate:   '2025-01-01',
  endDate:     '2025-12-31',
};

function buildQS() {
  const p = new URLSearchParams({
    startDate: filterState.startDate,
    endDate:   filterState.endDate,
  });
  if (filterState.locations.length)  p.set('locations',  filterState.locations.join(','));
  if (filterState.caseBlocks.length) p.set('caseblocks', filterState.caseBlocks.join(','));
  return p.toString();
}

// ── Multi-select dropdown ─────────────────────────────────────────
function buildMultiSelect(locations, defaults) {
  const menu = document.getElementById('ms-menu');
  menu.innerHTML = '';

  const allLabel = document.createElement('label');
  allLabel.className = 'ms-item ms-all-item';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox'; allCb.id = 'ms-all-cb';
  allCb.checked = defaults.length === 0;
  allLabel.append(allCb, ' All Locations');
  menu.appendChild(allLabel);

  const div = document.createElement('div');
  div.className = 'ms-divider';
  menu.appendChild(div);

  locations.forEach(loc => {
    const lbl = document.createElement('label');
    lbl.className = 'ms-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ms-loc-cb'; cb.value = loc;
    cb.checked = defaults.includes(loc);
    lbl.append(cb, ' ' + loc);
    menu.appendChild(lbl);
  });

  document.getElementById('ms-all-cb').addEventListener('change', () => {
    menu.querySelectorAll('.ms-loc-cb').forEach(c => { c.checked = false; });
    updateMsLabel();
  });

  menu.querySelectorAll('.ms-loc-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const any = [...menu.querySelectorAll('.ms-loc-cb')].some(c => c.checked);
      document.getElementById('ms-all-cb').checked = !any;
      updateMsLabel();
    });
  });

  updateMsLabel();
}

function getSelectedLocations() {
  return [...document.querySelectorAll('.ms-loc-cb:checked')].map(c => c.value);
}

function updateMsLabel() {
  const sel = getSelectedLocations();
  const lbl = document.getElementById('ms-label');
  if (!sel.length)         lbl.textContent = 'All Locations';
  else if (sel.length===1) lbl.textContent = sel[0];
  else                     lbl.textContent = `${sel.length} locations`;
}

function initDropdown() {
  const btn  = document.getElementById('ms-btn');
  const menu = document.getElementById('ms-menu');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    btn.classList.toggle('open', !isOpen);
  });
  document.addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.classList.remove('open');
  });
  menu.addEventListener('click', e => e.stopPropagation());
}

// ── Case Block multi-select ───────────────────────────────────────
function buildCbMultiSelect(blocks) {
  const menu = document.getElementById('cb-menu');
  menu.innerHTML = '';

  const allLabel = document.createElement('label');
  allLabel.className = 'ms-item ms-all-item';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox'; allCb.id = 'cb-all-cb';
  allCb.checked = true;
  allLabel.append(allCb, ' All Blocks');
  menu.appendChild(allLabel);

  const div = document.createElement('div');
  div.className = 'ms-divider';
  menu.appendChild(div);

  blocks.forEach(block => {
    const lbl = document.createElement('label');
    lbl.className = 'ms-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'cb-block-cb'; cb.value = block;
    cb.checked = false;
    lbl.append(cb, ' ' + block);
    menu.appendChild(lbl);
  });

  document.getElementById('cb-all-cb').addEventListener('change', () => {
    menu.querySelectorAll('.cb-block-cb').forEach(c => { c.checked = false; });
    updateCbLabel();
  });

  menu.querySelectorAll('.cb-block-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const any = [...menu.querySelectorAll('.cb-block-cb')].some(c => c.checked);
      document.getElementById('cb-all-cb').checked = !any;
      updateCbLabel();
    });
  });

  updateCbLabel();
}

function getSelectedCaseBlocks() {
  return [...document.querySelectorAll('.cb-block-cb:checked')].map(c => c.value);
}

function updateCbLabel() {
  const sel = getSelectedCaseBlocks();
  const lbl = document.getElementById('cb-label');
  if (!sel.length)         lbl.textContent = 'All Blocks';
  else if (sel.length===1) lbl.textContent = sel[0];
  else                     lbl.textContent = `${sel.length} blocks`;
}

function initCbDropdown() {
  const btn  = document.getElementById('cb-btn');
  const menu = document.getElementById('cb-menu');
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', isOpen);
    btn.classList.toggle('open', !isOpen);
  });
  document.addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.classList.remove('open');
  });
  menu.addEventListener('click', e => e.stopPropagation());
}

// ── Load and render ───────────────────────────────────────────────
async function loadData() {
  const status = document.getElementById('table-status');
  const table  = document.getElementById('pivot-table');
  const tbody  = document.getElementById('pivot-body');
  const legend = document.getElementById('pivot-legend');

  status.style.display = '';
  status.className = 'status-msg';
  status.textContent = 'Loading\u2026';
  table.classList.add('hidden');
  legend.style.display = 'none';
  tbody.innerHTML = '';

  try {
    const res = await fetch(`/api/blockutil/data?${buildQS()}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const rows = await res.json();

    if (!rows.length) {
      status.textContent = 'No data found for the selected filters.';
      return;
    }

    tbody.innerHTML = buildPivot(rows);
    status.style.display = 'none';
    table.classList.remove('hidden');
    legend.style.display = '';

    // Update title
    const locs = filterState.locations;
    const locLabel = !locs.length ? 'All Locations'
      : locs.length === 1        ? locs[0]
      : `${locs.length} Locations`;
    document.getElementById('table-title').textContent =
      `Block Utilization \u2014 ${locLabel}`;
  } catch (err) {
    status.className   = 'status-msg error';
    status.textContent = `Failed to load data: ${err.message}`;
  }
}

// ── Apply ─────────────────────────────────────────────────────────
function applyFilters() {
  filterState.locations  = getSelectedLocations();
  filterState.caseBlocks = getSelectedCaseBlocks();
  filterState.startDate  = document.getElementById('start-date').value || '2025-01-01';
  filterState.endDate    = document.getElementById('end-date').value   || '2025-12-31';
  loadData();
  loadMonthlyDetail();
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  document.getElementById('apply-btn').addEventListener('click', applyFilters);
  ['start-date', 'end-date'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key === 'Enter') applyFilters();
    });
  });

  try {
    const res = await fetch('/api/capacity/location-groups');
    if (res.ok) {
      const locs = await res.json();
      const defaults = locs.includes('VORH OR') ? ['VORH OR'] : [];
      filterState.locations = defaults;
      buildMultiSelect(locs, defaults);
    }
  } catch (e) {
    console.warn('Could not load location groups:', e.message);
  }

  try {
    const qs  = new URLSearchParams({
      startDate: filterState.startDate,
      endDate:   filterState.endDate,
    });
    if (filterState.locations.length) qs.set('locations', filterState.locations.join(','));
    const cbRes = await fetch(`/api/blockutil/caseblocks?${qs}`);
    if (cbRes.ok) {
      const blocks = await cbRes.json();
      buildCbMultiSelect(blocks);
    }
  } catch (e) {
    console.warn('Could not load case blocks:', e.message);
  }

  initDropdown();
  initCbDropdown();
  initTooltip();
  loadData();
  loadMonthlyDetail();
}

init();
