'use strict';

const app = document.querySelector('#app');
const state = { user: null, page: 'leads', leads: [], stats: { closers: [], totals: {} }, followups: { leads: [] }, search: '', status: '', closer: '', pagination: 1, error: '', loading: false, refreshedAt: null };
let requestVersion = 0;
const TIMEZONE = 'Europe/Riga';
const PAGE_SIZE = 10;
const labels = { new: 'New lead', booked: 'Booked', rescheduled: 'Rescheduled', cancelled: 'Cancelled', met: 'Showed', no_show: 'No-show' };
const icons = {
  inbox: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 13h5l2 3h4l2-3h5"/>',
  chart: '<path d="M4 4v16h17M8 15v-4m5 4V7m5 8V4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18m-13 5h2m4 0h2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  chevronLeft: '<path d="m15 5-7 7 7 7"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  logout: '<path d="M9 5H4v14h5m5-14 7 7-7 7m-5-7h12"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  phone: '<path d="m8 3 2 5-3 2a14 14 0 0 0 7 7l2-3 5 2v4c-10 3-20-7-17-17h4Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>'
};
const icon = (name, cls = '') => `<svg ${cls ? `class="${cls}"` : ''} aria-hidden="true" viewBox="0 0 24 24">${icons[name] || icons.inbox}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const initials = name => String(name || '?').trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
const avatar = (name, index = 0) => `<span class="avatar avatar-${Math.abs(index) % 5}">${esc(initials(name))}</span>`;
const statusPill = status => `<span class="status status-${Object.hasOwn(labels, status) ? status : 'new'}">${esc(labels[status] || status || 'New lead')}</span>`;
const dateFormat = (value, options = {}) => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, ...options }).format(new Date(value));
};
const shortDate = value => dateFormat(value, { day: 'numeric', month: 'short' });
const time = value => dateFormat(value, { hour: '2-digit', minute: '2-digit', hour12: false });
const fullDate = value => dateFormat(value, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dueDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? dateFormat(`${value}T12:00:00Z`, { day: 'numeric', month: 'long' }) : fullDate(value);
const rate = value => value === null || value === undefined ? '—' : `${Number(value).toFixed(1).replace(/\.0$/, '')}%`;
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const brand = () => `<div class="brand"><span class="brand-mark">${icon('inbox')}</span>Lead Inbox</div>`;

async function api(path, options = {}) {
  const requestUser = state.user?.email;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unexpected response. Please try again.'); }
  if (!response.ok) {
    if (response.status === 401 && state.user && state.user.email === requestUser) {
      requestVersion++;
      state.loading = false;
      state.user = null;
      renderLogin('Your session has ended. Please sign in again.');
    }
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('visible'), 4000);
}

function renderLogin(error = '') {
  document.title = 'Sign in · Lead Inbox';
  app.innerHTML = `<main class="login">
    <section class="login-story" aria-label="Welcome to Lead Inbox">
      ${brand()}
      <div class="login-story-content">
        <p class="login-eyebrow">A LITTLE LESS ADMIN. A LOT MORE HUMAN.</p>
        <h1>Every lead.<br>Every meeting.<br><span>Your next move.</span></h1>
        <p class="story-description">A calmer place to keep your conversations moving. From the first hello to the meeting that matters.</p>
        <div class="story-card" aria-hidden="true">
          <div class="story-card-top"><span class="avatar">JS</span><div><strong>Jamie Sullivan</strong><small>Your next conversation</small></div><span class="check">${icon('check')}</span></div>
          <div class="story-card-line"><span>One place. Nothing missed.</span><span class="story-card-status">Ready to connect</span></div>
        </div>
      </div>
      <p class="login-story-footer">BUILT FOR FOCUSED TEAMS & THOUGHTFUL FOLLOW-UPS.</p>
    </section>
    <section class="login-form-side">
      <div class="login-form-wrap">
        <p class="welcome-eyebrow">YOUR WORKSPACE, READY WHEN YOU ARE</p>
        <h2>Good to see you.</h2>
        <p class="subtitle">Sign in to pick up the conversation.</p>
        <div id="login-error" role="alert">${error ? `<p class="form-error">${esc(error)}</p>` : ''}</div>
        <form id="login-form">
          <div class="form-field"><label class="field-label" for="email">Email address</label><input class="form-input" id="email" name="email" type="email" autocomplete="username" placeholder="you@company.com" value="a@leadinbox.demo" required></div>
          <div class="form-field"><label class="field-label" for="password">Password</label><div class="password-wrap"><input class="form-input" id="password" name="password" type="password" autocomplete="current-password" value="LeadInbox2026!" required><button class="icon-button" type="button" data-action="toggle-password" aria-label="Show password">${icon('eye')}</button></div></div>
          <button class="button button-primary login-submit full" id="login-submit" type="submit">Sign in to your workspace ${icon('arrow')}</button>
        </form>
        <div class="login-divider">EXPLORE THE DEMO</div>
        <div class="demo-buttons">
          <button class="demo-button selected" type="button" data-action="demo-account" data-company="a"><span class="demo-letter">A</span><span><strong>Company A</strong><small>Open demo account</small></span></button>
          <button class="demo-button" type="button" data-action="demo-account" data-company="b"><span class="demo-letter">B</span><span><strong>Company B</strong><small>Open demo account</small></span></button>
        </div>
        <p class="login-security">${icon('shield')}<span>Each company has its own private workspace.<br>This demo uses generated sample data.</span></p>
      </div>
    </section>
  </main>`;
}

function sidebar() {
  const company = state.user.companyName || `Company ${state.user.companyId}`;
  const companyLetter = company.match(/[AB]$/)?.[0] || initials(company);
  return `<aside class="sidebar">${brand()}
    <div class="workspace-switch"><span class="workspace-avatar">${esc(companyLetter)}</span><div><strong>${esc(company)}</strong><span class="small">Team workspace</span></div>${icon('chevronDown')}</div>
    <p class="nav-label">WORKSPACE</p>
    <nav class="nav" aria-label="Main navigation">
      <button class="nav-button ${state.page === 'leads' ? 'active' : ''}" data-action="navigate" data-page="leads" ${state.page === 'leads' ? 'aria-current="page"' : ''}>${icon('inbox')}<span>Lead inbox</span><span class="nav-count">${state.leads.length}</span></button>
      <button class="nav-button ${state.page === 'stats' ? 'active' : ''}" data-action="navigate" data-page="stats" ${state.page === 'stats' ? 'aria-current="page"' : ''}>${icon('chart')}<span>Team performance</span></button>
      <button class="nav-button ${state.page === 'followups' ? 'active' : ''}" data-action="navigate" data-page="followups" ${state.page === 'followups' ? 'aria-current="page"' : ''}>${icon('clock')}<span>Follow-ups</span><span class="nav-count">${state.followups.leads.length}</span></button>
    </nav>
    <div class="sidebar-bottom"><div class="demo-note">${icon('spark')}<strong>A clear view of what’s next.</strong><p>Your leads, meetings, and follow-ups.<br>All in one little inbox.</p></div>
    <div class="user-box"><span class="user-avatar">${esc(companyLetter)}</span><div><strong>${esc(company)} admin</strong><small>${esc(state.user.email)}</small></div><button class="icon-button" data-action="logout" title="Sign out" aria-label="Sign out">${icon('logout')}</button></div></div>
  </aside>`;
}

function renderShell() {
  if (!state.user) return;
  const company = state.user.companyName || `Company ${state.user.companyId}`;
  const pageLabel = { leads: 'Lead inbox', stats: 'Team performance', followups: 'Follow-ups' }[state.page];
  document.title = `${pageLabel} · ${company} · Lead Inbox`;
  app.innerHTML = `<div class="app-shell">${sidebar()}<main class="main" id="main-content">
    <header class="topbar"><div class="breadcrumb">Workspace ${icon('chevron')}<strong>${esc(pageLabel)}</strong></div>
      <div class="topbar-right"><span class="environment-tag">DEMO WORKSPACE</span><span class="date-label">${dateFormat(new Date(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
      <div class="mobile-topbar">${brand()}<div class="mobile-company">${esc(company)}<button class="icon-button" data-action="logout" aria-label="Sign out">${icon('logout')}</button></div></div>
    </header><div class="content" id="content"></div>
  </main></div>${state.loading ? '<div class="loading-bar" role="progressbar" aria-label="Loading workspace"></div>' : ''}`;
  renderContent();
}

function metric(label, value, note, iconName, highlight = false) {
  return `<article class="metric${highlight ? ' highlight' : ''}"><div class="metric-top"><span class="metric-label">${esc(label)}</span><span class="metric-icon">${icon(iconName)}</span></div><p class="metric-value">${esc(value)}</p><p class="metric-foot${highlight ? ' accent' : ''}">${esc(note)}</p></article>`;
}

function overviewMetrics() {
  const upcoming = state.leads.filter(lead => lead.nextMeetingAt).length;
  return `<div class="metric-grid">${metric('Total leads', state.leads.length, 'One person, one lead', 'users')}${metric('Upcoming meetings', upcoming, 'The next conversations', 'calendar')}${metric('Follow-ups due', state.followups.leads.length, 'Ready for a little nudge', 'clock', true)}${metric('Show rate', rate(state.stats.totals.showRate), 'Of resolved meetings', 'chart')}</div>`;
}

function renderContent() {
  const element = document.querySelector('#content');
  if (!element) return;
  const error = state.error ? `<div class="error-banner" role="alert"><span>${esc(state.error)}</span><button class="button button-link" data-action="refresh">Try again</button></div>` : '';
  const footer = `<footer class="main-footer"><span class="footer-note">${icon('lock')}Only your company’s data. Always.</span><span>Meeting times in Europe/Riga <span class="footer-accent">·</span> Generated demo data</span></footer>`;
  if (state.page === 'leads') {
    element.innerHTML = `${error}<div class="page-heading"><div><div class="heading-title"><h1>Lead inbox</h1><span class="heading-count">${state.leads.length}</span></div><p class="page-subtitle">Every conversation, with a clear next step.</p></div><div class="heading-actions"><button class="button button-secondary" data-action="refresh" aria-label="Refresh workspace" title="Refresh workspace">${icon('refresh')}<span class="refresh-label">Refresh</span></button><button class="button button-primary" data-action="open-import">${icon('upload')}Import data</button></div></div>
    ${overviewMetrics()}<section class="panel" aria-labelledby="leads-heading"><div class="panel-header"><div><h2 class="panel-heading" id="leads-heading">All your leads</h2><p class="panel-description">A good conversation starts with a little context.</p></div></div><div class="toolbar">
      <label class="search-box">${icon('search')}<span class="sr-only">Search leads by name, email or phone</span><input id="lead-search" type="search" placeholder="Search name, email, or phone…" value="${esc(state.search)}"></label>
      <label class="sr-only" for="status-filter">Filter by status</label><select class="filter-select" id="status-filter"><option value="">All statuses</option>${Object.entries(labels).map(([value,label]) => `<option value="${value}" ${state.status === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>
      <label class="sr-only" for="closer-filter">Filter by closer</label><select class="filter-select" id="closer-filter"><option value="">All closers</option>${[...new Set(state.leads.map(lead => lead.closer).filter(Boolean))].sort().map(closer => `<option value="${esc(closer)}" ${state.closer === closer ? 'selected' : ''}>${esc(closer)}</option>`).join('')}<option value="__unassigned" ${state.closer === '__unassigned' ? 'selected' : ''}>Unassigned</option></select>
      <span class="toolbar-end">${icon('shield')}Company data only</span>
    </div><div id="lead-results"></div></section>${footer}`;
    renderLeadResults();
  } else if (state.page === 'stats') {
    const totals = state.stats.totals;
    element.innerHTML = `${error}<div class="page-heading"><div><h1>Team performance</h1><p class="page-subtitle">A shared view of your team’s conversations.</p></div><button class="button button-secondary" data-action="refresh">${icon('refresh')}Refresh</button></div>
    <div class="metric-grid">${metric('Meetings booked', totals.booked || 0, 'Unique meetings, all time', 'calendar')}${metric('Showed up', totals.showed || 0, 'Conversations that happened', 'check')}${metric('No-shows', totals.noShow || 0, 'Missed conversations', 'clock')}${metric('Team show rate', rate(totals.showRate), 'Of resolved meetings', 'chart', true)}</div>
    <section class="panel" aria-labelledby="performance-heading"><div class="panel-header"><div><h2 class="panel-heading" id="performance-heading">The people behind the meetings</h2><p class="panel-description">All-time results for ${esc(state.user.companyName || `Company ${state.user.companyId}`)}.</p></div></div>
    ${state.stats.closers.length ? `<div class="table-wrap"><table class="performance-table"><thead><tr><th scope="col">Closer</th><th scope="col">Booked</th><th scope="col">Showed</th><th scope="col">No-show</th><th scope="col">Show rate</th></tr></thead><tbody>${state.stats.closers.map((closer,index) => `<tr><td><div class="person">${avatar(closer.closer,index)}<div><div class="person-name">${esc(closer.closer || 'Unassigned')}</div><div class="person-email">${esc(state.user.companyName || 'Your team')}</div></div></div></td><td class="number">${esc(closer.booked)}</td><td class="number">${esc(closer.showed)}</td><td class="number">${esc(closer.noShow || 0)}</td><td><div class="rate"><div class="rate-track" aria-hidden="true"><div class="rate-fill" style="width:${Math.max(0,Math.min(100,Number(closer.showRate)||0))}%"></div></div><span class="rate-number">${rate(closer.showRate)}</span></div></td></tr>`).join('')}</tbody></table></div>` : emptyState('chart', 'Your team’s story starts here.', 'Import leads and booking events to see results for each closer.')}</section>
    <div class="formula-note">${icon('info')}<span><strong>A fair view of attendance.</strong> Show rate = showed ÷ (showed + no-shows). Future and cancelled meetings don’t affect attendance. Rescheduling the same meeting doesn’t count as a new booking. A dash means no resolved meetings yet.</span></div>${footer}`;
  } else {
    const date = state.followups.date ? dateFormat(`${state.followups.date}T12:00:00+02:00`, { weekday: 'long', day: 'numeric', month: 'long' }) : dateFormat(new Date(), { weekday: 'long', day: 'numeric', month: 'long' });
    element.innerHTML = `${error}<div class="page-heading"><div><div class="heading-title"><h1>Follow-ups</h1><span class="heading-count">${state.followups.leads.length}</span></div><p class="page-subtitle">A little nudge can start a great conversation.</p></div><button class="button button-secondary" data-action="refresh">${icon('refresh')}Refresh</button></div>
    <div class="followup-intro"><div><strong>Your list for ${esc(date)}</strong><p>Due today or overdue, with no upcoming meeting. This queue is ready for your review; no messages are sent automatically.</p></div>${icon('clock')}</div>
    ${state.followups.leads.length ? `<div class="followup-list">${state.followups.leads.map((lead,index) => `<article class="followup-card"><div class="followup-top"><div class="person">${avatar(lead.name,index)}<div><h2 class="person-name">${esc(lead.name)}</h2><p class="person-email">${esc(lead.email || 'No email provided')}</p></div></div>${statusPill(lead.status)}</div><p class="followup-reason">${esc(readableReason(lead.reason))}</p><p class="followup-meta">Due ${esc(lead.dueAt ? dueDate(lead.dueAt) : 'today')} · ${esc(lead.closer || 'Unassigned')}</p><div class="followup-bottom"><a class="button button-secondary" href="tel:${esc(String(lead.phone || '').replace(/[^+\d]/g,''))}">${icon('phone')}${esc(lead.phone || 'No phone')}</a><button class="button button-link" data-action="lead-detail" data-id="${esc(lead.id)}">View lead ${icon('arrow')}</button></div></article>`).join('')}</div>` : `<section class="panel">${emptyState('check','You’re all caught up.','There are no follow-ups due today. Your next conversations are in good hands.')}</section>`}${footer}`;
  }
}

function readableReason(reason) {
  const descriptions = { new: 'New lead waiting for a first conversation.', new_lead: 'New lead waiting for a first conversation.', no_booking: 'No meeting booked yet. A good time to reach out.', cancelled: 'Meeting cancelled. Reach out to find another time.', no_show: 'Missed their meeting. Check in and offer a fresh time.', met: 'Meeting completed. Continue the conversation.', post_meeting: 'Meeting completed. Continue the conversation.', stale: 'The conversation has gone quiet. Check in today.' };
  return descriptions[reason] || String(reason || 'Ready for a follow-up.').replace(/_/g,' ');
}

function emptyState(iconName, title, description) {
  return `<div class="empty"><div class="empty-icon">${icon(iconName)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
}

function filteredLeads() {
  const search = normalize(state.search.trim());
  return state.leads.filter(lead => (!search || normalize(`${lead.name} ${lead.email} ${lead.phone}`).includes(search)) && (!state.status || lead.status === state.status) && (!state.closer || (state.closer === '__unassigned' ? !lead.closer : lead.closer === state.closer)));
}

function renderLeadResults() {
  const element = document.querySelector('#lead-results');
  if (!element) return;
  const results = filteredLeads();
  const totalPages = Math.max(1,Math.ceil(results.length / PAGE_SIZE));
  state.pagination = Math.min(state.pagination,totalPages);
  const start = (state.pagination - 1) * PAGE_SIZE;
  const page = results.slice(start,start + PAGE_SIZE);
  if (!results.length) {
    element.innerHTML = emptyState('inbox', state.leads.length ? 'No leads match just yet.' : 'A fresh inbox, ready for leads.', state.leads.length ? 'Try another name, or clear your filters to see everyone.' : 'Import the sample files or your own data to bring your conversations together.') + (state.leads.length ? '<div style="text-align:center;padding-bottom:25px"><button class="button button-secondary" data-action="clear-filters">Clear filters</button></div>' : '<div style="text-align:center;padding-bottom:25px"><button class="button button-primary" data-action="open-import">Import your first leads</button></div>');
    return;
  }
  element.innerHTML = `<div class="table-wrap lead-table"><table><thead><tr><th scope="col">Lead</th><th scope="col" class="phone-column">Phone</th><th scope="col">Status</th><th scope="col">Next meeting</th><th scope="col">Closer</th><th scope="col"><span class="sr-only">Details</span></th></tr></thead><tbody>${page.map((lead,index) => `<tr class="lead-row" data-action="lead-detail" data-id="${esc(lead.id)}"><td><div class="person">${avatar(lead.name,start+index)}<div><div class="person-name">${esc(lead.name)}</div><div class="person-email">${esc(lead.email || 'No email provided')}</div></div></div></td><td class="phone phone-column">${esc(lead.phone || '—')}</td><td>${statusPill(lead.status)}</td><td>${lead.nextMeetingAt ? `<div class="meeting-date">${esc(shortDate(lead.nextMeetingAt))}</div><div class="meeting-time">${esc(time(lead.nextMeetingAt))} · Riga</div>` : '<span class="no-meeting">—</span>'}</td><td><div class="closer"><span class="closer-avatar">${esc(initials(lead.closer || '—'))}</span>${esc(lead.closer || 'Unassigned')}</div></td><td><button class="icon-button" data-action="lead-detail" data-id="${esc(lead.id)}" aria-label="View ${esc(lead.name)}">${icon('chevron','row-arrow')}</button></td></tr>`).join('')}</tbody></table></div>
    <div class="lead-cards">${page.map((lead,index) => `<article class="lead-card" data-action="lead-detail" data-id="${esc(lead.id)}"><div class="lead-card-top"><div class="person">${avatar(lead.name,start+index)}<div><h3 class="person-name">${esc(lead.name)}</h3><p class="person-email">${esc(lead.email || 'No email provided')}</p></div></div>${statusPill(lead.status)}</div><div class="lead-card-bottom"><span class="phone">${esc(lead.phone || 'No phone provided')}</span><span class="lead-card-date">${icon('calendar')}${lead.nextMeetingAt ? `${esc(shortDate(lead.nextMeetingAt))}, ${esc(time(lead.nextMeetingAt))}` : 'No upcoming meeting'}</span></div><div class="lead-card-meta"><span class="closer"><span class="closer-avatar">${esc(initials(lead.closer || '—'))}</span>${esc(lead.closer || 'Unassigned')}</span><button class="button button-link" data-action="lead-detail" data-id="${esc(lead.id)}" aria-label="View ${esc(lead.name)}" style="font-size:9px;padding:2px 0">View details ${icon('arrow')}</button></div></article>`).join('')}</div>
    <div class="table-footer"><span>Showing ${start+1}–${Math.min(start+PAGE_SIZE,results.length)} of ${results.length} leads</span><div class="pagination"><button class="page-button" data-action="paginate" data-page="${state.pagination-1}" aria-label="Previous page" ${state.pagination <= 1 ? 'disabled' : ''}>${icon('chevronLeft')}</button>${Array.from({length:totalPages},(_,index) => `<button class="page-button ${state.pagination === index+1 ? 'active' : ''}" data-action="paginate" data-page="${index+1}" aria-label="Page ${index+1}" ${state.pagination === index+1 ? 'aria-current="page"' : ''}>${index+1}</button>`).join('')}<button class="page-button" data-action="paginate" data-page="${state.pagination+1}" aria-label="Next page" ${state.pagination >= totalPages ? 'disabled' : ''}>${icon('chevron')}</button></div></div>`;
}

async function refresh({ notify = false } = {}) {
  if (!state.user) return;
  const version = ++requestVersion;
  state.loading = true;
  state.error = '';
  renderShell();
  try {
    const [leads, stats, followups] = await Promise.all([api('/api/leads'),api('/api/stats'),api('/api/follow-ups')]);
    if (!state.user || version !== requestVersion) return;
    state.leads = leads.leads || [];
    state.stats = { closers: stats.closers || [], totals: stats.totals || {} };
    state.followups = { ...followups, leads: followups.leads || [] };
    state.refreshedAt = new Date();
    if (notify) toast('Your workspace is up to date.');
  } catch (error) {
    if (version === requestVersion) state.error = error.message;
  } finally {
    if (version === requestVersion) {
      state.loading = false;
      renderShell();
    }
  }
}

function openImport() {
  const dialog = document.querySelector('#import-dialog');
  dialog.innerHTML = `<div class="dialog-header"><div><h2 id="import-title">Bring your leads together.</h2><p>Choose your leads and booking events. We’ll merge duplicate people within your company.</p></div><button class="icon-button" data-action="close-dialog" aria-label="Close import dialog">${icon('close')}</button></div>
  <div class="dialog-body"><div id="import-feedback" role="status" aria-live="polite"></div><form id="import-form">
    <div class="file-field"><label class="field-label" for="leads-file">01 · leads.json</label><input type="file" id="leads-file" name="leads" accept=".json,application/json" required></div>
    <div class="file-field"><label class="field-label" for="bookings-file">02 · bookings.json</label><input type="file" id="bookings-file" name="bookings" accept=".json,application/json" required></div>
    <p class="import-hint">Need files to try? Download the generated <a href="/samples/leads.json" download>leads.json</a> and <a href="/samples/bookings.json" download>bookings.json</a>.<br>Both files may contain Company A and B. Only your company’s rows will be imported. Re-importing the same files is safe.</p>
    <div class="dialog-actions"><button class="button button-secondary" type="button" data-action="close-dialog">Cancel</button><button class="button button-primary" id="import-submit" type="submit">${icon('upload')}Import files</button></div>
  </form></div>`;
  dialog.showModal();
}

function openLead(id) {
  const lead = state.leads.find(item => String(item.id) === String(id)) || state.followups.leads.find(item => String(item.id) === String(id));
  if (!lead) return;
  const dialog = document.querySelector('#lead-dialog');
  dialog.innerHTML = `<div class="dialog-header"><p class="small muted">LEAD DETAILS</p><button class="icon-button" data-action="close-dialog" aria-label="Close lead details">${icon('close')}</button></div><div class="dialog-body"><div class="detail-profile">${avatar(lead.name,state.leads.indexOf(lead))}<div><h2 id="lead-title">${esc(lead.name)}</h2>${statusPill(lead.status)}</div></div><div class="detail-grid">
    <div><p class="detail-label">Phone number</p><p class="detail-value">${lead.phone ? `<a href="tel:${esc(String(lead.phone).replace(/[^+\d]/g,''))}">${esc(lead.phone)}</a>` : 'Not provided'}</p></div>
    <div><p class="detail-label">Email address</p><p class="detail-value">${lead.email ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : 'Not provided'}</p></div>
    <div><p class="detail-label">Next meeting</p><p class="detail-value">${lead.nextMeetingAt ? esc(fullDate(lead.nextMeetingAt)) : 'No upcoming meeting'}</p></div>
    <div><p class="detail-label">Assigned closer</p><p class="detail-value">${esc(lead.closer || 'Unassigned')}</p></div>
    <div><p class="detail-label">Latest booking event</p><p class="detail-value">${lead.lastEventAt ? esc(fullDate(lead.lastEventAt)) : 'No booking events yet'}</p></div>
    <div><p class="detail-label">Workspace</p><p class="detail-value">${esc(state.user.companyName || `Company ${state.user.companyId}`)}</p></div>
  </div><p class="detail-note">Status and next meeting are calculated from the imported booking events. All times are shown in Europe/Riga.</p></div>`;
  dialog.showModal();
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'demo-account') {
    const company = button.dataset.company;
    document.querySelector('#email').value = `${company}@leadinbox.demo`;
    document.querySelector('#password').value = 'LeadInbox2026!';
    document.querySelectorAll('.demo-button').forEach(item => item.classList.toggle('selected',item === button));
    document.querySelector('#login-submit').focus();
  } else if (action === 'toggle-password') {
    const password = document.querySelector('#password');
    password.type = password.type === 'password' ? 'text' : 'password';
    button.setAttribute('aria-label',password.type === 'password' ? 'Show password' : 'Hide password');
  } else if (action === 'navigate') {
    state.page = button.dataset.page;
    renderShell();
    window.scrollTo({top:0,behavior:'instant'});
  } else if (action === 'refresh') {
    await refresh({notify:true});
  } else if (action === 'logout') {
    button.disabled = true;
    try {
      await api('/api/logout',{method:'POST',body:'{}'});
      requestVersion++;
      state.loading = false;
      state.user = null;
      state.leads = [];
      state.stats = {closers:[],totals:{}};
      state.followups = {leads:[]};
      state.search = state.status = state.closer = '';
      state.page = 'leads';
      state.pagination = 1;
      renderLogin();
    } catch(error) { button.disabled = false; toast(error.message); }
  } else if (action === 'open-import') {
    openImport();
  } else if (action === 'close-dialog') {
    button.closest('dialog').close();
  } else if (action === 'lead-detail') {
    openLead(button.dataset.id);
  } else if (action === 'paginate') {
    state.pagination = Math.max(1,Number(button.dataset.page));
    renderLeadResults();
  } else if (action === 'clear-filters') {
    state.search = state.status = state.closer = '';
    state.pagination = 1;
    renderContent();
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'lead-search') {
    state.search = event.target.value;
    state.pagination = 1;
    renderLeadResults();
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'status-filter' || event.target.id === 'closer-filter') {
    state[event.target.id === 'status-filter' ? 'status' : 'closer'] = event.target.value;
    state.pagination = 1;
    renderLeadResults();
  }
});

document.addEventListener('submit', async event => {
  if (event.target.id === 'login-form') {
    event.preventDefault();
    const submit = document.querySelector('#login-submit');
    submit.disabled = true;
    submit.textContent = 'Opening your workspace…';
    document.querySelector('#login-error').replaceChildren();
    try {
      await api('/api/login',{method:'POST',body:JSON.stringify({email:document.querySelector('#email').value.trim(),password:document.querySelector('#password').value})});
      const account = await api('/api/me');
      state.user = account.user;
      state.leads = [];
      state.stats = {closers:[],totals:{}};
      state.followups = {leads:[]};
      state.error = '';
      state.page = 'leads';
      await refresh();
    } catch(error) {
      const errorElement = document.querySelector('#login-error');
      if (errorElement) errorElement.innerHTML = `<p class="form-error">${esc(error.message)}</p>`;
      submit.disabled = false;
      submit.innerHTML = `Sign in to your workspace ${icon('arrow')}`;
    }
  } else if (event.target.id === 'import-form') {
    event.preventDefault();
    const submit = document.querySelector('#import-submit');
    const feedback = document.querySelector('#import-feedback');
    submit.disabled = true;
    submit.textContent = 'Importing your files…';
    feedback.replaceChildren();
    try {
      const leadsFile = document.querySelector('#leads-file').files[0];
      const bookingsFile = document.querySelector('#bookings-file').files[0];
      if (!leadsFile || !bookingsFile) throw new Error('Please choose both JSON files.');
      if (leadsFile.size + bookingsFile.size > 2 * 1024 * 1024) throw new Error('Please keep both files under 2 MB combined.');
      let leadData, bookingData;
      try { [leadData,bookingData] = await Promise.all([leadsFile.text().then(JSON.parse),bookingsFile.text().then(JSON.parse)]); } catch { throw new Error('One of the files is not valid JSON. Please check both files and try again.'); }
      const leads = Array.isArray(leadData) ? leadData : leadData.leads;
      const bookings = Array.isArray(bookingData) ? bookingData : bookingData.bookings;
      if (!Array.isArray(leads) || !Array.isArray(bookings)) throw new Error('Each file should contain an array, or an object with a leads or bookings array.');
      const result = await api('/api/import',{method:'POST',body:JSON.stringify({leads,bookings})});
      feedback.innerHTML = `<div class="import-result"><strong>Your files are imported.</strong><br>${esc(result.leadsImported ?? 0)} leads imported · ${esc(result.duplicatesMerged ?? 0)} duplicates merged<br>${esc(result.eventsImported ?? 0)} events imported · ${esc(result.eventsSkipped ?? 0)} repeated events skipped${result.companyRowsSkipped ? `<br>${esc(result.companyRowsSkipped)} rows from the other company skipped` : ''}</div>`;
      await refresh();
      toast('Import complete. Your inbox is up to date.');
    } catch(error) {
      feedback.innerHTML = `<p class="form-error" role="alert">${esc(error.message)}</p>`;
    } finally {
      submit.disabled = false;
      submit.innerHTML = `${icon('upload')}Import files`;
    }
  }
});

async function start() {
  try {
    const account = await api('/api/me');
    state.user = account.user;
    await refresh();
  } catch(error) {
    renderLogin(error.status === 401 ? '' : error.message);
  }
}

start();
