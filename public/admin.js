// ── Admin UI ───────────────────────────────────────────────────────
let editingId = null;

async function loadUsers() {
  const status = document.getElementById('user-status');
  const table  = document.getElementById('users-table');
  const tbody  = document.getElementById('users-body');
  status.style.display = '';
  status.className = 'status-msg';
  status.textContent = 'Loading\u2026';
  table.classList.add('hidden');

  try {
    const res = await fetch('/api/admin/users');
    if (res.status === 403) {
      status.textContent = 'Access denied. Admin privileges required.';
      status.className = 'status-msg error';
      return;
    }
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const users = await res.json();

    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${esc(u.Username)}</strong></td>
        <td>${esc(u.FullName || '')}</td>
        <td>${esc(u.Email || '')}</td>
        <td>${badge(u.IsAdmin,    'Admin')}</td>
        <td>${badge(u.IsActive,   'Active')}</td>
        <td>${u.TOTPEnabled ? '<span class="badge badge-mfa">Enrolled</span>' : '<span class="badge badge-no">Not set</span>'}</td>
        <td>${u.LastLogin ? new Date(u.LastLogin).toLocaleString() : '—'}</td>
        <td>
          <button class="btn-edit"   onclick="openEdit(${u.UserID})">Edit</button>
          <button class="btn-delete" onclick="deleteUser(${u.UserID}, '${esc(u.Username)}')">Delete</button>
        </td>
      </tr>`).join('');

    status.style.display = 'none';
    table.classList.remove('hidden');
  } catch (err) {
    status.className = 'status-msg error';
    status.textContent = `Failed to load users: ${err.message}`;
  }
}

function badge(val, label) {
  return val ? `<span class="badge badge-yes">${label}</span>`
             : `<span class="badge badge-no">No</span>`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ── Modal helpers ──────────────────────────────────────────────────
function openModal(title) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-error').classList.add('hidden');
  document.getElementById('modal-success').classList.add('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('user-form').reset();
  editingId = null;
}

function openNew() {
  editingId = null;
  document.getElementById('edit-user-id').value = '';
  document.getElementById('f-username').disabled = false;
  document.getElementById('f-isactive').checked  = true;
  document.getElementById('f-isadmin').checked   = false;
  document.getElementById('f-reset-totp-wrap') && document.getElementById('reset-totp-wrap').classList.add('hidden');
  document.getElementById('pwd-hint').style.display = 'none';
  document.getElementById('f-password').required = true;
  openModal('New User');
  document.getElementById('f-username').focus();
}

function openEdit(id) {
  editingId = id;
  document.getElementById('edit-user-id').value = id;

  // Fetch user details from table rows
  const rows = [...document.querySelectorAll('#users-body tr')];
  const row  = rows.find(r => r.querySelector('.btn-edit')?.getAttribute('onclick')?.includes(`(${id})`));
  if (!row) return;
  const cells = row.querySelectorAll('td');

  document.getElementById('f-username').value    = cells[0].textContent.trim();
  document.getElementById('f-fullname').value    = cells[1].textContent.trim();
  document.getElementById('f-email').value       = cells[2].textContent.trim();
  document.getElementById('f-isadmin').checked   = cells[3].textContent.includes('Admin');
  document.getElementById('f-isactive').checked  = cells[4].textContent.includes('Active');
  document.getElementById('f-username').disabled = true;
  document.getElementById('f-password').required = false;
  document.getElementById('pwd-hint').style.display = '';
  document.getElementById('reset-totp-wrap').classList.remove('hidden');
  document.getElementById('f-reset-totp').checked = false;
  openModal('Edit User');
  document.getElementById('f-fullname').focus();
}

async function deleteUser(id, username) {
  if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
  const res  = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Delete failed'); return; }
  loadUsers();
}

// ── Form submit ────────────────────────────────────────────────────
document.getElementById('user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('modal-error');
  errEl.classList.add('hidden');

  const payload = {
    email:    document.getElementById('f-email').value.trim()    || null,
    fullName: document.getElementById('f-fullname').value.trim() || null,
    isAdmin:  document.getElementById('f-isadmin').checked,
    isActive: document.getElementById('f-isactive').checked,
  };

  const pwd = document.getElementById('f-password').value;

  if (editingId) {
    if (pwd) payload.resetPassword = pwd;
    if (document.getElementById('f-reset-totp').checked) payload.resetTotp = true;
    const res  = await fetch(`/api/admin/users/${editingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Update failed'; errEl.classList.remove('hidden'); return; }
  } else {
    payload.username = document.getElementById('f-username').value.trim();
    payload.password = pwd;
    const res  = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Create failed'; errEl.classList.remove('hidden'); return; }
  }

  closeModal();
  loadUsers();
});

// ── Init ───────────────────────────────────────────────────────────
document.getElementById('new-user-btn').addEventListener('click', openNew);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

loadUsers();
