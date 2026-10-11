const $ = id => document.getElementById(id);
const state = { tables: [], preview: null, sourceTested: false, targetTested: false };

function connectionMarkup(scope) {
  return `
    <label>Database type
      <select data-field="type" data-scope="${scope}">
        <option value="mysql">MySQL</option><option value="mariadb">MariaDB</option>
        <option value="postgresql">PostgreSQL</option><option value="sqlite">SQLite file</option>
      </select>
    </label>
    <label>Host<input data-field="host" value="127.0.0.1" autocomplete="off"></label>
    <label>Port<input data-field="port" type="number" value="3306" min="1" max="65535"></label>
    <label>Database<input data-field="database" autocomplete="off"></label>
    <label>Username<input data-field="user" autocomplete="username"></label>
    <label>Password<input data-field="password" type="password" autocomplete="current-password"></label>
    <label class="file-field hidden">SQLite file<input data-field="file" readonly></label>
    <button type="button" class="file-button hidden">Browse…</button>`;
}

function setupConnection(container, scope) {
  container.innerHTML = connectionMarkup(scope);
  const type = container.querySelector('[data-field="type"]');
  type.addEventListener('change', () => updateConnectionLayout(container));
  container.querySelector('.file-button').addEventListener('click', async () => {
    const result = await window.maxauth.chooseDatabaseFile(scope === 'source' ? 'open' : 'save');
    if (result.ok && result.data) container.querySelector('[data-field="file"]').value = result.data;
  });
  updateConnectionLayout(container);
}

function updateConnectionLayout(container) {
  const sqlite = container.querySelector('[data-field="type"]').value === 'sqlite';
  container.classList.toggle('sqlite', sqlite);
  container.querySelectorAll('label:not(.file-field)').forEach((element, index) => { if (index > 0) element.classList.toggle('hidden', sqlite); });
  container.querySelector('.file-field').classList.toggle('hidden', !sqlite);
  container.querySelector('.file-button').classList.toggle('hidden', !sqlite);
  const port = container.querySelector('[data-field="port"]');
  if (!sqlite) port.value = container.querySelector('[data-field="type"]').value === 'postgresql' ? '5432' : '3306';
}

function getConnection(container) {
  return Object.fromEntries([...container.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.type === 'checkbox' ? input.checked : input.value]));
}

function setConnection(container, config) {
  for (const [key, value] of Object.entries(config)) {
    const field = container.querySelector(`[data-field="${key}"]`);
    if (field) field.value = value ?? '';
  }
  updateConnectionLayout(container);
}

function showNotice(message, kind = '') {
  const notice = $('notice');
  notice.textContent = message;
  notice.className = `notice ${kind}`;
  notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearNotice() { $('notice').classList.add('hidden'); }
function setBusy(button, busy, text) { button.disabled = busy; button.textContent = busy ? text : button.dataset.label; }

function requestPayload() {
  const source = getConnection($('sourceConnection'));
  const target = $('differentTarget').checked ? getConnection($('targetConnection')) : { ...source };
  const selected = document.querySelector('input[name="sourceTable"]:checked');
  return {
    sourceType: $('sourceType').value, outputMode: $('outputMode').value,
    source, target, table: selected?.value, prefix: $('prefix').value.trim(), sqlDialect: $('sqlDialect').value
  };
}

async function testSource() {
  clearNotice();
  const button = $('testSource');
  button.dataset.label ||= button.textContent;
  setBusy(button, true, 'Connecting…');
  $('sourceStatus').className = 'status'; $('sourceStatus').textContent = 'Testing…';
  try {
    const response = await window.maxauth.inspectSource({ source: getConnection($('sourceConnection')), sourceType: $('sourceType').value });
    if (!response.ok) throw new Error(response.error);
    state.tables = response.data;
    state.sourceTested = true;
    $('sourceStatus').className = 'status ok'; $('sourceStatus').textContent = 'Connected';
    renderTables();
    if (!$('differentTarget').checked) setConnection($('targetConnection'), getConnection($('sourceConnection')));
    showNotice(`Connection succeeded. ${response.data.length} table(s) found.`, 'success');
  } catch (error) {
    state.sourceTested = false;
    $('sourceStatus').className = 'status error'; $('sourceStatus').textContent = 'Connection failed';
    showNotice(error.message, 'error');
  } finally { setBusy(button, false, ''); }
}

function renderTables() {
  const body = $('tableRows');
  body.textContent = '';
  let autoSelected = false;
  for (const table of state.tables) {
    const row = document.createElement('tr');
    row.className = `${table.recommended ? 'recommended' : ''} ${!table.compatible ? 'incompatible' : ''}`;
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'sourceTable'; radio.value = table.name; radio.disabled = !table.compatible;
    if (!autoSelected && table.compatible && table.recommended) { radio.checked = true; autoSelected = true; }
    radio.addEventListener('change', invalidatePreview);
    const cells = [
      radio,
      table.name,
      table.count ?? '—',
      table.compatible ? badge('Compatible') : badge(`Missing: ${(table.missing || []).join(', ')}`, true),
      table.recommended ? badge('Recommended match') : '—'
    ];
    for (const content of cells) {
      const cell = document.createElement('td');
      if (content instanceof Node) cell.append(content); else cell.innerHTML = content;
      row.append(cell);
    }
    body.append(row);
  }
  if (!autoSelected) {
    const first = body.querySelector('input:not(:disabled)');
    if (first) first.checked = true;
  }
  $('tablesArea').classList.remove('hidden');
  invalidatePreview();
}

function badge(text, warning = false) { return `<span class="badge${warning ? ' warn' : ''}">${escapeHtml(text)}</span>`; }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value ?? ''; return node.innerHTML; }

async function testTarget() {
  clearNotice();
  const response = await window.maxauth.testConnection(getConnection($('targetConnection')));
  if (response.ok) {
    state.targetTested = true; $('targetStatus').className = 'status ok'; $('targetStatus').textContent = `Connected (${response.data.tables} tables)`;
  } else {
    state.targetTested = false; $('targetStatus').className = 'status error'; $('targetStatus').textContent = 'Connection failed'; showNotice(response.error, 'error');
  }
  invalidatePreview();
}

async function buildPreview() {
  clearNotice();
  const request = requestPayload();
  if (!request.table) return showNotice('Select a compatible source table first.', 'error');
  const button = $('refreshPreview'); button.dataset.label ||= button.textContent; setBusy(button, true, 'Building…');
  try {
    const response = await window.maxauth.buildPreview(request);
    if (!response.ok) throw new Error(response.error);
    state.preview = response.data;
    renderPreview(response.data);
  } catch (error) { showNotice(error.message, 'error'); }
  finally { setBusy(button, false, ''); }
}

function renderPreview(preview) {
  $('previewEmpty').classList.add('hidden'); $('preview').classList.remove('hidden');
  const values = [
    ['Source rows', preview.sourceRows], ['Will migrate', preview.migrated], ['Will skip', preview.skipped],
    ['UUID repairs', preview.repaired], ['Pending proof', preview.pendingVerification]
  ];
  $('stats').innerHTML = values.map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join('');
  const warnings = [];
  if ($('outputMode').value === 'sql') warnings.push('SQL export cannot inspect the eventual destination. Execute the script only against an empty or compatible MaxAuth target; conflicts will roll back the data transaction.');
  if (preview.alreadyCompleted) warnings.push('This exact source is already marked as completed in the destination. Direct migration is blocked.');
  if (preview.skipped) warnings.push(`${preview.skipped} row(s) will be skipped because they are invalid or collide with existing data.`);
  if (preview.pendingVerification) warnings.push(`${preview.pendingVerification} legacy premium ID(s) will require fresh provider verification.`);
  $('warnings').innerHTML = warnings.map(w => `<div class="warning">${escapeHtml(w)}</div>`).join('');
  $('targetTables').textContent = `${preview.names.accounts}, ${preview.names.identities}, ${preview.names.metadata}`;
  $('previewRows').innerHTML = preview.sample.map(row => `<tr><td>${escapeHtml(row.lastNickname)}</td><td>${escapeHtml(row.backendUuid)}</td><td>${row.accountType}</td><td>${escapeHtml(row.pendingPremiumId || '—')}</td></tr>`).join('');
  $('details').textContent = JSON.stringify({ skippedRows: preview.skippedRows, repairedRows: preview.repairedRows }, null, 2);
  updateRunButton();
}

function invalidatePreview() {
  state.preview = null; $('preview').classList.add('hidden'); $('previewEmpty').classList.remove('hidden'); updateRunButton();
}

function updateRunButton() {
  const exportMode = $('outputMode').value === 'sql';
  $('runMigration').textContent = exportMode ? 'Export SQL script' : 'Run migration';
  $('runMigration').disabled = !$('confirmed').checked || !state.preview || (!exportMode && state.preview.alreadyCompleted);
}

async function runMigration() {
  const request = requestPayload();
  const button = $('runMigration');
  button.disabled = true; $('progress').classList.remove('hidden'); $('progressText').textContent = 'Preparing…';
  try {
    const response = request.outputMode === 'sql' ? await window.maxauth.exportSql(request) : await window.maxauth.migrate(request);
    if (!response.ok) throw new Error(response.error);
    if (response.data.canceled) { $('progress').classList.add('hidden'); updateRunButton(); return; }
    const message = request.outputMode === 'sql'
      ? `SQL script exported to ${response.data.file}`
      : `Migration completed: ${response.data.migrated} account(s) written, ${response.data.skipped} skipped.`;
    showNotice(message, 'success');
    $('progressText').textContent = 'Completed'; $('progressBar').value = 1;
    if (request.outputMode === 'database') invalidatePreview();
  } catch (error) { showNotice(`Migration failed and was rolled back: ${error.message}`, 'error'); $('progressText').textContent = 'Failed'; }
  finally { updateRunButton(); }
}

function outputModeChanged() {
  const sql = $('outputMode').value === 'sql';
  $('databaseTarget').classList.toggle('hidden', sql); $('dialectField').classList.toggle('hidden', !sql);
  invalidatePreview(); updateRunButton();
}

setupConnection($('sourceConnection'), 'source');
setupConnection($('targetConnection'), 'target');
$('testSource').addEventListener('click', testSource);
$('testTarget').addEventListener('click', testTarget);
$('refreshPreview').addEventListener('click', buildPreview);
$('runMigration').addEventListener('click', runMigration);
$('confirmed').addEventListener('change', updateRunButton);
$('outputMode').addEventListener('change', outputModeChanged);
$('sourceType').addEventListener('change', () => { state.sourceTested = false; $('tablesArea').classList.add('hidden'); invalidatePreview(); });
$('prefix').addEventListener('input', invalidatePreview);
$('sqlDialect').addEventListener('change', invalidatePreview);
$('differentTarget').addEventListener('change', () => {
  const different = $('differentTarget').checked;
  $('targetConnection').classList.toggle('hidden', !different); $('targetActions').classList.toggle('hidden', !different);
  $('sameTargetHint').classList.toggle('hidden', different);
  if (different) setConnection($('targetConnection'), getConnection($('sourceConnection')));
  invalidatePreview();
});
window.maxauth.onProgress(progress => {
  $('progress').classList.remove('hidden'); $('progressBar').max = Math.max(progress.total || 1, 1); $('progressBar').value = progress.current || 0;
  $('progressText').textContent = progress.phase === 'write' ? `Writing ${progress.current} / ${progress.total}` : 'Preview ready';
});
outputModeChanged();
