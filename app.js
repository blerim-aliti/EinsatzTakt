let currentSession = null;
let company = null;
let timerInterval = null;
let clockInTime = null;
let pauseStartTime = null;
let totalPauseMs = 0;
let isPaused = false;
let currentGpsLocation = null;

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const result = response.status === 204 || !contentType.includes('application/json')
    ? {}
    : await response.json();
  if (!response.ok) {
    const error = result.error || (response.status === 404
      ? 'Das Backend ist auf dieser Website noch nicht bereitgestellt. Anmeldung und App-Funktionen sind daher noch nicht verfügbar.'
      : 'Die Anfrage ist fehlgeschlagen.');
    throw new Error(error);
  }
  return result;
}

function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function showError(error) {
  alert(error instanceof Error ? error.message : 'Ein unerwarteter Fehler ist aufgetreten.');
}

function handleNewsletterSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const button = document.getElementById('newsletter-btn');
  button.disabled = true;
  button.innerText = 'Sende...';
  fetch(form.action, {
    method: 'POST',
    body: new FormData(form),
    headers: { Accept: 'application/json' }
  }).then(response => {
    if (!response.ok) throw new Error('Die Anmeldung konnte nicht gesendet werden.');
    document.getElementById('newsletter-success').classList.remove('hidden');
    form.reset();
  }).catch(showError).finally(() => {
    button.disabled = false;
    button.innerText = 'Abonnieren';
  });
}

function handleContactSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const button = document.getElementById('contact-submit-btn');
  button.disabled = true;
  fetch(form.action, {
    method: 'POST',
    body: new FormData(form),
    headers: { Accept: 'application/json' }
  }).then(response => {
    if (!response.ok) throw new Error('Ihre Nachricht konnte nicht gesendet werden.');
    document.getElementById('contact-success-msg').classList.remove('hidden');
    form.reset();
  }).catch(showError).finally(() => {
    button.disabled = false;
  });
}

async function handleCompanyRegistration(event) {
  event.preventDefault();
  const button = document.getElementById('reg-submit-btn');
  button.disabled = true;
  button.innerText = 'Erstelle Firma...';
  const value = id => document.getElementById(id).value.trim();
  try {
    const result = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        name: value('reg-company-name'),
        branch: value('reg-company-branch'),
        street: value('reg-street'),
        city: value('reg-city'),
        phone: value('reg-phone'),
        chefName: value('reg-chef-name'),
        email: value('reg-chef-email'),
        pass: document.getElementById('reg-chef-password').value
      })
    });
    document.getElementById('success-company-code').innerText = result.code;
    document.getElementById('modal-register-company').classList.add('hidden');
    openModal('modal-reg-success');
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.innerText = 'Firma kostenfrei anlegen & Code sicher anzeigen';
  }
}

async function copyCompanyCode() {
  try {
    await navigator.clipboard.writeText(document.getElementById('success-company-code').innerText);
    alert('Firmen-Code kopiert!');
  } catch (error) {
    showError(new Error('Der Firmen-Code konnte nicht in die Zwischenablage kopiert werden.'));
  }
}

async function handleChefLogin(event) {
  event.preventDefault();
  try {
    await api('/api/login/chef', {
      method: 'POST',
      body: JSON.stringify({
        email: document.getElementById('login-chef-email').value.trim(),
        pass: document.getElementById('login-chef-pin').value
      })
    });
    closeModal('modal-chef-login');
    await loadDashboard();
  } catch (error) {
    showError(error);
  }
}

async function handleMitarbeiterLogin(event) {
  event.preventDefault();
  try {
    await api('/api/login/worker', {
      method: 'POST',
      body: JSON.stringify({
        code: document.getElementById('login-firmencode').value.trim().toUpperCase(),
        email: document.getElementById('login-worker-email').value.trim(),
        pin: document.getElementById('login-worker-pin').value
      })
    });
    closeModal('modal-mitarbeiter-login');
    await loadDashboard();
  } catch (error) {
    showError(error);
  }
}

async function loadDashboard() {
  currentSession = await api('/api/session');
  company = await api(`/api/company/${encodeURIComponent(currentSession.companyCode)}`);
  renderDashboard();
}

function renderDashboard() {
  if (!currentSession || !company) return;
  document.getElementById('app-dashboard').classList.remove('hidden');
  document.getElementById('dash-company-name').innerText = company.name;
  document.getElementById('dash-firmcode-badge').innerText = `Code: ${company.code}`;

  const workerView = document.getElementById('dash-mitarbeiter-view');
  const chefView = document.getElementById('dash-chef-view');
  const badge = document.getElementById('dash-user-badge');
  if (currentSession.role === 'chef') {
    badge.innerText = 'Inhaber';
    chefView.classList.remove('hidden');
    workerView.classList.add('hidden');
    renderChefView(company);
  } else {
    badge.innerText = `Mitarbeiter: ${currentSession.userName}`;
    chefView.classList.add('hidden');
    workerView.classList.remove('hidden');
    document.getElementById('dash-project-select').innerHTML = company.projects.map(project =>
      `<option value="${Number(project.id)}">${escapeHtml(project.name)}</option>`
    ).join('');
  }
  renderCompanyLogs(company);
  lucide.createIcons();
}

function renderChefView(data) {
  document.getElementById('dash-worker-list').innerHTML = data.workers.length
    ? data.workers.map(worker => `
      <div class="flex justify-between items-center p-2.5 bg-slate-50 rounded-xl border border-slate-200">
        <div><div class="font-bold text-slate-800">${escapeHtml(worker.name)}</div><div class="text-slate-500">${escapeHtml(worker.email)}</div></div>
        <span class="font-mono bg-emerald-100 text-emerald-700 font-bold px-2 py-0.5 rounded">PIN sicher gespeichert</span>
      </div>
    `).join('')
    : '<div class="text-slate-400">Keine Mitarbeiter vorhanden.</div>';

  document.getElementById('dash-tickets-list').innerHTML = data.tickets.length
    ? data.tickets.map(ticket => `
      <div class="p-3 bg-slate-50 rounded-xl border border-slate-200">
        <div class="flex justify-between font-bold text-slate-800"><span>${escapeHtml(ticket.subject)}</span><span class="text-[10px] text-slate-400">${escapeHtml(ticket.date)}</span></div>
        <p class="text-slate-600 text-xs mt-1">${escapeHtml(ticket.message)}</p>
        <div class="text-[10px] text-red-600 font-bold mt-1">Von: ${escapeHtml(ticket.worker)}</div>
      </div>
    `).join('')
    : '<div class="text-slate-400">Keine Support-Tickets.</div>';
}

async function addWorkerToCompany() {
  const nameInput = document.getElementById('add-worker-name');
  const emailInput = document.getElementById('add-worker-email');
  const pinInput = document.getElementById('add-worker-pin');
  try {
    await api('/api/company/worker', {
      method: 'POST',
      body: JSON.stringify({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        pin: pinInput.value
      })
    });
    nameInput.value = '';
    emailInput.value = '';
    pinInput.value = '';
    await loadDashboard();
  } catch (error) {
    showError(error);
  }
}

async function submitWorkerTicket(event) {
  event.preventDefault();
  try {
    await api('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        subject: document.getElementById('ticket-subject').value.trim(),
        message: document.getElementById('ticket-message').value.trim()
      })
    });
    alert('Ticket an Chef gesendet!');
    event.target.reset();
  } catch (error) {
    showError(error);
  }
}

function clockIn() {
  clockInTime = new Date();
  totalPauseMs = 0;
  isPaused = false;
  currentGpsLocation = null;
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(position => {
      currentGpsLocation = {
        lat: Number(position.coords.latitude.toFixed(5)),
        lng: Number(position.coords.longitude.toFixed(5))
      };
      document.getElementById('gps-status-indicator').classList.remove('hidden');
    }, () => {});
  }
  document.getElementById('btn-clock-in').disabled = true;
  document.getElementById('btn-pause').disabled = false;
  document.getElementById('btn-pause').classList.remove('opacity-50', 'cursor-not-allowed');
  document.getElementById('btn-clock-out').disabled = false;
  document.getElementById('btn-clock-out').classList.remove('opacity-50', 'cursor-not-allowed');
  timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
  if (!clockInTime || isPaused) return;
  const elapsed = Date.now() - clockInTime.getTime() - totalPauseMs;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  document.getElementById('dash-timer').innerText =
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function togglePause() {
  const buttonText = document.getElementById('btn-pause-text');
  const pauseButton = document.getElementById('btn-pause');
  if (!isPaused) {
    isPaused = true;
    pauseStartTime = new Date();
    buttonText.innerText = 'Pause beenden';
    pauseButton.classList.replace('bg-amber-500', 'bg-emerald-600');
    pauseButton.classList.replace('hover:bg-amber-600', 'hover:bg-emerald-700');
    document.getElementById('dash-timer-status').innerText = '⏸ PAUSE LÄUFT';
  } else {
    isPaused = false;
    totalPauseMs += Date.now() - pauseStartTime.getTime();
    buttonText.innerText = 'Pause starten';
    pauseButton.classList.replace('bg-emerald-600', 'bg-amber-500');
    pauseButton.classList.replace('hover:bg-emerald-700', 'hover:bg-amber-600');
    document.getElementById('dash-timer-status').innerText = 'Zeiterfassung läuft...';
  }
}

async function clockOut() {
  const button = document.getElementById('btn-clock-out');
  button.disabled = true;
  try {
    const pauseMs = totalPauseMs + (isPaused ? Date.now() - pauseStartTime.getTime() : 0);
    const hours = (Date.now() - clockInTime.getTime() - pauseMs) / 3600000;
    await api('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        projectId: Number(document.getElementById('dash-project-select').value),
        hours: Number(hours.toFixed(2)),
        pauseMins: Math.round(pauseMs / 60000),
        lat: currentGpsLocation?.lat ?? null,
        lng: currentGpsLocation?.lng ?? null
      })
    });
    clearInterval(timerInterval);
    clockInTime = null;
    totalPauseMs = 0;
    isPaused = false;
    currentGpsLocation = null;
    document.getElementById('dash-timer').innerText = '00:00:00';
    document.getElementById('dash-timer-status').innerText = 'Gespeichert!';
    document.getElementById('gps-status-indicator').classList.add('hidden');
    document.getElementById('btn-clock-in').disabled = false;
    document.getElementById('btn-pause').disabled = true;
    document.getElementById('btn-pause').classList.add('opacity-50', 'cursor-not-allowed');
    document.getElementById('btn-clock-out').classList.add('opacity-50', 'cursor-not-allowed');
    await loadDashboard();
  } catch (error) {
    showError(error);
    button.disabled = false;
  }
}

function renderCompanyLogs(data) {
  const details = document.getElementById('print-company-info');
  details.innerText = `Firma: ${data.name} | ${data.street || ''}, ${data.city || ''} | Code: ${data.code}`;
  document.getElementById('dash-logs-list').innerHTML = data.logs.length ? data.logs.map(log => {
    const hasGps = Number.isFinite(Number(log.lat)) && Number.isFinite(Number(log.lng));
    const gps = hasGps ? `${Number(log.lat)},${Number(log.lng)}` : '';
    return `
      <div class="p-3 bg-slate-50 rounded-xl border border-slate-200 flex justify-between items-center">
        <div>
          <div class="font-bold text-slate-800">${escapeHtml(log.project)}</div>
          <div class="text-slate-500">${escapeHtml(log.worker)} • ${escapeHtml(log.date)} ${log.pauseMins ? `• Pause: ${Number(log.pauseMins)} Min.` : ''}</div>
          ${hasGps ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(gps)}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-[11px] text-red-600 hover:underline font-semibold mt-1"><i data-lucide="map-pin" class="w-3 h-3"></i> GPS: ${escapeHtml(log.lat)}, ${escapeHtml(log.lng)}</a>` : ''}
        </div>
        <div class="font-mono font-bold text-red-600 text-sm">${Number(log.hours).toFixed(2)} Std.</div>
      </div>
    `;
  }).join('') : '<div class="text-slate-400 text-center py-4">Keine Arbeitszeiten protokolliert</div>';
  lucide.createIcons();
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCompanyCSV() {
  if (!company) return;
  const rows = [
    ['Datum', 'Mitarbeiter', 'Projekt', 'Stunden', 'Pause_Minuten', 'GPS_Lat', 'GPS_Lng'],
    ...company.logs.map(log => [
      log.date, log.worker, log.project, log.hours, log.pauseMins || 0, log.lat || '', log.lng || ''
    ])
  ];
  const csv = rows.map(row => row.map(csvCell).join(';')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `Zeiten_${company.code}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function logoutApp() {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
    currentSession = null;
    company = null;
    document.getElementById('app-dashboard').classList.add('hidden');
  } catch (error) {
    showError(error);
  }
}

window.addEventListener('load', async () => {
  if (!window.location.hash) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  const dateLabel = document.querySelector('[data-today-date]');
  if (dateLabel) {
    dateLabel.textContent = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short' }).format(new Date());
  }
  lucide.createIcons();
  document.getElementById('contact-form').addEventListener('submit', handleContactSubmit);
  document.getElementById('newsletter-form').addEventListener('submit', handleNewsletterSubmit);
  document.getElementById('worker-login-form').addEventListener('submit', handleMitarbeiterLogin);
  document.getElementById('chef-login-form').addEventListener('submit', handleChefLogin);
  document.getElementById('register-company-form').addEventListener('submit', handleCompanyRegistration);
  document.getElementById('worker-ticket-form').addEventListener('submit', submitWorkerTicket);

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-modal-open], [data-modal-close], [data-action]');
    if (!target) return;
    if (target.dataset.modalOpen) return openModal(target.dataset.modalOpen);
    if (target.dataset.modalClose) return closeModal(target.dataset.modalClose);
    const actions = {
      'copy-company-code': copyCompanyCode,
      'show-dashboard': async () => {
        closeModal('modal-reg-success');
        try {
          await loadDashboard();
        } catch (error) {
          showError(error);
        }
      },
      logout: logoutApp,
      'clock-in': clockIn,
      'clock-pause': togglePause,
      'clock-out': clockOut,
      'add-worker': addWorkerToCompany,
      print: () => window.print(),
      'export-csv': exportCompanyCSV
    };
    actions[target.dataset.action]?.();
  });

  try {
    await loadDashboard();
  } catch (error) {
    if (!/Nicht angemeldet|Bitte zuerst anmelden|Backend ist auf dieser Website noch nicht bereitgestellt/.test(error.message)) {
      showError(error);
    }
  }
});
