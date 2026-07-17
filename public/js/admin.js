(() => {
  'use strict';

  const API = '/api';
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  let allBookings = [];
  let token = sessionStorage.getItem('adminToken') || null;

  function toast(message, type = 'default') {
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'all .3s ease';
      setTimeout(() => el.remove(), 320);
    }, 3800);
  }

  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...options,
    });
    if (res.status === 401) {
      logout();
      throw new Error('Session expired. Please log in again.');
    }
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : null;
    if (!res.ok) throw new Error(data?.error || 'Something went wrong');
    return data;
  }

  function fmtMoney(n) { return `$${Number(n).toFixed(0)}`; }
  function fmtDate(dateStr, timeStr) {
    const d = new Date(`${dateStr}T${timeStr}:00`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  // ===================== AUTH =====================
  function showDashboard() {
    $('#loginScreen').classList.add('hidden');
    $('#dashboard').classList.remove('hidden');
    loadAll();
  }
  function showLogin() {
    $('#dashboard').classList.add('hidden');
    $('#loginScreen').classList.remove('hidden');
  }
  function logout() {
    token = null;
    sessionStorage.removeItem('adminToken');
    showLogin();
  }
  $('#logoutBtn').addEventListener('click', logout);

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusEl = $('#loginStatus');
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    statusEl.textContent = '';
    statusEl.className = 'form-status';
    try {
      const res = await fetch(`${API}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#loginUser').value.trim(), password: $('#loginPass').value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      token = data.token;
      sessionStorage.setItem('adminToken', token);
      showDashboard();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'form-status error';
    } finally {
      btn.disabled = false;
    }
  });

  if (token) showDashboard(); else showLogin();

  // ===================== LOAD DATA =====================
  async function loadAll() {
    await Promise.all([loadStats(), loadBookings()]);
  }

  async function loadStats() {
    try {
      const s = await api('/admin/stats');
      $('#adminStats').innerHTML = `
        <div class="stat-box"><div class="label">Total Bookings</div><div class="value">${s.total}</div></div>
        <div class="stat-box"><div class="label">Today</div><div class="value">${s.today}</div></div>
        <div class="stat-box"><div class="label">Upcoming</div><div class="value">${s.upcoming}</div></div>
        <div class="stat-box"><div class="label">Cancelled</div><div class="value">${s.cancelled}</div></div>
        <div class="stat-box"><div class="label">Revenue (booked)</div><div class="value">${fmtMoney(s.revenue)}</div></div>
      `;
    } catch (e) { toast(e.message, 'error'); }
  }

  async function loadBookings() {
    try {
      allBookings = await api('/admin/bookings');
      renderTable();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===================== RENDER TABLE =====================
  function renderTable() {
    const search = $('#searchInput').value.trim().toLowerCase();
    const status = $('#statusFilter').value;
    const date = $('#dateFilter').value;

    let filtered = allBookings.filter((b) => {
      if (status !== 'all' && b.status !== status) return false;
      if (date && b.date !== date) return false;
      if (search) {
        const hay = `${b.name} ${b.email} ${b.phone}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    const tbody = $('#bookingsBody');
    const emptyState = $('#emptyState');

    if (!filtered.length) {
      tbody.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';

    tbody.innerHTML = filtered.map((b) => `
      <tr data-id="${b.id}">
        <td>
          <div class="client-name">${escapeHtml(b.name)}</div>
          <div class="client-sub">${escapeHtml(b.email)} · ${escapeHtml(b.phone)}</div>
        </td>
        <td>${escapeHtml(b.serviceName)}</td>
        <td>${escapeHtml(b.barberName)}</td>
        <td>${fmtDate(b.date, b.time)}</td>
        <td>${fmtMoney(b.price)}</td>
        <td><span class="status-badge status-${b.status}">${b.status}</span></td>
        <td>
          <div class="row-actions">
            <select class="status-select" data-id="${b.id}">
              ${['confirmed', 'completed', 'cancelled', 'no-show'].map((s) => `<option value="${s}" ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
            <button class="icon-btn delete-btn" data-id="${b.id}" title="Delete booking">✕</button>
          </div>
        </td>
      </tr>
    `).join('');

    $$('.status-select', tbody).forEach((sel) => {
      sel.addEventListener('change', () => updateStatus(sel.dataset.id, sel.value));
    });
    $$('.delete-btn', tbody).forEach((btn) => {
      btn.addEventListener('click', () => deleteBooking(btn.dataset.id));
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function updateStatus(id, status) {
    try {
      await api(`/admin/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      const b = allBookings.find((x) => x.id === id);
      if (b) b.status = status;
      renderTable();
      loadStats();
      toast('Booking status updated', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteBooking(id) {
    if (!confirm('Delete this booking permanently? This cannot be undone.')) return;
    try {
      await api(`/admin/bookings/${id}`, { method: 'DELETE' });
      allBookings = allBookings.filter((b) => b.id !== id);
      renderTable();
      loadStats();
      toast('Booking deleted', 'success');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ===================== FILTERS =====================
  $('#searchInput').addEventListener('input', renderTable);
  $('#statusFilter').addEventListener('change', renderTable);
  $('#dateFilter').addEventListener('change', renderTable);
  $('#clearFilters').addEventListener('click', () => {
    $('#searchInput').value = '';
    $('#statusFilter').value = 'all';
    $('#dateFilter').value = '';
    renderTable();
  });
  $('#refreshBtn').addEventListener('click', loadAll);
})();
