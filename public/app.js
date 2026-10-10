const $ = (id) => document.getElementById(id);
const networkErrorMessage = location.protocol === 'file:'
  ? 'Please open LogiAuth from its website address instead of opening a file on your device.'
  : 'We couldn’t connect to LogiAuth. Check your internet connection and try again. If it keeps happening, refresh the page.';
let messageTimer;
let currentUser;
let verificationPurpose = 'login';
let activeUploadCourse;
let currentReadingSlide;
let currentNotebook;
let notebookHistory = [];
let pdfModulePromise;
let currentPdfDocument;
let currentPdfLoadingTask;
let currentPdfRenderTask;
let currentCoachSuggestion;
let activityHeartbeat;
let adminUsers = [];
let activeSmallLoadCount = 0;
let activeBookLoadCount = 0;
let smallLoadingTimer;
const nativeFetch = window.fetch.bind(window);
const themeToggle = $('theme-toggle');
const themeToggleLabel = $('theme-toggle-label');
const themeToggleIcon = $('theme-toggle-icon');
const authThemeToggle = $('auth-theme-toggle');
const authThemeToggleLabel = authThemeToggle.querySelector('.auth-theme-toggle-label');
const authThemeToggleIcon = authThemeToggle.querySelector('.auth-theme-toggle-icon');
const THEME_STORAGE_KEY = 'logiauth-theme';
let authThemeAnimationTimer;

function setTheme(theme, persist = false) {
  const isLight = theme === 'light';
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  [themeToggle, authThemeToggle].forEach((toggle) => {
    toggle.setAttribute('aria-pressed', String(isLight));
    toggle.setAttribute('aria-label', `Switch to ${isLight ? 'dark' : 'light'} mode`);
  });
  themeToggleLabel.textContent = isLight ? 'Dark mode' : 'Light mode';
  themeToggleIcon.textContent = isLight ? '☾' : '☀';
  authThemeToggleLabel.textContent = isLight ? 'Dark mode' : 'Light mode';
  authThemeToggleIcon.textContent = isLight ? '☾' : '☀';
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, isLight ? 'light' : 'dark');
    } catch {
      showMessage('Theme changed for this page, but your browser could not save the preference.', 'info');
    }
  }
}

let initialTheme = 'dark';
try {
  initialTheme = localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
} catch {
  initialTheme = 'dark';
}
setTheme(initialTheme);
function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light', true);
}
themeToggle.addEventListener('click', toggleTheme);
authThemeToggle.addEventListener('click', () => {
  toggleTheme();
  authThemeToggle.classList.add('is-changing');
  clearTimeout(authThemeAnimationTimer);
  authThemeAnimationTimer = setTimeout(() => authThemeToggle.classList.remove('is-changing'), 720);
});

const authPanel = document.querySelector('.auth-panel');
const authArt = document.querySelector('.auth-art');
const studyBuddy = document.querySelector('.study-buddy');
const dashboardBook = $('dashboard-book');
const passwordToggles = [...document.querySelectorAll('.password-toggle')];

function updateBuddyPasswordReaction() {
  const passwordVisible = ['password', 'register-password']
    .some((id) => $(id).type === 'text');
  authArt.classList.toggle('is-password-visible', passwordVisible);
}

function resetPasswordVisibility() {
  passwordToggles.forEach((toggle) => {
    const password = document.getElementById(toggle.getAttribute('aria-controls'));
    password.type = 'password';
    toggle.textContent = 'Show';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
  });
  updateBuddyPasswordReaction();
  authArt.classList.remove('is-focused', 'is-typing', 'is-curious');
  authArt.style.setProperty('--buddy-look-x', '0px');
  authArt.style.setProperty('--buddy-look-y', '0px');
}

passwordToggles.forEach((toggle) => {
  toggle.addEventListener('click', () => {
    const password = document.getElementById(toggle.getAttribute('aria-controls'));
    const willReveal = password.type === 'password';
    password.type = willReveal ? 'text' : 'password';
    toggle.textContent = willReveal ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', `${willReveal ? 'Hide' : 'Show'} password`);
    toggle.setAttribute('aria-pressed', String(willReveal));
    updateBuddyPasswordReaction();
    password.focus({ preventScroll: true });
  });
});

authPanel.addEventListener('focusin', (event) => {
  if (!event.target.matches('#login-form input, #register-form input')) return;
  authArt.classList.add('is-focused');
  authArt.classList.remove('is-typing');
  const bounds = event.target.getBoundingClientRect();
  setBuddyGaze(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
});

authPanel.addEventListener('input', (event) => {
  if (event.target.matches('#login-form input, #register-form input')) {
    authArt.classList.add('is-focused', 'is-typing');
  }
});

authPanel.addEventListener('focusout', (event) => {
  if (event.relatedTarget?.closest('#login-form, #register-form')) return;
  authArt.classList.remove('is-focused', 'is-typing');
  authArt.style.setProperty('--buddy-look-x', '0px');
  authArt.style.setProperty('--buddy-look-y', '0px');
});

function setBuddyGaze(clientX, clientY) {
  const bounds = authArt.getBoundingClientRect();
  const x = Math.max(-4, Math.min(4, (clientX - bounds.left) / bounds.width * 8 - 4));
  const y = Math.max(-3, Math.min(3, (clientY - bounds.top) / bounds.height * 6 - 3));
  authArt.style.setProperty('--buddy-look-x', `${x.toFixed(1)}px`);
  authArt.style.setProperty('--buddy-look-y', `${y.toFixed(1)}px`);
}

function trackBuddyPointer(event) {
  if (event.pointerType === 'touch') return;
  setBuddyGaze(event.clientX, event.clientY);
}

authArt.addEventListener('pointermove', trackBuddyPointer);
authArt.addEventListener('pointerdown', trackBuddyPointer);

authArt.addEventListener('pointerleave', () => {
  const focusedField = document.activeElement.closest?.('#login-form input, #register-form input');
  if (focusedField) {
    const bounds = focusedField.getBoundingClientRect();
    setBuddyGaze(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return;
  }
  authArt.style.setProperty('--buddy-look-x', '0px');
  authArt.style.setProperty('--buddy-look-y', '0px');
  authArt.classList.remove('is-curious');
});
studyBuddy.addEventListener('pointerenter', () => authArt.classList.add('is-curious'));
studyBuddy.addEventListener('pointerleave', () => authArt.classList.remove('is-curious'));

let pageTurnTimer;
window.addEventListener('scroll', () => {
  if (!document.body.classList.contains('dashboard-page') ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !dashboardBook.getClientRects().length ||
      dashboardBook.classList.contains('is-page-turning')) return;
  dashboardBook.classList.add('is-page-turning');
  clearTimeout(pageTurnTimer);
  pageTurnTimer = setTimeout(() => dashboardBook.classList.remove('is-page-turning'), 620);
}, { passive: true });

const modalBackdrops = [...document.querySelectorAll('.modal-backdrop')];
const modalOpeners = new WeakMap();
const modalOpenStates = new Map(modalBackdrops.map((backdrop) => [backdrop, false]));
let lastFocusedOutsideModal = null;

document.addEventListener('focusin', (event) => {
  if (event.target !== document.body && !event.target.closest('.modal-backdrop')) {
    lastFocusedOutsideModal = event.target;
  }
});

function getOpenModal() {
  return modalBackdrops.filter((backdrop) => !backdrop.classList.contains('hidden')).at(-1) || null;
}

function getModalFocusableElements(backdrop) {
  return [...backdrop.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
  )].filter((node) => node.getClientRects().length && !node.closest('.hidden'));
}

const modalObserver = new MutationObserver((mutations) => {
  const changedBackdrops = new Set(mutations.map((mutation) => mutation.target));
  const closedBackdrops = [];

  for (const backdrop of changedBackdrops) {
    const isOpen = !backdrop.classList.contains('hidden');
    if (modalOpenStates.get(backdrop) === isOpen) continue;
    modalOpenStates.set(backdrop, isOpen);
    if (isOpen) {
      modalOpeners.set(backdrop, lastFocusedOutsideModal);
    } else {
      closedBackdrops.push(backdrop);
    }
  }

  const openModal = getOpenModal();
  document.querySelector('.auth-panel').inert = Boolean(openModal);
  document.querySelector('.auth-panel').setAttribute('aria-hidden', String(Boolean(openModal)));
  modalBackdrops.forEach((backdrop) => {
    const inactive = Boolean(openModal && backdrop !== openModal);
    backdrop.inert = inactive;
    backdrop.setAttribute('aria-hidden', String(inactive || backdrop.classList.contains('hidden')));
  });

  if (openModal) {
    const dialog = openModal.querySelector('[role="dialog"]');
    if (dialog && !dialog.contains(document.activeElement)) {
      const [firstFocusable] = getModalFocusableElements(openModal);
      (firstFocusable || dialog).focus({ preventScroll: true });
    }
    return;
  }

  const closedBackdrop = closedBackdrops.at(-1);
  const opener = closedBackdrop && modalOpeners.get(closedBackdrop);
  if (opener?.isConnected && !opener.closest('.hidden')) opener.focus({ preventScroll: true });
});

modalBackdrops.forEach((backdrop) => {
  modalObserver.observe(backdrop, { attributes: true, attributeFilter: ['class'] });
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const backdrop = getOpenModal();
  if (!backdrop) return;
  const focusable = getModalFocusableElements(backdrop);
  if (!focusable.length) {
    event.preventDefault();
    backdrop.querySelector('[role="dialog"]')?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !backdrop.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !backdrop.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
});

function beginAppLoading(label = 'Opening your book…') {
  activeSmallLoadCount += 1;
  $('small-loading').setAttribute('aria-label', label);
  clearTimeout(smallLoadingTimer);
  smallLoadingTimer = setTimeout(() => {
    if (activeSmallLoadCount > 0) $('small-loading').classList.add('is-visible');
  }, 250);

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeSmallLoadCount = Math.max(0, activeSmallLoadCount - 1);
    if (activeSmallLoadCount === 0) {
      clearTimeout(smallLoadingTimer);
      $('small-loading').classList.remove('is-visible');
    }
  };
}

function beginBookLoading() {
  activeBookLoadCount += 1;
  $('app-loading').classList.add('is-visible');
  $('app-loading').setAttribute('aria-hidden', 'false');
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeBookLoadCount = Math.max(0, activeBookLoadCount - 1);
    if (activeBookLoadCount === 0) {
      $('app-loading').classList.remove('is-visible');
      $('app-loading').setAttribute('aria-hidden', 'true');
    }
  };
}

window.fetch = (...args) => {
  const requestUrl = args[0] instanceof Request ? args[0].url : args[0];
  const method = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
  const pathname = new URL(requestUrl, location.href).pathname;
  const isAuthentication = method === 'POST' && pathname === '/api/auth/login';
  const isSlidePreviewRequest = pathname.endsWith('/view');
  const finishLoading = isAuthentication
    ? beginBookLoading()
    : isSlidePreviewRequest
      ? () => {}
      : beginAppLoading();
  return nativeFetch(...args).finally(finishLoading);
};

const showMessage = (text, type = 'info') => {
  const el = $('message');
  clearTimeout(messageTimer);
  if (!text) {
    el.textContent = '';
    el.className = 'message';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    return;
  }
  el.textContent = text;
  el.className = `message ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  messageTimer = setTimeout(() => {
    el.className = 'message';
    el.textContent = '';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
  }, 8000);
};

const hideAll = () => {
  $('auth-mode-switch').classList.add('hidden');
  $('login-section').classList.add('hidden');
  $('file-launch-help').classList.add('hidden');
  $('register-section').classList.add('hidden');
  $('twofa-section').classList.add('hidden');
  $('dashboard-section').classList.add('hidden');
};

const showLogin = () => {
  resetPasswordVisibility();
  hideAll();
  document.body.classList.remove('dashboard-page');
  document.querySelector('.auth-panel').classList.remove('dashboard-open');
  $('auth-intro').querySelector('h2').textContent = 'Welcome back';
  $('auth-intro').querySelector('p:last-child').textContent = 'Sign in to pick up where your learning left off.';
  $('auth-mode-switch').classList.remove('is-register');
  $('auth-mode-switch').classList.remove('hidden');
  $('login-tab').classList.add('is-active');
  $('login-tab').setAttribute('aria-selected', 'true');
  $('login-tab').tabIndex = 0;
  $('register-tab').classList.remove('is-active');
  $('register-tab').setAttribute('aria-selected', 'false');
  $('register-tab').tabIndex = -1;
  $('login-section').classList.remove('hidden');
};

const showRegister = () => {
  resetPasswordVisibility();
  hideAll();
  document.body.classList.remove('dashboard-page');
  document.querySelector('.auth-panel').classList.remove('dashboard-open');
  $('auth-intro').querySelector('h2').textContent = 'Create your account';
  $('auth-intro').querySelector('p:last-child').textContent = 'Set up your learning space and keep your courses in one place.';
  $('auth-mode-switch').classList.add('is-register');
  $('auth-mode-switch').classList.remove('hidden');
  $('login-tab').classList.remove('is-active');
  $('login-tab').setAttribute('aria-selected', 'false');
  $('login-tab').tabIndex = -1;
  $('register-tab').classList.add('is-active');
  $('register-tab').setAttribute('aria-selected', 'true');
  $('register-tab').tabIndex = 0;
  $('register-section').classList.remove('hidden');
};

const show2FA = (maskedEmail, purpose = 'login') => {
  resetPasswordVisibility();
  verificationPurpose = purpose;
  hideAll();
  $('twofa-section').classList.remove('hidden');
  $('otp-title').textContent = purpose === 'registration' ? 'Verify your email' : 'Verify your identity';
  $('otp-subtitle').textContent = purpose === 'registration'
    ? `Enter the 6-digit code sent to ${maskedEmail}. Check this address is correct; choose Back to account details to change it.`
    : `Enter the 6-digit code sent to ${maskedEmail}.`;
  $('back-btn').textContent = purpose === 'registration' ? 'Back to account details' : 'Back to sign in';
  $('resend-code-btn').textContent = 'Resend code';
  otpSlots[0].focus();
};

const showDashboard = (user) => {
  resetPasswordVisibility();
  currentUser = user;
  hideAll();
  document.body.classList.add('dashboard-page');
  document.body.classList.toggle('is-admin', user.role === 'admin');
  document.querySelector('.auth-panel').classList.add('dashboard-open');
  $('dashboard-section').classList.remove('hidden');
  $('welcome-username').textContent = user.username;
  $('dashboard-eyebrow').textContent = user.role === 'admin' ? 'SYSTEM MONITOR' : 'LOGIAUTH WORKSPACE';
  $('dashboard-title').replaceChildren(
    ...(user.role === 'admin'
      ? [document.createTextNode('System overview')]
      : [document.createTextNode('Welcome, '), $('welcome-username')])
  );
  $('role-badge').textContent = user.role === 'admin' ? 'ADMINISTRATOR · READ ONLY' : user.role.toUpperCase();
  $('backup-btn').classList.add('hidden');
  $('admin-users-btn').classList.toggle('hidden', user.role !== 'admin');
  $('admin-users-btn').textContent = 'View accounts';
  $('admin-users-btn').setAttribute('aria-expanded', 'false');
  $('admin-users-panel').classList.add('hidden');
  $('admin-monitor-section').classList.toggle('hidden', user.role !== 'admin');
  $('show-course-form-btn').classList.toggle('hidden', user.role === 'admin');
  clearInterval(activityHeartbeat);
  updateUserActivity();
  activityHeartbeat = setInterval(updateUserActivity, 60_000);
  loadDashboard();
};

async function updateUserActivity() {
  if (!currentUser) return;
  try {
    const response = await nativeFetch('/api/auth/activity', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      let message = `Activity update returned HTTP ${response.status}.`;
      if ((response.headers.get('content-type') || '').includes('application/json')) {
        const data = await response.json();
        message = data.error || message;
      }
      throw new Error(message);
    }
  } catch (error) {
    console.error('User activity heartbeat failed:', error);
  }
}

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const formatDate = (value) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value));

const formatBytes = (value) => {
  const size = Number(value);
  if (size === 0) return '0 KB';
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

function renderAdminBarChart(root, rows) {
  if (!rows.length) {
    root.replaceChildren(element('p', 'empty-state', 'No activity in this period.'));
    return;
  }
  const max = Math.max(1, ...rows.map((row) => row.count));
  root.replaceChildren(...rows.map((row) => {
    const item = element('div', 'admin-bar-item');
    const labels = element('div', 'admin-bar-labels');
    labels.append(
      element('span', '', new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${row.day}T12:00:00`))),
      element('strong', '', String(row.count))
    );
    const track = element('div', 'admin-chart-track');
    const bar = element('span', 'admin-chart-bar');
    bar.style.width = `${row.count ? Math.max(3, row.count / max * 100) : 0}%`;
    track.append(bar);
    item.append(labels, track);
    return item;
  }));
}

function renderAdminOverview(data) {
  const { metrics, registrations, uploads, roles, courses } = data;
  const cards = [
    ['Total accounts', metrics.user_count, `${metrics.new_users_24h} new in 24 hours`],
    ['Active now', metrics.active_users, 'Seen within the last 5 minutes'],
    ['Successful logins', metrics.successful_logins_24h, 'Last 24 hours'],
    ['Courses monitored', metrics.course_count, 'Across the system'],
    ['Slide files', metrics.slide_count, 'Across all courses'],
    ['Storage used', formatBytes(metrics.storage_bytes), 'Uploaded slide materials'],
  ];
  $('admin-stats').replaceChildren(...cards.map(([label, value, hint]) => {
    const card = element('article', 'stat-card admin-stat-card');
    card.append(
      element('span', 'stat-label', label),
      element('strong', 'stat-value', String(value ?? 0)),
      element('span', 'stat-hint', hint)
    );
    return card;
  }));

  renderAdminBarChart($('admin-registration-chart'), registrations);
  renderAdminBarChart($('admin-upload-chart'), uploads);

  const maxRoleCount = Math.max(1, ...roles.map((item) => item.count));
  $('admin-role-chart').replaceChildren(...(roles.length ? roles : []).map((item) => {
    const row = element('div', 'admin-role-row');
    const labels = element('div', 'admin-bar-labels');
    labels.append(
      element('span', 'admin-role-name', `${item.role[0].toUpperCase()}${item.role.slice(1)}`),
      element('strong', '', String(item.count))
    );
    const track = element('div', 'admin-chart-track');
    const bar = element('span', 'admin-chart-bar admin-role-bar');
    bar.style.width = `${item.count ? Math.max(3, item.count / maxRoleCount * 100) : 0}%`;
    track.append(bar);
    row.append(labels, track);
    return row;
  }));
  if (!roles.length) $('admin-role-chart').append(element('p', 'empty-state', 'No accounts found.'));

  const maxCourseCount = Math.max(1, ...courses.map((item) => item.slideCount));
  $('admin-course-chart').replaceChildren(...(courses.length ? courses : []).map((item) => {
    const row = element('div', 'admin-course-row');
    const labels = element('div', 'admin-bar-labels');
    labels.append(
      element('span', 'admin-course-name', item.title),
      element('strong', '', `${item.slideCount} ${item.slideCount === 1 ? 'file' : 'files'}`)
    );
    const track = element('div', 'admin-chart-track');
    const bar = element('span', 'admin-chart-bar admin-course-bar');
    bar.style.width = `${item.slideCount ? Math.max(3, item.slideCount / maxCourseCount * 100) : 0}%`;
    track.append(bar);
    row.append(labels, track, element('span', 'admin-course-storage', formatBytes(item.storageBytes)));
    return row;
  }));
  if (!courses.length) $('admin-course-chart').append(element('p', 'empty-state', 'No courses found.'));
}

async function loadDashboard() {
  $('refresh-dashboard-btn').disabled = true;
  try {
    if (currentUser.role === 'admin') {
      const response = await fetch('/api/auth/admin/overview', { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load system monitoring data.');
      renderAdminOverview(data);
      await loadAdminUsers();
      return;
    }
    const response = await fetch('/api/study/dashboard', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load dashboard.');
    renderDashboard(data);
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  } finally {
    $('refresh-dashboard-btn').disabled = false;
  }
}

function renderDashboard(data) {
  const { stats, courses, recentSlides } = data;
  const cards = [
    ['Courses', stats.courseCount, 'In your library'],
    ['Slide files', stats.slideCount, 'Ready to view'],
    ['Learning progress', `${stats.progressPercent}%`, `${stats.completedCount} of ${stats.slideCount} completed`],
  ];
  if (currentUser.role === 'admin') cards.push(['Members', stats.userCount, 'Registered accounts']);
  const statsRoot = $('dashboard-stats');
  statsRoot.replaceChildren(...cards.map(([label, value, hint]) => {
    const card = element('article', 'stat-card');
    card.append(element('span', 'stat-label', label), element('strong', 'stat-value', value ?? '—'), element('span', 'stat-hint', hint));
    return card;
  }));

  renderCourseChart(courses);
  renderCourses(courses);
  renderRecentUploads(recentSlides);
  const notebookCourse = courses.find((course) => Number(course.slide_count) > 0);
  const dashboardNotebookButton = $('dashboard-ask-gemini');
  dashboardNotebookButton.classList.toggle('hidden', !notebookCourse);
  dashboardNotebookButton.dataset.courseId = notebookCourse ? String(notebookCourse.id) : '';
  loadContentCoach();
  loadSemesterPlanner();
}

async function loadAdminUsers() {
  const status = $('admin-users-status');
  $('refresh-admin-users-btn').disabled = true;
  status.textContent = 'Loading users…';
  try {
    const response = await fetch('/api/auth/admin/users', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load users.');
    adminUsers = data.users;
    renderAdminUsers();
    status.textContent = `${adminUsers.length} ${adminUsers.length === 1 ? 'account' : 'accounts'}`;
  } catch (error) {
    status.textContent = error.message || 'Could not load users.';
    $('admin-users-table-wrap').replaceChildren();
  } finally {
    $('refresh-admin-users-btn').disabled = false;
  }
}

function renderAdminUsers() {
  const query = $('admin-user-search').value.trim().toLowerCase();
  const users = adminUsers.filter((user) =>
    [user.username, user.email, user.role].some((value) => value.toLowerCase().includes(query))
  );
  const table = element('table', 'admin-users-table');
  const head = element('thead');
  const headerRow = element('tr');
  ['Account', 'Role', 'Joined', 'Last login', 'Activity'].forEach((label) => {
    headerRow.append(element('th', '', label));
  });
  head.append(headerRow);
  const body = element('tbody');

  users.forEach((user) => {
    const row = element('tr');
    const account = element('td', 'admin-user-account');
    account.append(element('strong', '', user.username), element('span', '', user.email));
    const lastActiveMs = user.last_activity_at ? Date.now() - Date.parse(user.last_activity_at) : Infinity;
    const isActive = lastActiveMs >= -60_000 && lastActiveMs <= 5 * 60_000;
    const activity = element('td');
    const activityBadge = element('span', `admin-activity-badge${isActive ? ' is-active' : ''}`,
      isActive ? 'Active · last 5 min' : user.last_activity_at ? `Last seen ${formatDate(user.last_activity_at)}` : 'Not seen yet');
    activity.append(activityBadge);
    row.append(
      account,
      element('td', 'admin-user-role', user.role),
      element('td', '', formatDate(user.created_at)),
      element('td', '', user.last_login ? formatDate(user.last_login) : 'Never'),
      activity
    );
    body.append(row);
  });

  if (!users.length) {
    const row = element('tr');
    const cell = element('td', 'admin-users-empty', query ? 'No users match your search.' : 'No accounts found.');
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }

  table.append(head, body);
  $('admin-users-table-wrap').replaceChildren(table);
}

$('admin-users-btn').addEventListener('click', () => {
  const isOpen = $('admin-users-panel').classList.contains('hidden');
  $('admin-users-panel').classList.toggle('hidden', !isOpen);
  $('admin-users-btn').textContent = isOpen ? 'Hide accounts' : 'View accounts';
  $('admin-users-btn').setAttribute('aria-expanded', String(isOpen));
  if (isOpen && !adminUsers.length) loadAdminUsers();
});
$('refresh-admin-users-btn').addEventListener('click', loadAdminUsers);
$('admin-user-search').addEventListener('input', renderAdminUsers);

async function loadSemesterPlanner() {
  const options = $('semester-course-options');
  options.replaceChildren(element('p', 'empty-state', 'Loading semester plan…'));
  try {
    const response = await fetch('/api/study/semester', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load your semester plan.');

    $('semester-program').value = data.profile?.program_name || '';
    $('semester-name').value = data.profile?.semester_name || '';
    const availableCourses = data.courses || [];
    if (!availableCourses.length) {
      options.replaceChildren(element('p', 'empty-state', 'Create a course in Your Library first, then add it to this semester.'));
    } else {
      options.replaceChildren(...availableCourses.map((course) => {
        const label = element('label', 'semester-course-option');
        const checkbox = element('input', 'semester-course-check');
        checkbox.type = 'checkbox';
        checkbox.value = course.id;
        checkbox.checked = course.selected;
        checkbox.dataset.title = course.title;
        const details = element('span', 'semester-course-details');
        details.append(
          element('strong', '', course.title),
          element('span', '', `${course.slide_count} ${course.slide_count === 1 ? 'slide file' : 'slide files'}`)
        );
        label.append(checkbox, details);
        return label;
      }));
    }
    renderSemesterExamCourses(data.profile, availableCourses.filter((course) => course.selected));
  } catch (error) {
    options.replaceChildren(element('p', 'empty-state', error.message || 'Could not load your semester plan.'));
    $('semester-save-status').textContent = 'Refresh the dashboard to retry loading your semester plan.';
  }
}

function renderSemesterExamCourses(profile, courses) {
  const count = $('semester-course-count');
  const examList = $('semester-exam-list');
  if (!profile) {
    count.textContent = 'Set up your courses';
    examList.classList.add('hidden');
    examList.replaceChildren();
    return;
  }
  count.textContent = `${courses.length} ${courses.length === 1 ? 'course' : 'courses'} this semester`;
  examList.classList.remove('hidden');
  const heading = element('h4', 'semester-exam-heading',
    `${profile.program_name}${profile.semester_name ? ` · ${profile.semester_name}` : ''}`);
  const list = element('ul', 'semester-exam-courses');
  list.append(...courses.map((course) => {
    const item = element('li', 'semester-exam-course');
    const summary = element('div', 'semester-exam-course-copy');
    summary.append(
      element('strong', '', course.title),
      element('span', '', course.slide_count
        ? `${course.slide_count} slide ${course.slide_count === 1 ? 'file' : 'files'} ready for exam prep`
        : 'Upload course slides to get grounded exam preparation')
    );
    const prepareButton = element(
      'button',
      'small-button semester-prepare-button',
      course.slide_count ? '✦ Prepare for exam' : 'Add course slides'
    );
    prepareButton.type = 'button';
    prepareButton.disabled = !course.slide_count;
    prepareButton.addEventListener('click', () => {
      const prompt = `Create a focused exam-preparation guide for ${course.title}. Use only the selected course materials. Identify the most testable concepts, explain them clearly, provide practice questions, put the answer key at the end, and finish with a revision checklist. Cite material-based claims with source pages. If these materials do not provide enough information for a topic, say so.`;
      openCourseNotebook(course.id, prompt);
    });
    item.append(summary, prepareButton);
    return item;
  }));
  examList.replaceChildren(heading, list);
}

async function loadContentCoach({ refresh = false } = {}) {
  const status = $('coach-status');
  const root = $('study-suggestions');
  const retryButton = $('retry-coach-btn');
  retryButton.classList.add('hidden');
  retryButton.disabled = true;
  status.textContent = 'Reading your slide content to build grounded suggestions. Your notes stay private.';
  root.replaceChildren(element('li', 'empty-state', 'The coach is reading your slide content…'));
  try {
    const response = await fetch(`/api/study/coach${refresh ? '?refresh=1' : ''}`, { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || 'Could not analyze your study files.');
      error.retryable = data.retryable === true;
      throw error;
    }
    status.textContent = data.message;
    renderStudySuggestions(data.suggestions || []);
  } catch (error) {
    status.textContent = error.message || 'Your dashboard is ready, but the coach could not analyze the files.';
    root.replaceChildren(element('li', 'empty-state', error.message || networkErrorMessage));
    retryButton.classList.toggle('hidden', error.retryable === false);
  } finally {
    retryButton.disabled = false;
  }
}

function renderCourseChart(courses) {
  const chart = $('course-chart');
  if (!courses.length) {
    chart.replaceChildren(element('p', 'empty-state', 'Create your first course to see its activity here.'));
    return;
  }

  chart.replaceChildren(...courses.slice(0, 6).map((course) => {
    const row = element('div', 'chart-row');
    const heading = element('div', 'chart-labels');
    const completionPercent = course.slide_count
      ? Math.round(course.completed_count / course.slide_count * 100)
      : 0;
    heading.append(
      element('span', 'chart-course-name', course.title),
      element('span', 'chart-count', `${completionPercent}%`)
    );
    const track = element('div', 'chart-track');
    const bar = element('span', 'chart-bar');
    bar.style.width = `${completionPercent}%`;
    track.append(bar);
    row.append(heading, track);
    return row;
  }));
}

function renderCourses(courses) {
  const root = $('course-list');
  if (!courses.length) {
    root.replaceChildren(element('p', 'empty-state', 'No courses yet. Add a course to start building your library.'));
    return;
  }

  root.replaceChildren(...courses.map((course) => {
    const card = element('article', 'course-card');
    card.dataset.courseId = course.id;
    const main = element('div', 'course-card-main');
    const heading = element('div', 'course-card-heading');
    heading.append(element('h4', '', course.title), element('span', 'course-count', `${course.slide_count} ${course.slide_count === 1 ? 'file' : 'files'}`));
    main.append(heading, element('p', 'course-description', course.description || 'No description yet.'));

    const progressPercent = course.slide_count
      ? Math.round(course.completed_count / course.slide_count * 100)
      : 0;
    const progress = element('div', 'course-progress');
    const progressHeader = element('div', 'course-progress-labels');
    progressHeader.append(
      element('span', '', 'Your progress'),
      element('span', '', `${course.completed_count}/${course.slide_count} complete`)
    );
    const progressTrack = element('div', 'chart-track');
    const progressBar = element('span', 'chart-bar');
    progressBar.style.width = `${progressPercent}%`;
    progressTrack.append(progressBar);
    progress.append(progressHeader, progressTrack);

    const actions = element('div', 'course-actions');
    if (['admin', 'editor', 'student'].includes(currentUser.role)) {
      const uploadButton = element('button', 'small-button', 'Upload slides');
      uploadButton.type = 'button';
      uploadButton.addEventListener('click', () => openUpload(course));
      actions.append(uploadButton);
    }
    const filesButton = element('button', 'small-button small-button-muted', 'View files');
    filesButton.type = 'button';
    filesButton.addEventListener('click', () => toggleCourseFiles(course.id, card, filesButton));
    const notebookButton = element('button', 'small-button notebook-open-button', '✦ Ask Gemini');
    notebookButton.type = 'button';
    notebookButton.addEventListener('click', () => openCourseNotebook(course.id));
    actions.append(filesButton, notebookButton);

    const filesList = element('ul', 'course-files hidden');
    filesList.dataset.courseId = course.id;
    card.append(main, progress, actions, filesList);
    return card;
  }));
}

async function openCourseNotebook(courseId, initialQuestion = '') {
  const root = $('notebook-source-list');
  root.replaceChildren(element('li', 'empty-state', 'Loading course sources…'));
  $('notebook-messages').replaceChildren();
  $('notebook-status').textContent = 'Loading selected course…';
  $('modal-notebook').classList.remove('hidden');
  notebookHistory = [];

  try {
    const response = await fetch(`/api/study/courses/${courseId}/notebook`, { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not open course notebook.');

    currentNotebook = data;
    currentNotebook.courseId = courseId;
    $('notebook-title').textContent = data.course.title;
    if (!data.sources.length) {
      root.replaceChildren(element('li', 'empty-state', 'Upload a PDF or PowerPoint to add the first source.'));
    } else {
      root.replaceChildren(...data.sources.map((source, index) => {
        const item = element('li', 'notebook-source');
        const checkbox = element('input', 'notebook-source-check');
        checkbox.type = 'checkbox';
        checkbox.value = source.id;
        checkbox.checked = index < 12;
        checkbox.setAttribute('aria-label', `Include ${source.original_name}`);
        checkbox.addEventListener('change', updateNotebookSelection);
        const file = element('span', 'notebook-source-icon', source.mime_type === 'application/pdf' ? 'PDF' : 'PPT');
        const details = element('span', 'notebook-source-details');
        details.append(
          element('strong', '', source.original_name),
          element('span', '', `${formatBytes(source.size_bytes)} · ${source.is_completed ? 'completed' : 'in progress'}`)
        );
        item.append(checkbox, file, details);
        return item;
      }));
    }

    $('notebook-status').textContent = data.aiConfigured
      ? `${data.sources.length} course sources · Gemini will answer from the checked sources and cite the slide pages.`
      : 'Add GEMINI_API_KEY to .env and restart LogiAuth to enable grounded AI chat.';
    appendNotebookMessage(
      'model',
      data.aiConfigured
        ? `This notebook is ready for **${data.course.title}**. Select up to 12 sources, then ask for explanations, summaries, study guides, or a quiz. I will cite the source pages I use.`
        : 'Your sources are ready, but AI chat needs a Gemini API key. Add `GEMINI_API_KEY=your_key` to the project .env file, then restart the app.',
      []
    );
    updateNotebookSelection();
    if (initialQuestion && data.aiConfigured && data.sources.length) {
      $('notebook-question').value = initialQuestion;
      await askNotebook(initialQuestion);
    }
  } catch (error) {
    currentNotebook = null;
    $('notebook-status').textContent = 'Could not load this course.';
    root.replaceChildren(element('li', 'empty-state', error.message || networkErrorMessage));
  }
}

function selectedNotebookSourceIds() {
  return [...$('notebook-source-list').querySelectorAll('.notebook-source-check:checked')]
    .map((checkbox) => Number(checkbox.value));
}

function updateNotebookSelection() {
  const selected = selectedNotebookSourceIds();
  $('notebook-source-count').textContent = `${selected.length} selected · choose up to 12`;
  $('notebook-select-all').textContent = selected.length === currentNotebook?.sources.length ? 'Select none' : 'Select all';
  $('notebook-send-btn').disabled = !currentNotebook?.aiConfigured || selected.length === 0 || selected.length > 12;
  if (selected.length > 12) {
    $('notebook-status').textContent = 'Select no more than 12 sources for one question.';
  } else if (currentNotebook?.aiConfigured) {
    $('notebook-status').textContent = `${selected.length} source${selected.length === 1 ? '' : 's'} selected · Gemini answers with citations from these sources.`;
  }
}

function appendNotebookMessage(role, text, citations = []) {
  const messages = $('notebook-messages');
  const bubble = element('article', `notebook-message ${role === 'user' ? 'notebook-message-user' : 'notebook-message-ai'}`);
  bubble.append(element('span', 'notebook-message-author', role === 'user' ? 'You' : 'Notebook AI'));
  const body = element('p', 'notebook-message-body');
  body.textContent = text.replace(/\*\*(.*?)\*\*/g, '$1');
  bubble.append(body);
  if (citations.length) {
    const citationList = element('div', 'notebook-citations');
    citations.forEach((citation, index) => {
      const button = element('button', 'notebook-citation', `[${index + 1}] ${citation.fileName} · p. ${citation.page}`);
      button.type = 'button';
      button.title = citation.quote;
      button.addEventListener('click', () => {
        const source = currentNotebook?.sources.find((item) => Number(item.id) === Number(citation.sourceId));
        if (!source) return showMessage('That source is no longer available.', 'error');
        $('modal-notebook').classList.add('hidden');
        openSlideReader(currentNotebook.courseId, source, citation.page);
      });
      citationList.append(button);
    });
    bubble.append(citationList);
  }
  messages.append(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

async function askNotebook(question, { appendQuestion = true } = {}) {
  if (!currentNotebook) return;
  const sourceIds = selectedNotebookSourceIds();
  if (!sourceIds.length || sourceIds.length > 12) {
    $('notebook-status').textContent = 'Select between 1 and 12 sources to ask a question.';
    return;
  }
  if (appendQuestion) appendNotebookMessage('user', question);
  const thinking = element('article', 'notebook-message notebook-message-ai notebook-thinking', 'Reading your sources and preparing cited answer…');
  $('notebook-messages').append(thinking);
  $('notebook-messages').scrollTop = $('notebook-messages').scrollHeight;
  $('notebook-send-btn').disabled = true;
  $('notebook-question').value = '';
  $('notebook-status').textContent = 'Searching selected sources and checking citations…';

  try {
    const response = await fetch(`/api/study/courses/${currentNotebook.courseId}/notebook/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ question, sourceIds, history: notebookHistory }),
    });
    const data = await response.json();
    thinking.remove();
    if (!response.ok) {
      const error = new Error(data.error || 'Could not answer from the selected sources.');
      error.status = response.status;
      error.retryable = data.retryable;
      throw error;
    }
    appendNotebookMessage('model', data.answer, data.citations || []);
    notebookHistory.push({ role: 'user', text: question }, { role: 'model', text: data.answer });
    notebookHistory = notebookHistory.slice(-8);
    $('notebook-status').textContent = `${data.model} · citations verified against selected source text.`;
  } catch (error) {
    thinking.remove();
    const errorMessage = appendNotebookMessage('model', error.message || networkErrorMessage);
    if (error.retryable ?? (!error.status || error.status >= 500 || error.status === 429)) {
      const retry = element('button', 'notebook-citation notebook-retry', 'Retry answer');
      retry.type = 'button';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        errorMessage.remove();
        await askNotebook(question, { appendQuestion: false });
      });
      errorMessage.append(retry);
    }
    $('notebook-status').textContent = error.message || 'Could not get a grounded answer.';
  } finally {
    updateNotebookSelection();
    if (currentNotebook?.aiConfigured && sourceIds.length > 0 && sourceIds.length <= 12) {
      $('notebook-question').focus();
    }
  }
}

async function toggleCourseFiles(courseId, card, button) {
  const list = card.querySelector('.course-files');
  if (!list.classList.contains('hidden')) {
    list.classList.add('hidden');
    button.textContent = 'View files';
    return;
  }
  button.disabled = true;
  try {
    if (!list.dataset.loaded) {
      const response = await fetch(`/api/study/courses/${courseId}/slides`, { credentials: 'same-origin' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load course files.');
      list.replaceChildren(...data.slides.map((slide) => {
        const item = element('li', 'course-file-item');
        item.dataset.slideId = slide.id;
        const info = element('div', 'course-file-info');
        const fileLink = element('button', 'file-link', slide.original_name);
        fileLink.type = 'button';
        fileLink.addEventListener('click', () => openSlideReader(courseId, slide));
        const meta = element('span', 'file-meta-line', `${formatBytes(slide.size_bytes)} · ${formatDate(slide.created_at)} · in-app preview`);
        info.append(fileLink, meta);
        const completeButton = element(
          'button',
          `progress-toggle${slide.is_completed ? ' is-complete' : ''}`,
          slide.is_completed ? '✓ Chapter complete' : 'Mark complete'
        );
        completeButton.type = 'button';
        completeButton.setAttribute('aria-pressed', String(slide.is_completed));
        completeButton.addEventListener('click', () =>
          updateSlideProgress(courseId, slide.id, !slide.is_completed)
        );
        const actions = element('div', 'slide-actions');
        actions.append(completeButton);
        const downloadLink = element('a', 'progress-toggle download-slide', 'Download');
        downloadLink.href = `/api/study/courses/${courseId}/slides/${slide.id}/download`;
        actions.append(downloadLink);
        const notesButton = element('button', 'progress-toggle notes-toggle', 'Notes');
        notesButton.type = 'button';
        actions.append(notesButton);
        if (slide.can_delete) {
          const deleteButton = element('button', 'progress-toggle delete-slide', 'Delete');
          deleteButton.type = 'button';
          deleteButton.addEventListener('click', () => deleteSlide(courseId, slide.id, slide.original_name));
          actions.append(deleteButton);
        }

        const notesPanel = element('div', 'slide-notes-panel hidden');
        const noteInput = element('textarea', 'slide-note-input');
        noteInput.maxLength = 10000;
        noteInput.placeholder = 'Your private notes about this chapter…';
        noteInput.value = slide.note;
        noteInput.setAttribute('aria-label', `Private notes for ${slide.original_name}`);
        const noteControls = element('div', 'slide-note-controls');
        const noteCount = element('span', 'file-meta-line', `${slide.note.length} / 10,000`);
        const saveNote = element('button', 'progress-toggle save-slide-note', 'Save note');
        saveNote.type = 'button';
        noteInput.addEventListener('input', () => {
          noteCount.textContent = `${noteInput.value.length} / 10,000`;
        });
        saveNote.addEventListener('click', () => saveSlideNote(courseId, slide.id, noteInput, saveNote));
        noteControls.append(noteCount, saveNote);
        notesPanel.append(noteInput, noteControls);
        notesButton.addEventListener('click', () => {
          notesPanel.classList.toggle('hidden');
          if (!notesPanel.classList.contains('hidden')) noteInput.focus();
        });

        item.append(info, actions, notesPanel);
        return item;
      }));
      if (!data.slides.length) list.append(element('li', 'empty-state', 'No files in this course yet.'));
      list.dataset.loaded = 'true';
    }
    list.classList.remove('hidden');
    button.textContent = 'Hide files';
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  } finally {
    button.disabled = false;
  }
}

async function deleteSlide(courseId, slideId, slideName) {
  if (!window.confirm(`Delete "${slideName}" and its saved progress? This cannot be undone.`)) return;
  try {
    const response = await fetch(`/api/study/courses/${courseId}/slides/${slideId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not delete slide.');
    showMessage(data.warning || 'Slide deleted.', data.warning ? 'error' : 'success');
    await loadDashboard();
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  }
}

async function saveSlideNote(courseId, slideId, input, button) {
  button.disabled = true;
  try {
    const response = await fetch(`/api/study/courses/${courseId}/slides/${slideId}/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ note: input.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save note.');
    showMessage('Private note saved.', 'success');
    return data;
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
    return null;
  } finally {
    button.disabled = false;
  }
}

function openSlideReader(courseId, slide, pageNumber = 1) {
  currentReadingSlide = { courseId, slide };
  $('reader-title').textContent = slide.original_name;
  $('slide-notes').value = slide.note || '';
  $('notes-count').textContent = `${$('slide-notes').value.length} / 10,000`;
  $('reader-complete-btn').textContent = slide.is_completed ? '✓ Chapter complete' : 'Mark chapter complete';
  $('reader-complete-btn').classList.toggle('is-complete', slide.is_completed);
  const notice = $('reader-notice');
  const canvas = $('slide-canvas');
  const download = $('reader-download');
  const pageToolbar = $('reader-page-toolbar');
  canvas.classList.add('hidden');
  download.href = `/api/study/courses/${courseId}/slides/${slide.id}/download`;
  $('reader-page-count').textContent = '';
  $('reader-prev-page').disabled = true;
  $('reader-next-page').disabled = true;
  $('reader-page-count').textContent = 'Loading slide preview…';
  pageToolbar.classList.remove('hidden');
  const extension = slide.original_name?.split('.').pop()?.toLowerCase();
  notice.textContent = extension === 'pdf'
    ? 'Loading slide preview…'
    : 'Preparing PowerPoint preview… The first open may take longer.';
  notice.classList.remove('hidden');
  $('modal-reader').classList.remove('hidden');
  $('slide-notes').focus();
  loadSlidePdf(courseId, slide, pageNumber);
}

function closeSlideReader() {
  $('modal-reader').classList.add('hidden');
  if (currentPdfRenderTask) currentPdfRenderTask.cancel();
  currentPdfRenderTask = null;
  const loadingTask = currentPdfLoadingTask;
  currentPdfLoadingTask = null;
  currentPdfDocument = null;
  if (loadingTask) loadingTask.destroy().catch((error) => console.warn('Could not release slide preview:', error.message));
  $('slide-canvas').classList.add('hidden');
  currentReadingSlide = null;
}

async function loadSlidePdf(courseId, slide, requestedPage = 1) {
  const readingSlide = currentReadingSlide;
  const notice = $('reader-notice');
  const finishLoading = beginAppLoading('Opening your slide…');
  try {
    const pdfjs = await (pdfModulePromise || (pdfModulePromise = import('/api/study/pdfjs/pdf.mjs')));
    pdfjs.GlobalWorkerOptions.workerSrc = '/api/study/pdfjs/pdf.worker.mjs';
    const previewUrl = `/api/study/courses/${courseId}/slides/${slide.id}/view`;
    const loadingTask = pdfjs.getDocument({
      url: previewUrl,
      withCredentials: true,
      disableStream: true,
      disableAutoFetch: true,
    });
    currentPdfLoadingTask = loadingTask;
    const document = await loadingTask.promise;
    if (currentReadingSlide !== readingSlide) {
      await loadingTask.destroy();
      return;
    }
    currentPdfDocument = document;
    const pageNumber = Math.max(1, Math.min(document.numPages, Number(requestedPage) || 1));
    $('reader-page-count').textContent = `Page ${pageNumber} of ${document.numPages}`;
    $('reader-prev-page').disabled = pageNumber <= 1;
    $('reader-next-page').disabled = pageNumber >= document.numPages;
    await renderSlidePage(pageNumber);
  } catch (error) {
    if (currentReadingSlide !== readingSlide) return;
    notice.textContent = error.message || 'Could not display this slide. Please try again.';
    notice.classList.remove('hidden');
    $('reader-page-count').textContent = 'Slide unavailable';
    showMessage(notice.textContent, 'error');
  } finally {
    finishLoading();
  }
}

async function renderSlidePage(pageNumber) {
  if (!currentPdfDocument) return;
  const pdfDocument = currentPdfDocument;
  if (currentPdfRenderTask) currentPdfRenderTask.cancel();
  const page = await pdfDocument.getPage(pageNumber);
  if (currentPdfDocument !== pdfDocument) return;
  const canvas = $('slide-canvas');
  const context = canvas.getContext('2d');
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(($('reader-page').clientWidth - 32) / baseViewport.width, 1.5);
  const viewport = page.getViewport({ scale });
  const pixelRatio = 2;
  canvas.width = Math.floor(viewport.width * pixelRatio);
  canvas.height = Math.floor(viewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  canvas.classList.remove('hidden');
  $('reader-notice').classList.add('hidden');
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  const renderTask = page.render({ canvasContext: context, viewport });
  currentPdfRenderTask = renderTask;
  try {
    await renderTask.promise;
  } catch (error) {
    if (error.name !== 'RenderingCancelledException') throw error;
  } finally {
    if (currentPdfRenderTask === renderTask) currentPdfRenderTask = null;
  }
  if (currentPdfDocument !== pdfDocument) return;
  $('reader-page-count').textContent = `Page ${pageNumber} of ${pdfDocument.numPages}`;
  $('reader-prev-page').disabled = pageNumber <= 1;
  $('reader-next-page').disabled = pageNumber >= pdfDocument.numPages;
}

async function changeSlidePage(direction) {
  if (!currentPdfDocument) return;
  const match = $('reader-page-count').textContent.match(/Page (\d+) of/);
  if (!match) return;
  const nextPage = Number(match[1]) + direction;
  if (nextPage < 1 || nextPage > currentPdfDocument.numPages) return;
  const finishLoading = beginAppLoading('Turning the page…');
  $('reader-prev-page').disabled = true;
  $('reader-next-page').disabled = true;
  try {
    await renderSlidePage(nextPage);
  } catch (error) {
    showMessage(error.message || 'Could not render this slide page.', 'error');
  } finally {
    finishLoading();
  }
}

function openSuggestedSlide(suggestion) {
  if (!suggestion.courseId || !suggestion.slideId) return;
  const card = document.querySelector(`.course-card[data-course-id="${suggestion.courseId}"]`);
  const button = card && [...card.querySelectorAll('.course-actions button')]
    .find((control) => control.textContent === 'View files' || control.textContent === 'Hide files');
  if (!button) return showMessage('This course is no longer available.', 'error');
  if (button.textContent === 'View files') {
    toggleCourseFiles(suggestion.courseId, card, button).then(() => {
      $('modal-coach').classList.add('hidden');
      const opener = card.querySelector(`.course-file-item[data-slide-id="${suggestion.slideId}"] .file-link`);
      if (opener) opener.click();
      else showMessage('This chapter is no longer available.', 'error');
    });
    return;
  }
  $('modal-coach').classList.add('hidden');
  const opener = card.querySelector(`.course-file-item[data-slide-id="${suggestion.slideId}"] .file-link`);
  if (opener) opener.click();
  else showMessage('This chapter is no longer available.', 'error');
}

function startCoachSession(suggestion) {
  currentCoachSuggestion = suggestion;
  $('coach-session-title').textContent = suggestion.title;
  $('coach-session-reason').textContent = suggestion.reason || suggestion.detail;
  const evidence = $('coach-session-evidence');
  evidence.textContent = suggestion.evidence
    ? `From ${suggestion.fileName || 'your slide'}${suggestion.page ? `, page ${suggestion.page}` : ''}: “${suggestion.evidence}”`
    : 'No slide excerpt is available for this activity.';
  evidence.classList.toggle('hidden', !suggestion.evidence);
  $('coach-response').value = '';
  $('coach-response').placeholder = suggestion.practicePrompt || 'Write your answer in your own words…';
  const stepsByMode = {
    learn: [
      'Preview the chapter and set one question you want it to answer.',
      'Study one section at a time; pause after each section and explain its main idea.',
      'Answer the prompt below from memory before checking the slide.',
      'Reopen the chapter, correct gaps, and capture the key learning in your own words.',
    ],
    practice: [
      'Close the slide and notes first. Retrieve what you remember without looking.',
      'Write a clear answer and include an example, reason, or connection.',
      'Open the chapter only to check your answer and correct anything you missed.',
      'Save a short reflection so the coach can personalize your next review.',
    ],
    review: [
      'Try to recall the central idea and one example before reopening the material.',
      'Check the slide, then explain any forgotten part in your own words.',
      'Save what was difficult; use it as the focus of your next review.',
    ],
    plan: [
      'Choose one learning outcome you want from your first chapter.',
      'Add a slide, then study it in small sections.',
      'Finish with a closed-book explanation and save any questions in your notes.',
    ],
  };
  const steps = stepsByMode[suggestion.mode] || stepsByMode.practice;
  $('coach-session-steps').replaceChildren(...steps.map((step) => {
    const item = element('li', '', step);
    return item;
  }));
  $('save-coach-response').disabled = !suggestion.slideId;
  $('open-coach-slide').classList.toggle('hidden', !suggestion.slideId);
  $('modal-coach').classList.remove('hidden');
  $('coach-response').focus();
}

async function saveCoachReflection() {
  if (!currentCoachSuggestion?.slideId) {
    showMessage('Open a chapter first to save a reflection to its private notes.', 'info');
    return;
  }
  const answer = $('coach-response').value.trim();
  if (!answer) {
    showMessage('Write a short reflection before saving it.', 'info');
    $('coach-response').focus();
    return;
  }
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date());
  const reflection = `Coach reflection (${date}):\n${answer}`;
  const previousNote = currentCoachSuggestion.privateNote || '';
  const combinedNote = previousNote ? `${previousNote}\n\n${reflection}` : reflection;
  const input = $('coach-response');
  const button = $('save-coach-response');
  const originalValue = input.value;
  input.value = combinedNote;
  const result = await saveSlideNote(
    currentCoachSuggestion.courseId,
    currentCoachSuggestion.slideId,
    input,
    button
  );
  input.value = originalValue;
  if (result) {
    currentCoachSuggestion.privateNote = combinedNote;
    showMessage('Reflection added to your private chapter notes.', 'success');
  }
}

async function renderStudySuggestions(suggestions) {
  const root = $('study-suggestions');
  if (!suggestions.length) {
    root.replaceChildren(element('li', 'empty-state', 'No reliable content-based suggestions are available from these files yet.'));
    return;
  }
  const first = suggestions[0];
  $('coach-headline').textContent = first.title === 'AI-generated study insights'
    ? 'Insights from your course materials'
    : first.mode === 'learn'
    ? 'A focused plan for your next chapter'
    : first.mode === 'review'
      ? 'Time to strengthen what you learned'
      : 'Your personalized learning plan';
  root.replaceChildren(...suggestions.map((suggestion) => {
    const item = element('li', 'study-suggestion');
    const text = element('div', 'suggestion-copy');
    text.append(
      element('strong', '', suggestion.title),
      element('span', suggestion.citations ? 'suggestion-ai-answer' : '', suggestion.detail),
      element('span', 'suggestion-reason', suggestion.reason || '')
    );
    if (suggestion.citations?.length) {
      const citationList = element('div', 'suggestion-citations');
      suggestion.citations.forEach((citation, index) => {
        const button = element('button', 'notebook-citation', `[${index + 1}] ${citation.fileName} · p. ${citation.page}`);
        button.type = 'button';
        button.title = citation.quote;
        button.addEventListener('click', () => {
          openSlideReader(citation.courseId, {
            id: citation.slideId,
            original_name: citation.fileName,
            is_completed: false,
            note: '',
          }, citation.page);
        });
        citationList.append(button);
      });
      text.append(citationList);
    }
    if (suggestion.evidence) {
      const evidence = element('blockquote', 'suggestion-evidence', `“${suggestion.evidence}”`);
      text.append(evidence);
      if (suggestion.topics?.length) {
        text.append(element('span', 'suggestion-topics', `Topics found: ${suggestion.topics.join(' · ')}`));
      }
    }
    item.append(text);
    const actions = element('div', 'suggestion-actions');
    if (suggestion.practicePrompt) {
      const practice = element('button', 'progress-toggle suggestion-action', 'Start practice');
      practice.type = 'button';
      practice.addEventListener('click', () => startCoachSession(suggestion));
      actions.append(practice);
    }
    if (suggestion.slideId) {
      const open = element('button', 'small-button small-button-muted suggestion-action', 'Open chapter');
      open.type = 'button';
      open.addEventListener('click', () => openSuggestedSlide(suggestion));
      actions.append(open);
    }
    item.append(actions);
    return item;
  }));
}

async function updateSlideProgress(courseId, slideId, completed) {
  try {
    const response = await fetch(`/api/study/courses/${courseId}/slides/${slideId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ completed }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update progress.');
    showMessage(completed ? 'Nice work — progress saved.' : 'Progress updated.', 'success');
    await loadDashboard();
    const updatedCard = document.querySelector(`.course-card[data-course-id="${courseId}"]`);
    if (updatedCard) {
      const updatedFilesButton = [...updatedCard.querySelectorAll('.course-actions button')]
        .find((control) => control.textContent === 'View files');
      if (updatedFilesButton) await toggleCourseFiles(courseId, updatedCard, updatedFilesButton);
    }
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  }
}

function renderRecentUploads(slides) {
  const root = $('recent-uploads');
  if (!slides.length) {
    root.replaceChildren(element('li', 'empty-state', 'New slide uploads will appear here.'));
    return;
  }
  root.replaceChildren(...slides.map((slide) => {
    const item = element('li', 'recent-item');
    const openButton = element('button', 'recent-file', slide.original_name);
    openButton.type = 'button';
    openButton.setAttribute('aria-label', `Open ${slide.original_name}`);
    openButton.addEventListener('click', () => openSlideReader(slide.course_id, slide));
    const details = element('span', 'recent-meta', `${slide.course_title} · ${formatDate(slide.created_at)}`);
    item.append(element('span', 'recent-icon', '↗'), element('span', 'recent-copy'));
    item.lastChild.append(openButton, details);
    return item;
  }));
}

/* --- Login --- */
$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('login-form').checkValidity()) {
    $('login-form').reportValidity();
    return;
  }
  const username = $('username').value.trim();
  const password = $('password').value;

  const loginButton = $('login-btn');
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  loginButton.setAttribute('aria-busy', 'true');
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();

    if (!r.ok) return showMessage(data.error || 'Login failed.', 'error');

    if (data.step === '2fa') {
      showMessage('A verification code was sent to your email.', 'info');
      show2FA(data.email);
    } else {
      showMessage('Login successful.', 'success');
      showDashboard(data.user);
    }
  } catch (e) {
    showMessage(networkErrorMessage, 'error');
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Sign in';
    loginButton.removeAttribute('aria-busy');
  }
});

/* --- Account registration --- */
$('login-tab').addEventListener('click', () => {
  if ($('login-tab').getAttribute('aria-selected') === 'true') return;
  showLogin();
  showMessage('', 'info');
  $('username').focus();
});

$('register-tab').addEventListener('click', () => {
  if ($('register-tab').getAttribute('aria-selected') === 'true') return;
  showRegister();
  showMessage('', 'info');
  $('register-username').focus();
});

$('auth-mode-switch').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const nextTab = event.key === 'Home' || event.key === 'ArrowLeft'
    ? $('login-tab')
    : $('register-tab');
  nextTab.click();
  nextTab.focus();
});

$('register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('register-form').checkValidity()) {
    $('register-form').reportValidity();
    return;
  }
  const username = $('register-username').value.trim();
  const email = $('register-email').value.trim();
  const password = $('register-password').value;

  const registerButton = $('register-btn');
  registerButton.disabled = true;
  registerButton.textContent = 'Creating account…';
  registerButton.setAttribute('aria-busy', 'true');
  try {
    const r = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ username, email, password }),
    });
    const data = await r.json();

    if (!r.ok) return showMessage(data.error || 'Could not create account.', 'error');

    if (data.step === 'email-verification') {
      $('register-password').value = '';
      resetOtp();
      show2FA(data.deliveryAddress || data.email, 'registration');
      showMessage(
        `Gmail accepted a verification email for ${data.deliveryAddress || data.email}. Search Gmail for in:anywhere subject:"Your LogiAuth verification code" and use the newest code if you requested a resend.`,
        'info'
      );
      return;
    }

    showMessage('Could not start account verification. Please try again.', 'error');
  } catch (err) {
    showMessage(networkErrorMessage, 'error');
  } finally {
    registerButton.disabled = false;
    registerButton.textContent = 'Create account';
    registerButton.removeAttribute('aria-busy');
  }
});

/* --- Resend email verification code --- */
$('resend-code-btn').addEventListener('click', async () => {
  $('resend-code-btn').disabled = true;
  try {
    const r = await fetch('/api/auth/resend-2fa', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const data = await r.json();
    if (!r.ok) {
      showMessage(data.error || 'Could not resend the code.', 'error');
      return;
    }

    resetOtp();
    otpSlots[0].focus();
    showMessage(data.message, 'success');
  } catch (err) {
    showMessage(networkErrorMessage, 'error');
  } finally {
    $('resend-code-btn').disabled = false;
  }
});

/* --- 2FA input and auto-submit --- */
const otpContainer = $('otp-container');
const otpSlots = document.querySelectorAll('.slot');
let otpErrorTimer;

const resetOtp = () => {
  otpSlots.forEach((slot) => {
    slot.value = '';
    slot.classList.remove('active');
  });
};

const verifyOtp = async () => {
  const value = [...otpSlots].map((slot) => slot.value).join('');
  if (value.length !== 6 || !/^\d{6}$/.test(value)) return;

  otpSlots.forEach((slot) => { slot.disabled = true; });
  try {
    const isRegistration = verificationPurpose === 'registration';
    const r = await fetch(isRegistration ? '/api/auth/verify-registration' : '/api/auth/verify-2fa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: value }),
    });
    const data = await r.json();

    if (!r.ok) {
      showMessage(data.error || 'Invalid code.', 'error');
      otpContainer.classList.add('error');
      otpErrorTimer = setTimeout(() => {
        otpContainer.classList.remove('error');
        resetOtp();
        otpSlots.forEach((slot) => { slot.disabled = false; });
        otpSlots[0].focus();
      }, 600);
      return;
    }

    if (isRegistration) {
      clearTimeout(otpErrorTimer);
      otpContainer.classList.add('verify');
      setTimeout(() => {
        showDashboard(data.user);
        otpContainer.classList.remove('verify');
        resetOtp();
        otpSlots.forEach((slot) => { slot.disabled = false; });
        showMessage(
          data.welcomeEmailSent
            ? 'Email verified. Your account is ready, and you’re signed in. A welcome email is on its way.'
            : 'Email verified. Your account is ready and you’re signed in, but we could not send the welcome email.',
          data.welcomeEmailSent ? 'success' : 'info'
        );
        verificationPurpose = 'login';
      }, 1500);
      return;
    }

    otpContainer.classList.add('verify');
    setTimeout(() => {
      showMessage('2FA verified.', 'success');
      showDashboard(data.user);
      otpContainer.classList.remove('verify');
      resetOtp();
      otpSlots.forEach((slot) => { slot.disabled = false; });
    }, 1500);
  } catch (err) {
    showMessage(networkErrorMessage, 'error');
    resetOtp();
    otpSlots.forEach((slot) => { slot.disabled = false; });
    otpSlots[0].focus();
  }
};

otpSlots.forEach((slot, index) => {
  slot.addEventListener('input', () => {
    const digits = slot.value.replace(/\D/g, '');
    if (!digits) {
      slot.value = '';
      slot.classList.remove('active');
      return;
    }

    if (digits.length > 1) {
      const pasted = digits.slice(0, 6);
      pasted.split('').forEach((digit, offset) => {
        if (otpSlots[offset]) {
          otpSlots[offset].value = digit;
          otpSlots[offset].classList.add('active');
        }
      });
      otpSlots[Math.min(pasted.length, 6) - 1]?.focus();
    } else {
      slot.value = digits;
      slot.classList.add('active');
      otpSlots[index + 1]?.focus();
    }

    if ([...otpSlots].every((input) => input.value.length === 1)) {
      verifyOtp();
    }
  });

  slot.addEventListener('keydown', (event) => {
    if (event.key === 'Backspace' && !slot.value && index > 0) {
      otpSlots[index - 1].focus();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      otpSlots[index - 1].focus();
    } else if (event.key === 'ArrowRight' && index < otpSlots.length - 1) {
      otpSlots[index + 1].focus();
    }
  });
});

$('back-btn').addEventListener('click', () => {
  clearTimeout(otpErrorTimer);
  otpContainer.classList.remove('error', 'verify');
  otpSlots.forEach((slot) => { slot.disabled = false; });
  resetOtp();
  if (verificationPurpose === 'registration') {
    showRegister();
    $('register-username').focus();
  } else {
    showLogin();
    $('username').focus();
  }
  verificationPurpose = 'login';
  showMessage('', 'info');
});

/* --- Study dashboard and slide uploads --- */
$('refresh-dashboard-btn').addEventListener('click', loadDashboard);
$('retry-coach-btn').addEventListener('click', () => loadContentCoach({ refresh: true }));

$('show-course-form-btn').addEventListener('click', () => {
  $('course-form').classList.remove('hidden');
  $('course-title').focus();
});

$('cancel-course-btn').addEventListener('click', () => {
  $('course-form').reset();
  $('course-form').classList.add('hidden');
});

$('course-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('create-course-btn');
  button.disabled = true;
  try {
    const response = await fetch('/api/study/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        title: $('course-title').value.trim(),
        description: $('course-description').value.trim(),
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not create course.');
    $('course-form').reset();
    $('course-form').classList.add('hidden');
    showMessage('Course created.', 'success');
    await loadDashboard();
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  } finally {
    button.disabled = false;
  }
});

$('semester-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('semester-save-button');
  const courseIds = [...$('semester-course-options').querySelectorAll('.semester-course-check:checked')]
    .map((checkbox) => Number(checkbox.value));
  const courseNames = [...new Set($('semester-custom-courses').value
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean))];
  if (!courseIds.length && !courseNames.length) {
    $('semester-save-status').textContent = 'Select a course or type at least one course name.';
    return;
  }
  if (courseIds.length + courseNames.length > 50) {
    $('semester-save-status').textContent = 'Add no more than 50 courses to your semester plan.';
    return;
  }
  button.disabled = true;
  $('semester-save-status').textContent = 'Saving your semester plan…';
  try {
    const response = await fetch('/api/study/semester', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        program: $('semester-program').value.trim(),
        semester: $('semester-name').value.trim(),
        courseIds,
        courseNames,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save your semester plan.');
    $('semester-save-status').textContent = 'Semester plan saved. Your exam-prep courses are ready.';
    $('semester-custom-courses').value = '';
    showMessage('Your semester plan is saved.', 'success');
    await loadDashboard();
  } catch (error) {
    $('semester-save-status').textContent = error.message || 'Could not save your semester plan.';
  } finally {
    button.disabled = false;
  }
});

const uploadModal = $('modal-upload');
const uploadCourt = $('upload-court');
const dropzone = $('dropzone');
const fileInput = $('slide-file-input');
const fileInfo = $('file-info');
const uploadProgress = $('upload-progress');
const uploadProgressTrack = $('upload-progress-track');
const uploadPercent = $('upload-percent');
const uploadStatus = $('upload-status');
const closeUploadButton = document.querySelector('[data-close-modal]');
let activeUploadRequest;

function setUploadProgress(percent) {
  const value = Math.max(0, Math.min(100, percent));
  uploadProgress.style.width = `${value}%`;
  uploadProgressTrack.setAttribute('aria-valuenow', String(value));
  uploadPercent.textContent = `${value}%`;
}

function openUpload(course) {
  activeUploadCourse = course;
  uploadCourt.classList.remove('shooting', 'swish', 'upload-error', 'scored');
  $('upload-success').classList.add('hidden');
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  $('dropzone-prompt').classList.remove('hidden');
  $('file-name').textContent = '';
  setUploadProgress(0);
  uploadStatus.textContent = 'Preparing upload…';
  uploadStatus.className = '';
  closeUploadButton.disabled = false;
  uploadModal.classList.remove('hidden');
  dropzone.focus();
}

function closeUpload() {
  if (activeUploadRequest) return;
  uploadModal.classList.add('hidden');
  activeUploadCourse = null;
}

function startSlideUpload(file) {
  if (!activeUploadCourse || !file) return;
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!['.pdf', '.ppt', '.pptx'].includes(extension)) {
    showMessage('Choose a PDF, PPT, or PPTX file.', 'error');
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    showMessage('File is too large. The maximum is 25 MB.', 'error');
    return;
  }

  $('dropzone-prompt').classList.add('hidden');
  fileInfo.classList.remove('hidden');
  $('file-name').textContent = file.name;
  const fileType = extension.slice(1).toUpperCase();
  $('projectile-type').textContent = fileType;
  $('upload-success-detail').textContent = `${file.name} saved to ${activeUploadCourse.title}.`;
  uploadStatus.textContent = 'Uploading…';
  setUploadProgress(0);
  uploadCourt.classList.remove('swish', 'upload-error', 'scored');
  uploadCourt.classList.add('shooting');
  closeUploadButton.disabled = true;
  dropzone.disabled = true;

  const formData = new FormData();
  formData.append('slide', file);
  formData.append('title', file.name);
  const request = new XMLHttpRequest();
  const finishLoading = beginAppLoading('Saving your slide…');
  activeUploadRequest = request;
  request.open('POST', `/api/study/courses/${activeUploadCourse.id}/slides`);
  request.withCredentials = true;
  request.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.min(95, Math.round((event.loaded / event.total) * 95));
    setUploadProgress(percent);
  });
  request.addEventListener('load', async () => {
    finishLoading();
    activeUploadRequest = null;
    let data;
    try {
      data = JSON.parse(request.responseText);
    } catch {
      data = {};
    }
    if (request.status < 200 || request.status >= 300) {
      closeUploadButton.disabled = false;
      dropzone.disabled = false;
      uploadCourt.classList.remove('shooting');
      uploadCourt.classList.add('upload-error');
      uploadStatus.textContent = data.error || 'Upload failed.';
      uploadStatus.className = 'upload-status-error';
      showMessage(data.error || 'Could not upload the slide.', 'error');
      return;
    }

    uploadCourt.classList.remove('shooting');
    uploadCourt.classList.add('scored');
    const projectile = $('upload-projectile');
    let finished = false;
    const finishShot = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(scoreTimer);
      setUploadProgress(100);
      uploadStatus.textContent = 'Upload complete';
      uploadStatus.className = 'upload-status-success';
      closeUploadButton.disabled = false;
      dropzone.disabled = false;
      $('upload-success').classList.remove('hidden');
      $('upload-done-btn').focus();
      showMessage('Slide uploaded successfully.', 'success');
      await loadDashboard();
    };
    const scoreTimer = setTimeout(finishShot, 1300);
    projectile.addEventListener('animationend', finishShot, { once: true });
    setTimeout(() => uploadCourt.classList.add('swish'), 650);
  });
  request.addEventListener('error', () => {
    finishLoading();
    activeUploadRequest = null;
    closeUploadButton.disabled = false;
    dropzone.disabled = false;
    uploadCourt.classList.remove('shooting');
    uploadCourt.classList.add('upload-error');
    uploadStatus.textContent = 'Connection lost. Try again.';
    uploadStatus.className = 'upload-status-error';
    showMessage(networkErrorMessage, 'error');
  });
  request.send(formData);
}

dropzone.addEventListener('click', () => {
  if (!activeUploadRequest) fileInput.click();
});
fileInput.addEventListener('change', () => {
  startSlideUpload(fileInput.files[0]);
});
uploadCourt.addEventListener('dragover', (event) => {
  event.preventDefault();
  uploadCourt.classList.add('drag-over');
});
uploadCourt.addEventListener('dragleave', (event) => {
  if (!uploadCourt.contains(event.relatedTarget)) uploadCourt.classList.remove('drag-over');
});
uploadCourt.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadCourt.classList.remove('drag-over');
  if (!activeUploadRequest) startSlideUpload(event.dataTransfer.files[0]);
});
closeUploadButton.addEventListener('click', closeUpload);
$('upload-done-btn').addEventListener('click', closeUpload);
uploadModal.addEventListener('click', (event) => {
  if (event.target === uploadModal) closeUpload();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !uploadModal.classList.contains('hidden')) closeUpload();
  if (event.key === 'Escape' && !$('modal-reader').classList.contains('hidden')) closeSlideReader();
  if (event.key === 'Escape' && !$('modal-coach').classList.contains('hidden')) $('modal-coach').classList.add('hidden');
  if (event.key === 'Escape' && !$('modal-notebook').classList.contains('hidden')) $('modal-notebook').classList.add('hidden');
});

$('close-reader-btn').addEventListener('click', closeSlideReader);
$('close-coach-btn').addEventListener('click', () => $('modal-coach').classList.add('hidden'));
$('modal-coach').addEventListener('click', (event) => {
  if (event.target === $('modal-coach')) $('modal-coach').classList.add('hidden');
});
$('close-notebook-btn').addEventListener('click', () => $('modal-notebook').classList.add('hidden'));
$('modal-notebook').addEventListener('click', (event) => {
  if (event.target === $('modal-notebook')) $('modal-notebook').classList.add('hidden');
});
$('notebook-select-all').addEventListener('click', () => {
  if (!currentNotebook) return;
  const checkboxes = [...$('notebook-source-list').querySelectorAll('.notebook-source-check')];
  const shouldSelect = selectedNotebookSourceIds().length !== checkboxes.length;
  checkboxes.forEach((checkbox, index) => { checkbox.checked = shouldSelect && index < 12; });
  updateNotebookSelection();
});
$('notebook-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('notebook-question').value.trim();
  if (question) askNotebook(question);
});
$('notebook-prompts').addEventListener('click', (event) => {
  const button = event.target.closest('[data-prompt]');
  if (!button) return;
  $('notebook-question').value = button.dataset.prompt;
  $('notebook-question').focus();
});
$('notebook-question').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('notebook-form').requestSubmit();
  }
});
$('save-coach-response').addEventListener('click', saveCoachReflection);
$('open-coach-slide').addEventListener('click', () => {
  if (currentCoachSuggestion) openSuggestedSlide(currentCoachSuggestion);
});
$('reader-prev-page').addEventListener('click', () => changeSlidePage(-1));
$('reader-next-page').addEventListener('click', () => changeSlidePage(1));
$('dashboard-ask-gemini').addEventListener('click', (event) => {
  const courseId = Number(event.currentTarget.dataset.courseId);
  if (courseId) openCourseNotebook(courseId);
});
$('modal-reader').addEventListener('click', (event) => {
  if (event.target === $('modal-reader')) closeSlideReader();
});
$('slide-notes').addEventListener('input', () => {
  $('notes-count').textContent = `${$('slide-notes').value.length} / 10,000`;
});
$('save-notes-btn').addEventListener('click', async () => {
  if (!currentReadingSlide) return;
  const result = await saveSlideNote(
    currentReadingSlide.courseId,
    currentReadingSlide.slide.id,
    $('slide-notes'),
    $('save-notes-btn')
  );
  if (result) currentReadingSlide.slide.note = $('slide-notes').value;
});
$('reader-complete-btn').addEventListener('click', async () => {
  if (!currentReadingSlide) return;
  const completed = !currentReadingSlide.slide.is_completed;
  try {
    const response = await fetch(`/api/study/courses/${currentReadingSlide.courseId}/slides/${currentReadingSlide.slide.id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ completed }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update progress.');
    currentReadingSlide.slide.is_completed = completed;
    $('reader-complete-btn').textContent = completed ? '✓ Chapter complete' : 'Mark chapter complete';
    $('reader-complete-btn').classList.toggle('is-complete', completed);
    await loadDashboard();
    showMessage(completed ? 'Chapter completed — progress saved.' : 'Chapter marked as in progress.', 'success');
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  }
});

/* --- Backup (admin) --- */
$('backup-btn').addEventListener('click', async () => {
  $('backup-btn').disabled = true;
  showMessage('Backing up to Supabase…', 'info');
  try {
    const r = await fetch('/api/backup', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Backup failed.');
    showMessage('☁️ Backup complete!', 'success');
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  } finally {
    $('backup-btn').disabled = false;
  }
});

/* --- Logout --- */
$('logout-btn').addEventListener('click', async () => {
  if (!window.confirm('Log out of LogiAuth? You can sign in again at any time.')) return;

  $('logout-btn').disabled = true;
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not log out.');
    currentUser = null;
    clearInterval(activityHeartbeat);
    showLogin();
    showMessage('Logged out.', 'info');
  } catch (error) {
    showMessage(error.message || networkErrorMessage, 'error');
  } finally {
    $('logout-btn').disabled = false;
  }
});

/* --- Session check on page load --- */
(async () => {
  if (location.protocol === 'file:') {
    hideAll();
    document.querySelector('.auth-panel').classList.remove('dashboard-open');
    $('file-launch-help').classList.remove('hidden');
    return;
  }

  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.ok) {
      const { user } = await r.json();
      showDashboard(user);
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
    showMessage(networkErrorMessage, 'error');
  }
})();