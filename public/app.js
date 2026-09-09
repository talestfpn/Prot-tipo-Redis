const state = {
  demos: [],
  activeDemo: 'strings',
  busy: false,
  data: null,
};

const elements = {
  demoList: document.querySelector('#demo-list'),
  demoNumber: document.querySelector('#demo-number'),
  demoTitle: document.querySelector('#demo-title'),
  demoDescription: document.querySelector('#demo-description'),
  commandChips: document.querySelector('#command-chips'),
  terminal: document.querySelector('#terminal-output'),
  dataStack: document.querySelector('#data-stack'),
  connectionPill: document.querySelector('#connection-pill'),
  connectionLabel: document.querySelector('#connection-label'),
  commandInput: document.querySelector('#command-input'),
  consoleForm: document.querySelector('#console-form'),
  consoleResponse: document.querySelector('#console-response'),
  toast: document.querySelector('#toast'),
  runButton: document.querySelector('#run-button'),
  runAllButton: document.querySelector('#run-all-button'),
  resetButton: document.querySelector('#reset-button'),
  refreshButton: document.querySelector('#refresh-button'),
  stateRefresh: document.querySelector('#state-refresh'),
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function activeMeta() {
  return state.demos.find((demo) => demo.id === state.activeDemo) || state.demos[0];
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = busy;
  });
  if (busy) elements.runButton.classList.add('loading');
  else elements.runButton.classList.remove('loading');
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => elements.toast.classList.remove('show'), 3200);
}

function renderDemoList() {
  elements.demoList.innerHTML = state.demos.map((demo) => `
    <button class="demo-item ${demo.id === state.activeDemo ? 'active' : ''}" data-demo-id="${escapeHtml(demo.id)}" type="button">
      <span class="demo-icon color-${escapeHtml(demo.color)}">${escapeHtml(demo.icon)}</span>
      <span class="demo-item-text"><strong>${escapeHtml(demo.label)}</strong><span>${escapeHtml(demo.tagline)}</span></span>
    </button>
  `).join('');

  elements.demoList.querySelectorAll('[data-demo-id]').forEach((button) => {
    button.addEventListener('click', () => selectDemo(button.dataset.demoId));
  });
}

function renderActiveDemo() {
  const demo = activeMeta();
  if (!demo) return;
  elements.demoNumber.textContent = `estrutura ${demo.number}`;
  elements.demoTitle.innerHTML = `${escapeHtml(demo.label)} <span class="heading-arrow">↗</span>`;
  elements.demoDescription.innerHTML = `${escapeHtml(demo.description)} <strong>${escapeHtml(demo.concept)}</strong>`;
  elements.commandChips.innerHTML = demo.preview.map((command) => `<span class="command-chip">${escapeHtml(command)}</span>`).join('');
}

function selectDemo(id) {
  state.activeDemo = id;
  renderDemoList();
  renderActiveDemo();
  elements.terminal.innerHTML = '<div class="terminal-empty">Execute um exemplo para acompanhar os comandos.</div>';
}

function formatResult(result) {
  if (result === null || result === undefined) return { text: '(nil)', className: 'null' };
  if (typeof result === 'number') return { text: String(result), className: 'number' };
  if (Array.isArray(result)) {
    return { text: result.length ? JSON.stringify(result) : '[]', className: '' };
  }
  return { text: String(result), className: '' };
}

function renderTerminal(steps) {
  if (!steps?.length) {
    elements.terminal.innerHTML = '<div class="terminal-empty">Nenhum comando executado.</div>';
    return;
  }
  elements.terminal.innerHTML = steps.map((step, index) => {
    const result = formatResult(step.result);
    return `<div class="terminal-line"><span class="terminal-index">${String(index + 1).padStart(2, '0')}</span><div><div class="terminal-command">${escapeHtml(step.command)}</div><div class="terminal-result ${result.className}">↳ ${escapeHtml(result.text)}</div></div></div>`;
  }).join('');
  elements.terminal.scrollTop = elements.terminal.scrollHeight;
}

function ttlText(ttl) {
  if (ttl === -1) return 'sem expiração';
  if (ttl === -2) return 'chave inexistente';
  return `${ttl}s restantes`;
}

function renderValue(record) {
  const value = record.value || {};
  if (value.kind === 'string') return `<div class="value-row"><span class="value-label">valor</span><span class="value-string">${escapeHtml(value.value)}</span></div>`;
  if (value.kind === 'hash') {
    return Object.entries(value.fields || {}).map(([key, item]) => `<div class="value-row"><span class="value-label">${escapeHtml(key)}</span><span class="value-name">${escapeHtml(item)}</span></div>`).join('');
  }
  if (value.kind === 'zset') {
    return `<div class="value-array">${(value.items || []).map((item) => `<span class="value-item">${escapeHtml(item.member)} <span class="score">${escapeHtml(item.score)}</span></span>`).join('')}</div>`;
  }
  return `<div class="value-array">${(value.items || []).map((item) => `<span class="value-item">${escapeHtml(item)}</span>`).join('')}</div>`;
}

function renderData(records = []) {
  if (!records.length) {
    elements.dataStack.innerHTML = '<div class="data-empty">Nenhuma chave de demonstração ainda.</div>';
    return;
  }
  elements.dataStack.innerHTML = records.map((record) => `
    <article class="data-card">
      <div class="data-card-header"><span class="data-key" title="${escapeHtml(record.key)}">${escapeHtml(record.key)}</span><span class="type-pill">${escapeHtml(record.type)}</span></div>
      <div class="data-card-body">${renderValue(record)}</div>
      <div class="ttl-line">TTL <code>${escapeHtml(ttlText(record.ttl))}</code></div>
    </article>
  `).join('');
}

function renderConnection(status) {
  if (!status) return;
  const pill = elements.connectionPill;
  pill.classList.toggle('simulated', !status.isRealRedis);
  pill.classList.toggle('error', Boolean(status.error && status.isRealRedis === false));
  elements.connectionLabel.textContent = status.isRealRedis ? `Redis real · ${status.endpoint}` : 'modo simulado';
  pill.title = status.note || '';
}

function renderState(nextState) {
  state.data = nextState;
  renderData(nextState?.keys || []);
  renderConnection(nextState?.status);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Não foi possível concluir a operação.');
  return payload;
}

async function refreshState({ silent = false } = {}) {
  try {
    const payload = await requestJson('/api/state');
    renderState(payload);
  } catch (error) {
    elements.connectionPill.classList.add('error');
    elements.connectionLabel.textContent = 'servidor indisponível';
    if (!silent) showToast(error.message);
  }
}

async function runDemo(id = state.activeDemo) {
  if (state.busy) return;
  setBusy(true);
  try {
    const payload = await requestJson('/api/demo', { method: 'POST', body: JSON.stringify({ id }) });
    renderTerminal(payload.steps);
    renderState(payload.state);
    showToast(id === 'all' ? 'Roteiro completo executado.' : 'Exemplo executado com sucesso.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function runConsoleCommand(event) {
  event.preventDefault();
  const command = elements.commandInput.value.trim();
  if (!command || state.busy) return;
  setBusy(true);
  elements.consoleResponse.className = 'console-response';
  elements.consoleResponse.textContent = 'executando…';
  try {
    const payload = await requestJson('/api/command', { method: 'POST', body: JSON.stringify({ command }) });
    const result = formatResult(payload.result);
    elements.consoleResponse.className = 'console-response success';
    elements.consoleResponse.innerHTML = `<code>${escapeHtml(payload.command)}</code> → ${escapeHtml(result.text)}`;
    elements.commandInput.value = '';
    renderState(payload.state);
  } catch (error) {
    elements.consoleResponse.className = 'console-response error';
    elements.consoleResponse.textContent = error.message;
  } finally {
    setBusy(false);
    elements.commandInput.focus();
  }
}

async function resetLab() {
  if (state.busy) return;
  setBusy(true);
  try {
    const payload = await requestJson('/api/reset', { method: 'POST', body: '{}' });
    renderState(payload.state);
    elements.terminal.innerHTML = '<div class="terminal-empty">Laboratório limpo. Escolha um exemplo para começar.</div>';
    elements.consoleResponse.className = 'console-response';
    elements.consoleResponse.textContent = `${payload.removed} chave(s) removida(s) do namespace seminario:*.`;
    showToast('Laboratório limpo.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setBusy(false);
  }
}

async function boot() {
  try {
    const payload = await requestJson('/api/demos');
    state.demos = payload.demos;
    renderDemoList();
    renderActiveDemo();
    await refreshState({ silent: true });
  } catch (error) {
    elements.connectionLabel.textContent = 'servidor indisponível';
    elements.connectionPill.classList.add('error');
    showToast(error.message);
  }
}

elements.runButton.addEventListener('click', () => runDemo());
elements.runAllButton.addEventListener('click', () => runDemo('all'));
elements.resetButton.addEventListener('click', resetLab);
elements.refreshButton.addEventListener('click', () => refreshState());
elements.stateRefresh.addEventListener('click', () => refreshState());
elements.consoleForm.addEventListener('submit', runConsoleCommand);

boot();
