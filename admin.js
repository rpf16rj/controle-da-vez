const $ = s => document.querySelector(s);
let csrf = null;
let toastTimer;
function toast(m) {
  $('#toast').textContent = m;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha na requisição.');
  return data;
}
async function boot() {
  const state = await api('/api/state');
  const user = state.user;
  if (!user || user.role !== 'admin') {
    $('#admin-login').hidden = false;
    $('#admin-status').textContent = user ? 'Esta conta não é admin.' : '';
    return;
  }
  csrf = user.csrf;
  $('#admin-status').textContent = `Logado como ${user.name} · atualiza sozinho a cada 5s`;
  $('#rtc-card').hidden = false;
  load();
  setInterval(load, 5000);
}
function renderRtc(st) {
  if (!st) return;
  const on = st.rtcEnabled !== false;
  $('#rtc-state').textContent = on ? 'RTC ligado' : 'RTC DESLIGADO — jogando local';
  $('#rtc-toggle-btn').textContent = on ? 'Desligar RTC' : 'Religar RTC';
  $('#rtc-toggle-btn').className = on ? 'primary' : 'primary danger';
}
function statusLabel(u) {
  if (u.role === 'admin') return 'ADMIN';
  return u.approved ? 'ATIVO' : 'BLOQUEADO';
}
async function load() {
  try {
    const st = await api('/api/state').catch(() => null);
    renderRtc(st);
    const on = st?.online;
    $('#online-now').textContent = on ? `Online agora: ${on.viewers} (${on.logged} logado${on.logged === 1 ? '' : 's'}${on.viewers - on.logged > 0 ? ` + ${on.viewers - on.logged} público` : ''})${on.names.length ? ' — ' + on.names.join(', ') : ''}` : '';
    const { users } = await api('/api/admin/users');
    const body = $('#users-body');
    body.replaceChildren(...users.map(u => {
      const tr = document.createElement('tr');
      const cells = [
        u.name,
        u.username,
        statusLabel(u),
        u.paid ? '✦' : '—',
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      const actions = document.createElement('td');
      if (u.role !== 'admin') {
        if (!u.approved) {
          const ok = document.createElement('button');
          ok.className = 'mini-btn approve';
          ok.textContent = 'Desbloquear';
          ok.addEventListener('click', () => act(u.id, 'approve'));
          actions.append(ok);
        } else {
          const no = document.createElement('button');
          no.className = 'mini-btn';
          no.textContent = 'Bloquear';
          no.addEventListener('click', () => act(u.id, 'unapprove'));
          actions.append(no);
        }
        const pw = document.createElement('button');
        pw.className = 'mini-btn';
        pw.textContent = 'Senha';
        pw.addEventListener('click', () => openPw(u));
        actions.append(pw);
        const del = document.createElement('button');
        del.className = 'mini-btn danger';
        del.textContent = 'Remover';
        del.addEventListener('click', () => {
          if (confirm(`Remover ${u.name} (${u.username})?`)) act(u.id, 'remove');
        });
        actions.append(del);
      }
      tr.append(actions);
      return tr;
    }));
    $('#users-table').hidden = users.length === 0;
  } catch (e) {
    if (e.message.includes('restrito')) { $('#admin-login').hidden = false; return; }
    $('#admin-status').textContent = e.message;
  }
}
let pwUser = null;
function openPw(u) {
  pwUser = u;
  $('#pw-title').textContent = `Nova senha — ${u.name} (${u.username})`;
  $('#pw-input').value = '';
  $('#pw-form').hidden = false;
  $('#pw-result').hidden = true;
  $('#pw-dialog').showModal();
}
$('#pw-save').addEventListener('click', async () => {
  try {
    const r = await api('/api/admin/action', { method: 'POST', body: { userId: pwUser.id, action: 'set-password', password: $('#pw-input').value || null } });
    $('#pw-new').textContent = r.password;
    $('#pw-form').hidden = true;
    $('#pw-result').hidden = false;
  } catch (e) { toast(e.message); }
});
$('#pw-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#pw-new').textContent); toast('Senha copiada.'); }
  catch { toast('Senha: ' + $('#pw-new').textContent); }
});
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).close()));
async function act(userId, action) {
  try {
    await api('/api/admin/action', { method: 'POST', body: { userId, action } });
    load();
  } catch (e) { toast(e.message); }
}
$('#rtc-toggle-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/rtc-toggle', { method: 'POST', body: {} });
    renderRtc({ rtcEnabled: r.rtcEnabled });
    toast(r.rtcEnabled ? 'RTC religado.' : 'RTC desligado — sala mostra a live do canal.');
  } catch (e) { toast(e.message); }
});
$('#admin-login-form').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/api/login', { method: 'POST', body: { username: $('#admin-user').value, password: $('#admin-pass').value } });
    location.reload();
  } catch (e2) { toast(e2.message); }
});
boot();
