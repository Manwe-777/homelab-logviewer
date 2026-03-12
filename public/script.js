(function() {
  'use strict';

  // DOM refs
  const tabsEl = document.getElementById('tabs');
  const logContent = document.getElementById('log-content');
  const logViewport = document.getElementById('log-viewport');
  const loadingEl = document.getElementById('loading');
  const statusIndicator = document.getElementById('status-indicator');
  const statusText = document.getElementById('status-text');
  const truncatedNotice = document.getElementById('truncated-notice');
  const lineCount = document.getElementById('line-count');
  const btnSearch = document.getElementById('btn-search');
  const btnAutoscroll = document.getElementById('btn-autoscroll');
  const btnWrap = document.getElementById('btn-wrap');
  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const searchInfo = document.getElementById('search-info');
  const searchPrev = document.getElementById('search-prev');
  const searchNext = document.getElementById('search-next');
  const searchClose = document.getElementById('search-close');

  let sources = [];
  let activeSourceId = null;
  let pollInterval = 2000;
  let pollTimer = null;
  let autoScroll = true;
  let wordWrap = false;

  // Per-source state
  const sourceState = {};
  let statusTimer = null;

  // Search state
  let searchTerm = '';
  let searchMatches = [];
  let searchIndex = -1;

  // Log level detection patterns
  const LEVEL_PATTERNS = [
    { regex: /\b(FATAL|EMERGENCY|EMERG)\b/i, cls: 'level-fatal' },
    { regex: /\b(ERROR|ERR|CRITICAL|CRIT)\b/i, cls: 'level-error' },
    { regex: /\b(WARN|WARNING)\b/i, cls: 'level-warn' },
    { regex: /\b(INFO|NOTICE)\b/i, cls: 'level-info' },
    { regex: /\b(DEBUG|TRACE)\b/i, cls: 'level-debug' },
  ];

  function detectLevel(line) {
    for (const p of LEVEL_PATTERNS) {
      if (p.regex.test(line)) return p.cls;
    }
    return '';
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlightSearch(html, term) {
    if (!term) return html;
    const escaped = escapeRegex(term);
    const regex = new RegExp(`(${escaped})`, 'gi');
    return html.replace(regex, '<mark>$1</mark>');
  }

  function renderLines(lines) {
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
      const span = document.createElement('span');
      span.className = 'log-line ' + detectLevel(line);
      let html = escapeHtml(line);
      if (searchTerm) html = highlightSearch(html, searchTerm);
      span.innerHTML = html + '\n';
      fragment.appendChild(span);
    }
    return fragment;
  }

  function scrollToBottom() {
    if (autoScroll) {
      logViewport.scrollTop = logViewport.scrollHeight;
    }
  }

  // Detect if user scrolls away from bottom
  logViewport.addEventListener('scroll', () => {
    const atBottom = logViewport.scrollTop + logViewport.clientHeight >= logViewport.scrollHeight - 20;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      btnAutoscroll.classList.remove('active');
    }
  });

  // Fetch and display container/source status
  async function updateStatus(id) {
    try {
      const res = await fetch(`/api/status/${id}`);
      const data = await res.json();
      // Only update if still on the same tab
      if (id !== activeSourceId) return;

      const src = sources.find(s => s.id === id);
      const name = src?.name || 'Log';

      statusIndicator.className = 'status-indicator';
      if (data.status === 'running') {
        statusIndicator.classList.add('live');
        statusText.textContent = name;
      } else if (data.status === 'unhealthy') {
        statusIndicator.classList.add('unhealthy');
        statusText.textContent = name + ' (unhealthy)';
      } else {
        statusIndicator.classList.add('dead');
        statusText.textContent = name + ' (' + data.detail + ')';
      }
    } catch {
      // keep whatever status we had
    }
  }

  function startStatusPolling(id) {
    if (statusTimer) clearInterval(statusTimer);
    updateStatus(id);
    // Check status every 10s (less frequent than log polling)
    statusTimer = setInterval(() => updateStatus(id), 10000);
  }

  // Tab switching
  function switchTab(id) {
    if (activeSourceId === id) return;
    activeSourceId = id;

    // Update tab UI
    tabsEl.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', parseInt(t.dataset.id) === id);
    });

    // Stop current polling
    if (pollTimer) clearInterval(pollTimer);

    // Start status polling for this tab
    startStatusPolling(id);

    // Render cached content or load fresh
    const state = sourceState[id];
    logContent.innerHTML = '';
    if (state && state.lines.length > 0) {
      logContent.appendChild(renderLines(state.lines));
      truncatedNotice.classList.toggle('hidden', !state.truncated);
      lineCount.textContent = state.lines.length + ' lines';
      scrollToBottom();
      startPolling();
    } else {
      loadLog(id);
    }

    updateSearch();
  }

  async function loadLog(id) {
    logContent.innerHTML = '';
    loadingEl.textContent = 'Loading...';
    loadingEl.classList.remove('hidden');

    try {
      const res = await fetch(`/api/logs/${id}`);
      const data = await res.json();

      if (!sourceState[id]) {
        sourceState[id] = { lines: [], offset: 0, truncated: false };
      }

      sourceState[id].lines = data.lines;
      sourceState[id].offset = data.offset;
      sourceState[id].truncated = data.truncated;

      loadingEl.classList.add('hidden');
      logContent.appendChild(renderLines(data.lines));
      truncatedNotice.classList.toggle('hidden', !data.truncated);
      lineCount.textContent = data.lines.length + ' lines';

      scrollToBottom();
      startPolling();
    } catch (err) {
      loadingEl.textContent = 'Failed to load log: ' + err.message;
    }
  }

  async function pollForUpdates() {
    if (activeSourceId === null) return;
    const id = activeSourceId;
    const state = sourceState[id];
    if (!state) return;

    try {
      const res = await fetch(`/api/logs/${id}?after=${state.offset}`);
      const data = await res.json();

      if (data.lines.length > 0) {
        state.lines.push(...data.lines);
        state.offset = data.offset;
        logContent.appendChild(renderLines(data.lines));
        lineCount.textContent = state.lines.length + ' lines';
        scrollToBottom();
      }
    } catch (err) {
      // Silently retry on next interval
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    if (pollInterval > 0) {
      pollTimer = setInterval(pollForUpdates, pollInterval);
    }
  }

  // Auto-scroll toggle
  btnAutoscroll.addEventListener('click', () => {
    autoScroll = !autoScroll;
    btnAutoscroll.classList.toggle('active', autoScroll);
    if (autoScroll) scrollToBottom();
  });

  // Word wrap toggle
  btnWrap.addEventListener('click', () => {
    wordWrap = !wordWrap;
    btnWrap.classList.toggle('active', wordWrap);
    logContent.style.whiteSpace = wordWrap ? 'pre-wrap' : 'pre';
    logContent.style.wordBreak = wordWrap ? 'break-all' : 'normal';
  });

  // Search functionality
  function openSearch() {
    searchBar.classList.remove('hidden');
    searchInput.focus();
    searchInput.select();
  }

  function closeSearch() {
    searchBar.classList.add('hidden');
    searchTerm = '';
    searchMatches = [];
    searchIndex = -1;
    searchInfo.textContent = '';
    // Re-render without highlights
    reRenderCurrentLog();
  }

  function updateSearch() {
    if (!searchTerm) {
      searchInfo.textContent = '';
      searchMatches = [];
      searchIndex = -1;
      return;
    }
    // Count matches
    const marks = logContent.querySelectorAll('mark');
    searchMatches = Array.from(marks);
    if (searchMatches.length > 0) {
      if (searchIndex < 0) searchIndex = 0;
      if (searchIndex >= searchMatches.length) searchIndex = searchMatches.length - 1;
      searchInfo.textContent = (searchIndex + 1) + '/' + searchMatches.length;
      // Highlight current
      searchMatches.forEach((m, i) => m.classList.toggle('current', i === searchIndex));
      searchMatches[searchIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      searchInfo.textContent = '0 results';
      searchIndex = -1;
    }
  }

  function reRenderCurrentLog() {
    if (activeSourceId === null) return;
    const state = sourceState[activeSourceId];
    if (!state) return;
    logContent.innerHTML = '';
    logContent.appendChild(renderLines(state.lines));
  }

  function doSearch() {
    const term = searchInput.value.trim();
    searchTerm = term;
    searchIndex = -1;
    reRenderCurrentLog();
    updateSearch();
  }

  searchInput.addEventListener('input', doSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) navigateSearch(-1);
      else navigateSearch(1);
    }
    if (e.key === 'Escape') closeSearch();
  });

  function navigateSearch(dir) {
    if (searchMatches.length === 0) return;
    searchIndex = (searchIndex + dir + searchMatches.length) % searchMatches.length;
    searchInfo.textContent = (searchIndex + 1) + '/' + searchMatches.length;
    searchMatches.forEach((m, i) => m.classList.toggle('current', i === searchIndex));
    searchMatches[searchIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  btnSearch.addEventListener('click', () => {
    if (searchBar.classList.contains('hidden')) openSearch();
    else closeSearch();
  });
  searchClose.addEventListener('click', closeSearch);
  searchPrev.addEventListener('click', () => navigateSearch(-1));
  searchNext.addEventListener('click', () => navigateSearch(1));

  // Ctrl+F override
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
  });

  // Init
  async function init() {
    try {
      const res = await fetch('/api/sources');
      const data = await res.json();
      sources = data.sources;
      pollInterval = data.pollInterval || 2000;

      if (sources.length === 0) {
        loadingEl.textContent = 'No log sources configured. Set LOG_SOURCES env variable.';
        statusText.textContent = 'No sources';
        return;
      }

      // Render tabs
      for (const src of sources) {
        const btn = document.createElement('button');
        btn.className = 'tab';
        btn.dataset.id = src.id;
        btn.textContent = src.name;
        btn.addEventListener('click', () => switchTab(src.id));
        tabsEl.appendChild(btn);
      }

      // Activate first tab
      switchTab(sources[0].id);
    } catch (err) {
      loadingEl.textContent = 'Failed to connect: ' + err.message;
      statusText.textContent = 'Error';
    }
  }

  init();
})();
