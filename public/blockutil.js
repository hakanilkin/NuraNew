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
  t.CaseCount       = (t.CaseCount       || 0) + (s.CaseCount       || 0);
  t.SumPrimeTime    = (t.SumPrimeTime    || 0) + (s.SumPrimeTime    || 0);
  t.SumBlockTime    = (t.SumBlockTime    || 0) + (s.SumBlockTime    || 0);
  t.SumNonPrimeTime = (t.SumNonPrimeTime || 0) + (s.SumNonPrimeTime || 0);
  t.SumTotalTime    = (t.SumTotalTime    || 0) + (s.SumTotalTime    || 0);
}

// ── Render one <td> data cell ─────────────────────────────────────
// Cases and PT% are shown side-by-side; NPT% appears on hover via CSS tooltip.
function fmtCell(s, extraClass) {
  const cls = ['data-cell', extraClass].filter(Boolean).join(' ');
  if (!s || (!s.CaseCount && !s.SumBlockTime)) {
    return `<td class="${cls}"></td>`;
  }
  const ptVal   = pct(s.SumPrimeTime,    s.SumBlockTime);
  const nptVal  = pct(s.SumNonPrimeTime, s.SumTotalTime);
  const ptCls   = ptVal == null ? '' : ptVal >= 70 ? 'good' : ptVal >= 35 ? 'warn' : 'low';
  const nptAttr = nptVal != null ? ` data-npt="NPT: ${fmtPct(nptVal)}"` : '';
  return `<td class="${cls}"${nptAttr}>
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
  // Nest: pivot[block][week][dow] = raw row sums
  const pivot = {};
  rows.forEach(r => {
    const b = r.CaseBlock, w = r.WeekOfMonth, d = r.DayOfWeek;
    if (!pivot[b]) pivot[b] = {};
    if (!pivot[b][w]) pivot[b][w] = {};
    pivot[b][w][d] = r;
  });

  const blocks     = Object.keys(pivot).sort();
  const grandByDow = {};  // grandByDow[dow] = sums
  const grandAll   = {};  // sum across all dows + all blocks
  let html = '';
  let blockIdx = 0;

  blocks.forEach(block => {
    const weekMap  = pivot[block];
    const weeks    = Object.keys(weekMap).map(Number).sort((a, b) => a - b);
    const rowspan  = weeks.length + 1;   // +1 for the block subtotal row
    const blockByDow = {};
    const blockAll   = {};
    const bgClass  = blockIdx % 2 === 0 ? 'block-even' : 'block-odd';
    blockIdx++;

    weeks.forEach((week, wi) => {
      const rowSums = {};
      html += `<tr class="week-row ${bgClass}">`;

      // CaseBlock cell spans all week rows plus subtotal
      if (wi === 0) {
        html += `<td class="block-cell" rowspan="${rowspan}">${escHtml(block)}</td>`;
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
        html += fmtCell(cell, '');
      });

      html += fmtCell(rowSums, 'col-total');
      html += '</tr>';
    });

    // ── Block subtotal row ─────────────────────────────────────
    html += `<tr class="subtotal-row ${bgClass}">`;
    html += `<td class="week-cell subtotal-label">Subtotal</td>`;
    WEEKDAYS.forEach(dow => html += fmtCell(blockByDow[dow] || null, 'subtotal-cell'));
    html += fmtCell(blockAll, 'subtotal-cell col-total');
    html += '</tr>';
  });

  // ── Grand total row ────────────────────────────────────────────
  html += `<tr class="grand-row">`;
  html += `<td colspan="2" class="grand-label">Grand Total</td>`;
  WEEKDAYS.forEach(dow => html += fmtCell(grandByDow[dow] || null, 'grand-cell'));
  html += fmtCell(grandAll, 'grand-cell col-total');
  html += '</tr>';

  return html;
}

// ── Filter state ──────────────────────────────────────────────────
let filterState = {
  locations: ['VORH OR'],
  startDate: '2025-01-01',
  endDate:   '2025-12-31',
};

function buildQS() {
  const p = new URLSearchParams({
    startDate: filterState.startDate,
    endDate:   filterState.endDate,
  });
  if (filterState.locations.length) p.set('locations', filterState.locations.join(','));
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
  filterState.locations = getSelectedLocations();
  filterState.startDate = document.getElementById('start-date').value || '2025-01-01';
  filterState.endDate   = document.getElementById('end-date').value   || '2025-12-31';
  loadData();
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

  initDropdown();
  loadData();
}

init();
