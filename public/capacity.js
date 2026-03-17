// ── Register plugins ──────────────────────────────────────────────
Chart.register(ChartDataLabels);

// ── Helpers ──────────────────────────────────────────────────────
const fmtPct = (n) => n == null ? '—' : Number(n).toFixed(1) + '%';

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// SQL Server DATEPART(WEEKDAY) defaults: 1=Sun, 2=Mon … 7=Sat
const PRIME_TARGET = 80;

// ── State ─────────────────────────────────────────────────────────
let primeChart    = null;
let nonPrimeChart = null;

let filterState = {
  startDate: '2025-01-01',
  endDate:   '2025-12-31',
  locations: [],   // empty = all
  dow:       [2, 3, 4, 5, 6],  // Mon–Fri
};

// ── Query string builder ──────────────────────────────────────────
function buildQS() {
  const p = new URLSearchParams({
    startDate: filterState.startDate,
    endDate:   filterState.endDate,
    dow:       filterState.dow.join(','),
  });
  if (filterState.locations.length) p.set('locations', filterState.locations.join(','));
  return p.toString();
}

// ── Multi-select dropdown ─────────────────────────────────────────
function buildMultiSelect(items) {
  const menu = document.getElementById('ms-menu');
  menu.innerHTML = '';

  const allLabel = document.createElement('label');
  allLabel.className = 'ms-item ms-all-item';
  const allCb = document.createElement('input');
  allCb.type = 'checkbox'; allCb.id = 'ms-all-cb'; allCb.checked = true;
  allLabel.append(allCb, ' All Locations');
  menu.appendChild(allLabel);

  const divider = document.createElement('div');
  divider.className = 'ms-divider';
  menu.appendChild(divider);

  items.forEach(item => {
    const label = document.createElement('label');
    label.className = 'ms-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'ms-loc-cb'; cb.value = item;
    label.append(cb, ' ' + item);
    menu.appendChild(label);
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
}

function getSelectedLocations() {
  return [...document.querySelectorAll('.ms-loc-cb:checked')].map(c => c.value);
}

function updateMsLabel() {
  const sel = getSelectedLocations();
  const label = document.getElementById('ms-label');
  if (!sel.length)          label.textContent = 'All Locations';
  else if (sel.length === 1) label.textContent = sel[0];
  else                       label.textContent = `${sel.length} locations selected`;
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
    document.getElementById('dow-menu').classList.add('hidden');
    document.getElementById('dow-btn').classList.remove('open');
  });

  menu.addEventListener('click', (e) => e.stopPropagation());
}

// ── Day-of-week multi-select dropdown ────────────────────────────
const DOW_OPTIONS = [
  { label: 'Monday',    dow: 2 },
  { label: 'Tuesday',   dow: 3 },
  { label: 'Wednesday', dow: 4 },
  { label: 'Thursday',  dow: 5 },
  { label: 'Friday',    dow: 6 },
  { label: 'Saturday',  dow: 7 },
  { label: 'Sunday',    dow: 1 },
];
const WEEKDAY_DOWS = new Set([2, 3, 4, 5, 6]);

function buildDowDropdown() {
  const menu = document.getElementById('dow-menu');
  menu.innerHTML = '';

  DOW_OPTIONS.forEach(({ label, dow }) => {
    const lbl = document.createElement('label');
    lbl.className = 'ms-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'dow-cb';
    cb.value = dow;
    cb.checked = WEEKDAY_DOWS.has(dow);
    lbl.append(cb, ' ' + label);
    menu.appendChild(lbl);
  });

  menu.querySelectorAll('.dow-cb').forEach(cb => {
    cb.addEventListener('change', updateDowLabel);
  });
}

function getSelectedDow() {
  return [...document.querySelectorAll('.dow-cb:checked')].map(c => parseInt(c.value));
}

function updateDowLabel() {
  const sel = getSelectedDow();
  const label = document.getElementById('dow-label');
  if (!sel.length) {
    label.textContent = 'None';
  } else if (sel.length === 7) {
    label.textContent = 'All Days';
  } else if (sel.length === 5 && WEEKDAY_DOWS.size === sel.filter(d => WEEKDAY_DOWS.has(d)).length && !sel.some(d => !WEEKDAY_DOWS.has(d))) {
    label.textContent = 'Weekdays';
  } else if (sel.length === 2 && sel.includes(1) && sel.includes(7)) {
    label.textContent = 'Weekends';
  } else {
    label.textContent = `${sel.length} days selected`;
  }
}

function initDowDropdown() {
  const btn  = document.getElementById('dow-btn');
  const menu = document.getElementById('dow-menu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden', open);
    btn.classList.toggle('open', !open);
  });

  menu.addEventListener('click', (e) => e.stopPropagation());
}

// ── Dynamic chart height based on number of bars ──────────────────
function setChartHeight(wrapId, count) {
  const h = Math.max(220, count * 38 + 60);
  document.getElementById(wrapId).style.height = h + 'px';
}

// ── Bar colour helpers ────────────────────────────────────────────
function primeColors(values) {
  return values.map(v => v >= PRIME_TARGET ? '#28a745' : '#fd7e14');
}

function primeHoverColors(values) {
  return values.map(v => v >= PRIME_TARGET ? '#218838' : '#e8690a');
}

// ── Prime Time Utilization Chart ──────────────────────────────────
async function loadPrimeChart() {
  const status = document.getElementById('prime-status');
  status.style.display = '';
  status.className = 'status-msg';
  status.textContent = 'Loading\u2026';

  try {
    const res  = await fetch(`/api/capacity/prime-time?${buildQS()}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const rows = await res.json();

    if (!rows.length) {
      status.textContent = 'No data found for the selected filters.';
      return;
    }

    const labels = rows.map(r => r.LocationGroup);
    const values = rows.map(r => r.PrimeTimeUtil);

    setChartHeight('prime-wrap', labels.length);
    status.style.display = 'none';

    const chartData = {
      labels,
      datasets: [{
        label: 'Prime Time Utilization (%)',
        data: values,
        backgroundColor: primeColors(values),
        hoverBackgroundColor: primeHoverColors(values),
        borderRadius: 3,
        borderSkipped: false,
      }],
    };

    const chartOptions = {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      clip: false,
      layout: { padding: { right: 48 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${fmtPct(ctx.parsed.x)}`,
            afterLabel: (ctx) => ctx.parsed.x >= PRIME_TARGET
              ? ' ✓ At or above target'
              : ` ✗ ${(PRIME_TARGET - ctx.parsed.x).toFixed(1)}% below target`,
          },
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          offset: 4,
          formatter: (v) => fmtPct(v),
          font: { size: 11, weight: '600' },
          color: '#333',
        },
        annotation: {
          annotations: {
            targetLine: {
              type: 'line',
              xMin: PRIME_TARGET,
              xMax: PRIME_TARGET,
              borderColor: '#dc3545',
              borderWidth: 2,
              borderDash: [6, 4],
              label: {
                display: true,
                content: 'Target 80%',
                position: 'start',
                backgroundColor: 'rgba(220,53,69,0.85)',
                color: '#fff',
                font: { size: 11, weight: 'bold' },
                padding: { x: 6, y: 3 },
                yAdjust: -14,
              },
            },
          },
        },
      },
      scales: {
        x: {
          min: 0,
          max: 100,
          grid: { color: '#e8ecf0' },
          ticks: {
            font: { size: 11 },
            callback: (v) => v + '%',
          },
          title: { display: true, text: 'Prime Time Utilization (%)', font: { size: 11 }, color: '#555' },
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 12 } },
        },
      },
    };

    if (primeChart) {
      primeChart.data        = chartData;
      primeChart.options     = chartOptions;
      primeChart.update();
    } else {
      const ctx = document.getElementById('prime-chart').getContext('2d');
      primeChart = new Chart(ctx, { type: 'bar', data: chartData, options: chartOptions });
    }

  } catch (err) {
    status.className   = 'status-msg error';
    status.textContent = `Failed to load chart: ${err.message}`;
  }
}

// ── Non-Prime Time Utilization Chart ─────────────────────────────
async function loadNonPrimeChart() {
  const status = document.getElementById('nonprime-status');
  status.style.display = '';
  status.className = 'status-msg';
  status.textContent = 'Loading\u2026';

  try {
    const res  = await fetch(`/api/capacity/non-prime-time?${buildQS()}`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const rows = await res.json();

    if (!rows.length) {
      status.textContent = 'No data found for the selected filters.';
      return;
    }

    const labels  = rows.map(r => r.LocationGroup);
    const values  = rows.map(r => r.NonPrimeTimeUtil);
    const axisMax = Math.ceil(Math.max(...values) + 5);

    setChartHeight('nonprime-wrap', labels.length);
    status.style.display = 'none';

    const chartData = {
      labels,
      datasets: [{
        label: '% Non-Prime Time Use',
        data: values,
        backgroundColor: '#6ea8fe',
        hoverBackgroundColor: '#4b8ee8',
        borderRadius: 3,
        borderSkipped: false,
      }],
    };

    const chartOptions = {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      clip: false,
      layout: { padding: { right: 48 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => ` ${fmtPct(ctx.parsed.x)}` },
        },
        datalabels: {
          anchor: 'end',
          align: 'end',
          offset: 4,
          formatter: (v) => fmtPct(v),
          font: { size: 11, weight: '600' },
          color: '#333',
        },
      },
      scales: {
        x: {
          min: 0,
          max: axisMax,
          grid: { color: '#e8ecf0' },
          ticks: {
            font: { size: 11 },
            callback: (v) => v + '%',
          },
          title: { display: true, text: '% Non-Prime Time Use', font: { size: 11 }, color: '#555' },
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 12 } },
        },
      },
    };

    if (nonPrimeChart) {
      nonPrimeChart.data    = chartData;
      nonPrimeChart.options = chartOptions;
      nonPrimeChart.update();
    } else {
      const ctx = document.getElementById('nonprime-chart').getContext('2d');
      nonPrimeChart = new Chart(ctx, { type: 'bar', data: chartData, options: chartOptions });
    }

  } catch (err) {
    status.className   = 'status-msg error';
    status.textContent = `Failed to load chart: ${err.message}`;
  }
}

// ── Apply filters ─────────────────────────────────────────────────
function applyFilters() {
  filterState.startDate = document.getElementById('start-date').value || '2025-01-01';
  filterState.endDate   = document.getElementById('end-date').value   || '2025-12-31';
  filterState.locations = getSelectedLocations();
  filterState.dow       = getSelectedDow();

  loadPrimeChart();
  loadNonPrimeChart();
}

// ── Init ──────────────────────────────────────────────────────────
async function init() {
  document.getElementById('apply-btn').addEventListener('click', applyFilters);

  ['start-date', 'end-date'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyFilters();
    });
  });

  buildDowDropdown();
  initDowDropdown();

  try {
    const res = await fetch('/api/capacity/location-groups');
    if (res.ok) buildMultiSelect(await res.json());
  } catch (e) {
    console.warn('Could not load location groups:', e.message);
  }

  initDropdownToggle();
  loadPrimeChart();
  loadNonPrimeChart();
}

init();
