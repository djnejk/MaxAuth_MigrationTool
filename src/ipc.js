const { ipcMain, dialog, BrowserWindow } = require('electron');
const { withDatabase, normalizeConfig } = require('./db');
const { inspectTables, buildMigrationPreview } = require('./migration');
const { writeMigration, exportSql, writeSqlFile } = require('./output');

function cleanError(error) {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

function register(channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    try { return { ok: true, data: await handler(payload, event) }; }
    catch (error) { console.error(`[${channel}]`, error); return cleanError(error); }
  });
}

async function createPreview(request) {
  return withDatabase(request.source, {}, source => {
    if (request.outputMode === 'sql') return buildMigrationPreview(source, null, request);
    return withDatabase(request.target, { create: true }, target => buildMigrationPreview(source, target, request));
  });
}

function registerIpc() {
  register('choose-database-file', async mode => {
    const options = mode === 'save'
      ? { title: 'Select SQLite target', defaultPath: 'maxauth.db', filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }] }
      : { title: 'Select SQLite source', properties: ['openFile'], filters: [{ name: 'SQLite database', extensions: ['db', 'sqlite', 'sqlite3'] }, { name: 'All files', extensions: ['*'] }] };
    const result = mode === 'save' ? await dialog.showSaveDialog(options) : await dialog.showOpenDialog(options);
    return mode === 'save' ? (result.canceled ? null : result.filePath) : (result.canceled ? null : result.filePaths[0]);
  });

  register('test-connection', async config => withDatabase(config, { create: true }, async db => ({ description: db.describe(), tables: (await db.listTables()).length })));

  register('inspect-source', async request => withDatabase(request.source, {}, db => inspectTables(db, request.sourceType)));

  register('build-preview', request => createPreview(request));

  register('migrate', async (request, event) => {
    const preview = await createPreview(request);
    event.sender.send('migration-progress', { phase: 'preview', current: preview.sourceRows, total: preview.sourceRows });
    await withDatabase(request.target, { create: true }, target => writeMigration(target, preview, progress => event.sender.send('migration-progress', progress)));
    return { ...summary(preview), target: preview.targetDescription };
  });

  register('export-sql', async request => {
    const preview = await createPreview({ ...request, outputMode: 'sql' });
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
      title: 'Export MaxAuth migration SQL',
      defaultPath: `maxauth-migration-${request.sqlDialect || 'mysql'}.sql`,
      filters: [{ name: 'SQL script', extensions: ['sql'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    writeSqlFile(result.filePath, exportSql(preview, request.sqlDialect || 'mysql'));
    return { canceled: false, file: result.filePath, ...summary(preview) };
  });
}

function summary(preview) {
  return {
    sourceRows: preview.sourceRows, migrated: preview.migrated, skipped: preview.skipped,
    repaired: preview.repaired, pendingVerification: preview.pendingVerification,
    accountsTable: preview.names.accounts, identitiesTable: preview.names.identities, metadataTable: preview.names.metadata
  };
}

module.exports = { registerIpc };
