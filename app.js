'use strict';
const $ = (id) => document.getElementById(id);
const els = {
  badge: $('connectionBadge'), connectionText: $('connectionText'), setupCard: $('setupCard'), dashboard: $('dashboard'),
  apiUrl: $('apiUrl'), apiToken: $('apiToken'), connectionForm: $('connectionForm'), setupError: $('setupError'),
  activeCount: $('activeCount'), stationsAffected: $('stationsAffected'), variantValue: $('variantValue'), eventList: $('eventList'),
  producedValue: $('producedValue'), shiftLabel: $('shiftLabel'), shiftDowntimeValue: $('shiftDowntimeValue'),
  historyDate: $('historyDate'), historyShift: $('historyShift'), historyProduced: $('historyProduced'), historyDowntime: $('historyDowntime'),
  historyDowntimeCount: $('historyDowntimeCount'), historyPeriodLabel: $('historyPeriodLabel'), topicList: $('topicList'), historyResultCount: $('historyResultCount'),
  allFilterCount: $('allFilterCount'), lastUpdated: $('lastUpdated'), historyList: $('historyList'), notificationState: $('notificationState'),
  enableAlerts: $('enableAlerts'), toast: $('toast'), demoCard: $('demoCard'), modalShade: $('modalShade')
};
const STORAGE_KEY = 'smc-pulse-code-connection-v2';
let config = readConfig();
let lastStatus = null;
let hasBaseline = false;
let activeFilter = 'ALL';
let usingDemo = false;
let pollTimer = null;
let toastTimer = null;
let activeKeys = new Set();
let lastHistoryLoad = 0;

function readConfig() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; } }
function saveConfig(value) { config = value; localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); }
function cleanBaseUrl(url) { return String(url || '').trim().replace(/\/+$/, ''); }
function configuredApiBase() { return cleanBaseUrl(window.SMC_PULSE_CONFIG?.apiBaseUrl || ''); }
function apiUrl(path) { return configuredApiBase() + path; }
async function api(path, options = {}) {
  if (!configuredApiBase() || !config?.token) throw new Error('Le responsable doit configurer le bridge et fournir le code SMC.');
  const response = await fetch(apiUrl(path), {
    ...options, cache: 'no-store', headers: { 'X-SMC-Access-Code': config.token, 'Content-Type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
  });
  if (!response.ok) {
    let message = `Erreur API (${response.status})`;
    try { const body = await response.json(); message = body.detail || message; } catch {}
    throw new Error(message);
  }
  return response.json();
}
function showToast(message, ms = 2900) {
  els.toast.textContent = message; els.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}
function setConnection(connected, message) {
  els.badge.classList.toggle('connected', connected); els.badge.classList.toggle('disconnected', !connected);
  els.connectionText.textContent = message || (connected ? 'Bridge connecté' : 'Non connecté');
}
function showSetup(error = '') {
  usingDemo = false; els.dashboard.classList.add('hidden'); els.setupCard.classList.remove('hidden');
  els.setupError.textContent = error; els.demoCard.classList.remove('hidden');
  els.apiUrl.value = configuredApiBase(); if (config) els.apiToken.value = config.token || '';
  if (!configuredApiBase()) els.setupError.textContent = 'Configuration administrateur manquante : définir apiBaseUrl dans config.js puis redéployer le site.';
}
function showDashboard() { els.setupCard.classList.add('hidden'); els.dashboard.classList.remove('hidden'); els.demoCard.classList.add('hidden'); }
function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}j ${String(h).padStart(2,'0')}h`;
  if (h) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function fmtTime(value) {
  if (!value) return '--:--';
  const date = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? String(value).slice(-8) : date.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}
function stationLabel(station) {
  const map = { LOADING:'LOADING', TAPE:'TAPE STATION', CLIP:'CLIP STATION', UNLOADING:'UNLOADING', 'LOADING/UNLOADING':'LOADING / UNLOADING', LINE:'LINE' };
  return map[station] || String(station || 'LINE').replaceAll('_',' ');
}
function currentEventKey(event) { return String(event.id || `${event.station}|${event.signal}|${event.start_ts}`); }
function vibrate() { try { if ('vibrate' in navigator) navigator.vibrate([220, 90, 220, 90, 420]); } catch {} }
function triggerNotification(event) {
  const title = `Nouvel arrêt · ${stationLabel(event.station)}`;
  const body = event.root_cause || event.title || event.detail || 'Un downtime est actif.';
  vibrate();
  if ('Notification' in window && Notification.permission === 'granted') {
    try { const notification = new Notification(title, { body, icon: './icons/smc-192.png', tag: currentEventKey(event), renotify: true, vibrate: [220, 90, 220] }); notification.onclick = () => { window.focus(); notification.close(); }; } catch {}
  }
  showToast(`${title} — ${body}`, 4500);
}
function renderEvents(events) {
  const filtered = activeFilter === 'ALL' ? events : events.filter(e => e.station === activeFilter || (activeFilter === 'LOADING' && e.station === 'LOADING/UNLOADING') || (activeFilter === 'UNLOADING' && e.station === 'LOADING/UNLOADING'));
  els.allFilterCount.textContent = events.length;
  if (!filtered.length) {
    els.eventList.innerHTML = `<div class="empty-state"><div class="empty-orbit"><span>✓</span></div><h3>${events.length ? 'Aucun arrêt dans ce filtre' : 'Aucun arrêt actif'}</h3><p>${events.length ? 'Choisis une autre station.' : 'La ligne tourne sans arrêt signalé.'}</p></div>`;
    return;
  }
  els.eventList.innerHTML = filtered.map((e) => {
    const type = String(e.type || 'DOWNTIME').toUpperCase();
    const className = type === 'WARNING' ? 'warning' : type === 'VALIDATION' ? 'validation' : 'downtime';
    const title = e.title || e.description || stationLabel(e.station);
    const cause = e.root_cause || e.detail || e.category || 'Cause en cours d’analyse';
    const action = e.action ? `<div class="event-action">↳ ${escapeHtml(e.action)}</div>` : '';
    return `<article class="event-card ${className}" data-event-key="${escapeHtml(currentEventKey(e))}">
      <div class="event-head"><span class="station-pill">${escapeHtml(stationLabel(e.station))}</span><span class="severity-dot" title="${escapeHtml(e.severity || type)}"></span></div>
      <h3 class="event-title">${escapeHtml(title)}</h3><div class="event-cause">${escapeHtml(cause)}</div>
      <div class="duration-block"><div><div class="duration-label">Durée actuelle</div><div class="duration-time" data-duration-start="${escapeHtml(e.start_ts || '')}" data-duration-offset="${Number(e.duration_sec || 0)}">${fmtDuration(e.duration_sec)}</div></div><div class="event-time">Depuis<br><strong>${fmtTime(e.start_ts)}</strong></div></div>${action}
    </article>`;
  }).join('');
}
function localDateInputValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function renderCurrentShiftSummary(summary) {
  if (!summary) return;
  els.producedValue.textContent = Number(summary.produced || 0).toLocaleString();
  els.shiftDowntimeValue.textContent = fmtDuration(summary.downtime_sec || 0);
  els.shiftLabel.textContent = `${summary.shift || 'Shift actuel'} · ${fmtTime(summary.start_ts)}–${fmtTime(summary.end_ts)}`;
}
function renderAnalytics(data) {
  els.historyProduced.textContent = Number(data.produced || 0).toLocaleString();
  els.historyDowntime.textContent = fmtDuration(data.downtime_sec || 0);
  els.historyDowntimeCount.textContent = Number(data.downtime_events || 0).toLocaleString();
  els.historyPeriodLabel.textContent = `${data.date || ''} · ${data.shift || 'Période'} · ${fmtTime(data.start_ts)}–${fmtTime(data.end_ts)}`;
  const topics = data.top_topics || [];
  if (!topics.length) {
    els.topicList.innerHTML = '<p class="muted" style="padding:10px 0">Aucun downtime classifié sur cette période.</p>';
  } else {
    const max = Math.max(...topics.map(t => Number(t.seconds || 0)), 1);
    els.topicList.innerHTML = topics.map((topic, index) => {
      const pct = Math.max(3, Math.round(Number(topic.seconds || 0) / max * 100));
      return `<div class="topic-row"><div class="topic-row-head"><span><b>${index+1}.</b> ${escapeHtml(topic.name || 'Cause non renseignée')}</span><strong>${fmtDuration(topic.seconds || 0)}</strong></div><div class="topic-track"><span style="width:${pct}%"></span></div><div class="topic-meta">${escapeHtml(topic.category || 'Catégorie non renseignée')} · ${Number(topic.count || 0)} événement(s)</div></div>`;
    }).join('');
  }
  renderHistory((data.events || []).slice(0, 100));
  els.historyResultCount.textContent = `${Math.min((data.events || []).length, 100)} événement(s) affiché(s)`;
}
async function loadAnalytics() {
  if (!configuredApiBase() || !config?.token || usingDemo) return;
  const selectedDate = els.historyDate.value || localDateInputValue();
  const selectedShift = els.historyShift.value || 'ALL';
  const query = `period=custom&date=${encodeURIComponent(selectedDate)}&shift=${encodeURIComponent(selectedShift)}`;
  try {
    const data = await api(`/api/analytics?${query}`);
    renderAnalytics(data);
    lastHistoryLoad = Date.now();
  } catch (error) {
    els.historyList.innerHTML = `<p class="muted" style="padding:14px">Historique indisponible : ${escapeHtml(error.message)}</p>`;
  }
}
function renderHistory(events) {
  if (!events?.length) { els.historyList.innerHTML = '<p class="muted" style="padding:14px">Aucun événement dans l’historique.</p>'; return; }
  els.historyList.innerHTML = events.map(e => {
    const title = e.root_cause || e.detail || e.title || e.signal || 'Downtime';
    const duration = e.duration_sec == null ? (e.is_active ? 'En cours' : '—') : fmtDuration(e.duration_sec);
    return `<div class="history-row"><div><div class="history-title">${escapeHtml(stationLabel(e.station))} · ${escapeHtml(title)}</div><div class="history-sub">${fmtTime(e.start_ts)}${e.end_ts ? ' → ' + fmtTime(e.end_ts) : ''}${e.variant ? ' · ' + escapeHtml(e.variant) : ''}</div></div><div class="history-right"><div class="history-duration">${duration}</div><span class="history-status ${e.is_active ? 'active' : ''}">${e.is_active ? 'ACTIF' : 'TERMINÉ'}</span></div></div>`;
  }).join('');
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function notifyNewEvents(events) {
  const current = new Set(events.map(currentEventKey));
  if (hasBaseline && !usingDemo) {
    events.filter(e => !activeKeys.has(currentEventKey(e))).forEach(triggerNotification);
  }
  activeKeys = current; hasBaseline = true;
}
async function refreshStatus({history = false} = {}) {
  if (usingDemo) { tickDemo(); return; }
  if (!configuredApiBase() || !config?.token) { setConnection(false); return; }
  try {
    const data = await api('/api/status');
    lastStatus = data; setConnection(Boolean(data.plc_online), data.plc_online ? 'PLC en ligne' : 'PLC hors ligne');
    showDashboard();
    const events = data.active_downtimes || [];
    notifyNewEvents(events);
    els.activeCount.textContent = String(events.length);
    const stations = [...new Set(events.map(e => stationLabel(e.station)))];
    els.stationsAffected.textContent = stations.length ? `${stations.length} station${stations.length > 1 ? 's' : ''} concernée${stations.length > 1 ? 's' : ''}` : 'Aucune station';
    els.variantValue.textContent = data.variant || '—';
    renderCurrentShiftSummary(data.current_shift_summary);
    els.lastUpdated.textContent = `Mis à jour ${fmtTime(data.server_time || data.last_update)} · ${data.plc_online ? 'PLC OK' : 'Vérifier PLC'}`;
    renderEvents(events);
    if (history || Date.now() - lastHistoryLoad > 20000) { await loadAnalytics(); }
    updateNotificationText();
  } catch (error) {
    setConnection(false, 'Bridge indisponible');
    els.lastUpdated.textContent = `Pas de liaison · ${error.message}`;
    if (!lastStatus) { showSetup(''); }
  }
}
function updateLiveDurations() {
  document.querySelectorAll('[data-duration-start]').forEach(el => {
    const startStr = el.dataset.durationStart;
    if (!startStr) return;
    const parsed = new Date(startStr.replace(' ', 'T')).getTime();
    if (!Number.isNaN(parsed)) el.textContent = fmtDuration((Date.now() - parsed) / 1000);
  });
}
function startPolling() { clearInterval(pollTimer); refreshStatus({history:true}); pollTimer = setInterval(() => refreshStatus(), 5000); }
async function connect(event) {
  event?.preventDefault();
  const url = configuredApiBase(), token = els.apiToken.value.trim();
  if (!url) { els.setupError.textContent = 'Le responsable doit renseigner apiBaseUrl dans config.js puis redéployer.'; return; }
  if (!/^https:\/\//i.test(url) && !/^http:\/\/localhost(?::\d+)?$/i.test(url)) { els.setupError.textContent = 'Le bridge doit utiliser une adresse HTTPS.'; return; }
  if (token.length < 8) { els.setupError.textContent = 'Le code doit contenir au moins 8 caractères.'; return; }
  els.setupError.textContent = 'Test de connexion…';
  const old = config; config = {url, token};
  try {
    const health = await api('/api/status');
    saveConfig({url, token}); hasBaseline = false; activeKeys = new Set(); lastStatus = health;
    els.setupError.textContent = ''; showDashboard(); startPolling(); showToast('Connexion SMC réussie');
  } catch (error) { config = old; els.setupError.textContent = `Connexion impossible : ${error.message}`; }
}
async function enableAlerts() {
  if (!('Notification' in window)) { showToast('Les notifications ne sont pas prises en charge dans ce navigateur.'); return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { showToast('Push en arrière-plan non pris en charge. Les alertes marchent quand cette page est ouverte.'); }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') { updateNotificationText(); showToast('Autorisation notification refusée.'); return; }
  updateNotificationText();
  vibrate();
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { showToast('Alertes à l’écran activées'); return; }
  try {
    const pc = await api('/api/push-config');
    if (!pc.enabled || !pc.public_key) { showToast('Notifications locales activées. Push en arrière-plan à configurer sur le PC SMC.'); return; }
    const registration = await navigator.serviceWorker.register('./sw.js', {scope:'./'});
    await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:base64ToBytes(pc.public_key)});
    await api('/api/push-subscriptions', {method:'POST', body:JSON.stringify(subscription)});
    localStorage.setItem('smc-pulse-push-enabled', '1');
    showToast('Notifications en arrière-plan activées'); updateNotificationText();
  } catch (error) { showToast(`Push non activé : ${error.message}`); }
}
function updateNotificationText() {
  const allowed = 'Notification' in window && Notification.permission === 'granted';
  const pushEnabled = localStorage.getItem('smc-pulse-push-enabled') === '1';
  els.enableAlerts.textContent = pushEnabled ? 'Activées ✓' : allowed ? 'Activer push' : 'Activer';
  els.notificationState.textContent = pushEnabled ? 'Les notifications push sont activées, même si tu quittes la page (tant que le PC SMC et le bridge tournent).' : allowed ? 'Notifications autorisées. Active le push pour les alertes en arrière-plan.' : 'Active les notifications pour être averti d’un nouvel arrêt.';
}
function base64ToBytes(base64) { const padded = base64 + '='.repeat((4 - base64.length % 4) % 4); const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/')); const out = new Uint8Array(raw.length); for (let i=0;i<raw.length;i++) out[i] = raw.charCodeAt(i); return out; }
async function disablePush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('./');
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) { try { await api('/api/push-subscriptions', {method:'DELETE', body:JSON.stringify({endpoint:sub.endpoint})}); } catch {} await sub.unsubscribe(); }
  } catch {}
  localStorage.removeItem('smc-pulse-push-enabled'); updateNotificationText(); showToast('Alertes push désactivées');
}
function showDemo() {
  usingDemo = true; hasBaseline = true; activeKeys = new Set(); showDashboard(); els.demoCard.classList.add('hidden'); setConnection(true, 'Mode aperçu');
  els.activeCount.textContent='2'; els.stationsAffected.textContent='2 stations concernées'; els.variantValue.textContent='5B93251';
  els.producedValue.textContent='248'; els.shiftLabel.textContent='Shift 2 · aperçu'; els.shiftDowntimeValue.textContent='00:12:00';
  els.historyProduced.textContent='248'; els.historyDowntime.textContent='00:12:00'; els.historyDowntimeCount.textContent='3';
  els.historyPeriodLabel.textContent='Mode aperçu — données fictives';
  els.topicList.innerHTML="<p class='muted'>Exemples fictifs : Position non atteinte · Détection capteur · Alimentation matière</p>";
  const now = new Date(); const earlier = new Date(now.getTime()-7*60000).toISOString().slice(0,19).replace('T',' '); const later = new Date(now.getTime()-3*60000).toISOString().slice(0,19).replace('T',' ');
  renderEvents([{id:'demo-1',station:'TAPE',title:'Tape station stopped',type:'DOWNTIME',severity:'High',root_cause:'Chamber rotation position not reached',detail:'Arrêt détecté — exemple uniquement',action:'Open gate and check chamber rotate',start_ts:earlier,duration_sec:420,variant:'5B93251'}, {id:'demo-2',station:'CLIP',title:'Robot 2 stopped at branch',type:'DOWNTIME',severity:'High',root_cause:'Chamber rotator 1 position not reached',detail:'Arrêt détecté — exemple uniquement',start_ts:later,duration_sec:180,variant:'5B93251'}]);
  els.lastUpdated.textContent='Mode aperçu — données fictives'; els.historyList.innerHTML='<p class="muted" style="padding:14px">Les données d’aperçu ne viennent pas de la machine.</p>'; clearInterval(pollTimer); showToast('Mode aperçu : aucun PLC connecté');
}
function tickDemo() { updateLiveDurations(); }
function openSettings() { els.modalShade.classList.remove('hidden'); }
function closeSettings() { els.modalShade.classList.add('hidden'); }
function setupInitial() { if (els.historyDate) els.historyDate.value = localDateInputValue(); if (config?.token && configuredApiBase()) { els.apiUrl.value=configuredApiBase(); els.apiToken.value=config.token; showDashboard(); startPolling(); } else showSetup(); updateNotificationText(); }

els.connectionForm.addEventListener('submit', connect);
$('toggleToken').addEventListener('click', () => { const show=els.apiToken.type==='password'; els.apiToken.type=show?'text':'password'; $('toggleToken').textContent=show?'Cacher':'Voir'; });
$('settingsButton').addEventListener('click', openSettings); $('closeSettings').addEventListener('click', closeSettings);
els.modalShade.addEventListener('click', e => { if (e.target===els.modalShade) closeSettings(); });
$('editConnection').addEventListener('click', () => { closeSettings(); showSetup(); setConnection(false,'Configuration'); });
$('disableAlerts').addEventListener('click', disablePush);
$('disconnectButton').addEventListener('click', async () => { await disablePush(); localStorage.removeItem(STORAGE_KEY); config=null; lastStatus=null; hasBaseline=false; clearInterval(pollTimer); closeSettings(); setConnection(false); showSetup(); showToast('Téléphone déconnecté'); });
els.enableAlerts.addEventListener('click', enableAlerts);
$('refreshButton').addEventListener('click', () => { $('refreshButton').classList.add('busy'); refreshStatus({history:true}).finally(() => setTimeout(()=>$('refreshButton').classList.remove('busy'),450)); });
$('historyRefresh').addEventListener('click', () => loadAnalytics());
$('applyHistoryFilter').addEventListener('click', () => loadAnalytics());
els.historyDate.addEventListener('change', () => loadAnalytics());
els.historyShift.addEventListener('change', () => loadAnalytics());
$('demoButton').addEventListener('click', showDemo);
$('filterRow').addEventListener('click', e => { const btn=e.target.closest('[data-station]'); if (!btn) return; activeFilter=btn.dataset.station; document.querySelectorAll('.filter-chip').forEach(b=>b.classList.toggle('active',b===btn)); renderEvents(lastStatus?.active_downtimes || []); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus({history:true}); });
setInterval(updateLiveDurations, 1000);
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
setupInitial();
