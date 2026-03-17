// ── Helpers ──────────────────────────────────────────────────────
const fmt = (n) =>
  n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                 'Jul','Aug','Sep','Oct','Nov','Dec'];

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── State ─────────────────────────────────────────────────────────
let trendChart = null;

let filterState = {
  sites:     [],            // empty = all sites
  startDate: '2025-01-01',
  endDate:   '2025-12-31',
};

// ── Query string builder ──────────────────────────────────────────
function buildQS() {
  const p = new URLSearchParams({
    startDate: filterState.startDate,
    endDate:   filterState.endDate,
  });
  if (filterState.sites.length) p.set('sites', filterState.sites.join(','));
  return p.toString();
}

// ── Month label generation ────────────────────────────────────────
function buildMonthAxis(startDate, endDate) {
  const labels = [], keys = [];
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate   + 'T00:00:00');
  const multiYear = s.getFullYear() !== e.getFullYear();
  const d = new Date(s.getFullYear(), s.getMonth(), 1);

  while (d.getFullYear() < e.getFullYear() ||
        (d.getFullYear() === e.getFullYear() && d.getMonth() <= e.getMonth())) {
    labels.push(multiYear
      ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
      : MONTHS[d.getMonth()]);
    keys.push(`${d.getFullYear()}-${d.getMonth() + 1}`);
    d.setMonth(d.getMonth() + 1);
  }
  return { labels, keys };
}

// ── Multi-select dropdown ─────────────────────────────────────────
function buildMultiSelect(sites) {
  const menu = document.getElementById('ms-menu');
  menu.innerHTML = '';

  // "All Sites" toggle
  const allLabel = document.createElement('label');
  allLabel.className = 'ms-item ms-all-item';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox'; allCb.id = 'ms-all-cb'; allCb.checked = true;
  allLabel.append(allCb, ' All Sites');
  menu.appendChild(allLabel);

  const divider = document.createElement('div');
  divider.className = 'ms-divider';
  menu.appendChild(divider);

  // Individual site checkboxes
  sites.forEach(site => {
    const label = document.createElement('label');
    label.className = 'ms-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ms-site-cb'; cb.value = site;
    label.append(cb, ' ' + site);
    menu.appendChild(label);
  });

  allCb.addEventListener('change', () => {
    // Uncheck all sites when "All" is chosen
    menu.querySelectorAll('.ms-site-cb').forEach(c => { c.checked = false; });
    updateMsLabel();
  });

  menu.querySelectorAll('.ms-site-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const any = [...menu.querySelectorAll('.ms-site-cb')].some(c => c.checked);
      document.getElementById('ms-all-cb').checked = !any;
      updateMsLabel();
    });
  });
}

function getSelectedSites() {
  return [...document.querySelectorAll('.ms-site-cb:checked')].map(c => c.value);
}

function updateMsLabel() {
  const sel = getSelectedSites();
  const label = document.getElementById('ms-label');
  if (!sel.length)       label.textContent = 'All Sites';
  else if (sel.length === 1) label.textContent = sel[0];
  else                   label.textContent = `${sel.length} sites selected`;
}

function initDropdownToggle() {
  const btn  = document.getElementById('ms-btn');
  const menu = document.getElementById('ms-menu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', open);
    btn.classList.toggle('open', !open);
  });

  document.addEventListener('click', () => {
    menu.classList.add('hidden');
    btn.classList.remove('open');
  });

  menu.addEventListener('click', (e) => e.stopPropagation());
}

// ── Chart title ───────────────────────────────────────────────────
function updateChartTitle() {
  const { sites, startDate, endDate } = filterState;
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate   + 'T00:00:00');
  const sameYear = s.getFullYear() === e.getFullYear();

  const dateRange = sameYear
    ? `${MONTHS[s.getMonth()]}–${MONTHS[e.getMonth()]} ${s.getFullYear()}`
    : `${MONTHS[s.getMonth()]} ${s.getFullYear()} – ${MONTHS[e.getMonth()]} ${e.getFullYear()}`;

  const siteText = !sites.length       ? 'All Sites'
    : sites.length === 1               ? escHtml(sites[0])
    : `${sites.length} Sites Selected`;

  const siteHtml = !sites.length
    ? 'All Sites'
    : `<span class="site-highlight">${siteText}</span>`;

  document.getElementById('trend-title').innerHTML =
    `Monthly Case Volume &mdash; ${siteHtml} &nbsp;|&nbsp; ${dateRange}`;

  return siteText; // used as dataset label
}

// ── Summary Table ─────────────────────────────────────────────────
async function loadSummaryTable() {
  const status = document.getElementById('table-status');
  const table  = document.getElementById('summary-table');
  const tbody  = table.querySelector('tbody');

  status.style.display = '';
  status.className = 'status-msg';
  status.textContent = 'Loading\u2026';
  tbody.innerHTML = '';
  table.classList.add('hidden');

  try {
    const res  = await fetch(`/api/summary?${buildQS()}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const rows = await res.json();

    if (!rows.length) {
      status.textContent = 'No data found for the selected filters.';
      return;
    }

    let totalCases = 0, totalDuration = 0;

    rows.forEach(row => {
      const avg = row.TotalCases > 0 ? (row.TotalORDuration / row.TotalCases) : 0;
      totalCases    += row.TotalCases     || 0;
      totalDuration += row.TotalORDuration || 0;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escHtml(row.Site)}</td>
        <td>${fmt(row.TotalCases)}</td>
        <td>${fmt(row.TotalORDuration)}</td>
        <td>${fmt(avg)}</td>
      `;
      tbody.appendChild(tr);
    });

    document.getElementById('foot-cases').textContent    = fmt(totalCases);
    document.getElementById('foot-duration').textContent = fmt(totalDuration);
    document.getElementById('foot-avg').textContent =
      totalCases > 0 ? fmt(totalDuration / totalCases) : '—';

    status.style.display = 'none';
    table.classList.remove('hidden');

  } catch (err) {
    status.className   = 'status-msg error';
    status.textContent = `Failed to load summary: ${err.message}`;
  }
}

// ── Trend Chart ───────────────────────────────────────────────────
async function loadTrendChart() {
  const status = document.getElementById('chart-status');
  status.style.display = '';
  status.className = 'status-msg';
  status.textContent = 'Loading\u2026';

  try {
    const res  = await fetch(`/api/monthly-trend?${buildQS()}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const rows = await res.json();

    const { labels, keys } = buildMonthAxis(filterState.startDate, filterState.endDate);
    const dataMap = {};
    rows.forEach(r => { dataMap[`${r.Year}-${r.Month}`] = r.TotalCases; });
    const counts = keys.map(k => dataMap[k] || 0);

    const datasetLabel = updateChartTitle();
    status.style.display = 'none';

    if (trendChart) {
      trendChart.data.labels                  = labels;
      trendChart.data.datasets[0].label       = datasetLabel;
      trendChart.data.datasets[0].data        = counts;
      trendChart.update();
    } else {
      const ctx = document.getElementById('trend-chart').getContext('2d');
      trendChart = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: datasetLabel,
            data: counts,
            borderColor: '#0d6efd',
            backgroundColor: 'rgba(13,110,253,0.10)',
            borderWidth: 2.5,
            pointBackgroundColor: '#0d6efd',
            pointRadius: 5,
            pointHoverRadius: 7,
            fill: true,
            tension: 0.35,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: {
              display: true,
              labels: { font: { size: 12 }, color: '#333' },
            },
            tooltip: {
              callbacks: { label: (ctx) => ` ${fmt(ctx.parsed.y)} cases` },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { font: { size: 12 } },
            },
            y: {
              beginAtZero: true,
              grid: { color: '#e8ecf0' },
              ticks: { font: { size: 11 }, callback: (v) => fmt(v) },
              title: {
                display: true,
                text: 'Number of Cases',
                font: { size: 12 },
                color: '#555',
              },
            },
          },
        },
      });
    }

  } catch (err) {
    status.className   = 'status-msg error';
    status.textContent = `Failed to load trend chart: ${err.message}`;
  }
}

// ── Apply filters ─────────────────────────────────────────────────
function applyFilters() {
  filterState.sites     = getSelectedSites();
  filterState.startDate = document.getElementById('start-date').value || '2025-01-01';
  filterState.endDate   = document.getElementById('end-date').value   || '2025-12-31';
  loadSummaryTable();
  loadTrendChart();
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  document.getElementById('apply-btn').addEventListener('click', applyFilters);

  // Allow Enter key on date inputs to trigger apply
  ['start-date', 'end-date'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyFilters();
    });
  });

  try {
    const res = await fetch('/api/sites');
    if (res.ok) buildMultiSelect(await res.json());
  } catch (e) {
    console.warn('Could not load sites list:', e.message);
  }

  initDropdownToggle();
  loadSummaryTable();
  loadTrendChart();
}

init();
