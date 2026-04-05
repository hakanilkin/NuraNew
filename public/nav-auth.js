// Shared: show Admin nav link for admins + add logout button
(async () => {
  try {
    const res  = await fetch('/api/auth/me');
    if (!res.ok) return;
    const user = await res.json();

    // Show Admin link only for admins
    const adminLink = document.getElementById('nav-admin');
    if (adminLink && user.isAdmin) adminLink.classList.remove('hidden');

    // Append logout + user name to header nav
    const nav = document.querySelector('.header-nav');
    if (nav) {
      const sep  = document.createElement('span');
      sep.className = 'nav-user';
      sep.textContent = user.fullName || '';
      nav.appendChild(sep);

      const btn = document.createElement('button');
      btn.className = 'nav-logout-btn';
      btn.textContent = 'Sign out';
      btn.addEventListener('click', async () => {
        await fetch('/api/auth/logout', { method: 'POST' });
        window.location.href = '/login.html';
      });
      nav.appendChild(btn);
    }
  } catch (_) {}
})();
