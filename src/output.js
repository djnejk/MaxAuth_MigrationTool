const fs = require('node:fs');
const { ACCOUNT_COLUMNS, dialect, schemaStatements, validateExistingTargetSchema } = require('./schema');

async function ensureSchema(database, names) {
  await validateExistingTargetSchema(database, names);
  for (const statement of schemaStatements(database.type, names)) await database.run(statement);
  await validateExistingTargetSchema(database, names, true);
  const indexName = `${names.accounts}_pending_premium_uq`;
  try { await database.run(`CREATE UNIQUE INDEX ${indexName} ON ${names.accounts} (pendingPremiumId)`); }
  catch (error) {
    if (!/already exists|duplicate key name|relation .* already exists/i.test(error.message)) throw error;
  }
  const now = new Date();
  await upsertMetadata(database, names.metadata, 'mojang-claim-lock', 'serializes trusted and pending Mojang claims', now);
  await upsertMetadata(database, names.metadata, 'schema-version', '2', now);
}

async function upsertMetadata(database, table, key, value, now = new Date()) {
  await database.run(`DELETE FROM ${table} WHERE metaKey = ?`, [key]);
  await database.run(`INSERT INTO ${table} (metaKey, metaValue, updatedAt) VALUES (?, ?, ?)`, [key, value, now]);
}

async function writeMigration(database, preview, progress = () => {}) {
  if (preview.alreadyCompleted) throw new Error('This source is already marked as completed in the target database.');
  // MySQL/MariaDB implicitly commit DDL, so initialize the empty schema before starting
  // the all-or-nothing account import transaction.
  await ensureSchema(database, preview.names);
  return database.transaction(async transaction => {
    const sql = `INSERT INTO ${preview.names.accounts} (${ACCOUNT_COLUMNS.join(', ')}) VALUES (${ACCOUNT_COLUMNS.map(() => '?').join(', ')})`;
    for (let index = 0; index < preview.accounts.length; index++) {
      const account = preview.accounts[index];
      await transaction.run(sql, ACCOUNT_COLUMNS.map(column => account[column]));
      if (index % 100 === 0 || index === preview.accounts.length - 1) {
        progress({ phase: 'write', current: index + 1, total: preview.accounts.length });
      }
    }
    const value = `status=completed,migrated=${preview.migrated},skipped=${preview.skipped},repaired=${preview.repaired},pendingPremiumVerification=${preview.pendingVerification}`;
    await upsertMetadata(transaction, preview.names.metadata, preview.markerKey, value, new Date());
  });
}

function sqlLiteral(value, engine) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? (engine === 'sqlite' ? '1' : 'TRUE') : (engine === 'sqlite' ? '0' : 'FALSE');
  const escaped = String(value).replaceAll("'", "''");
  return `'${escaped}'`;
}

function exportSql(preview, targetType) {
  const engine = dialect(targetType);
  const lines = [
    '-- MaxAuth >= 1.0.0 authentication storage migration',
    `-- Source: ${preview.source} / ${preview.table}`,
    `-- Generated: ${new Date().toISOString()}`,
    '-- Keep a complete backup and stop all proxy instances before executing this script.',
    ...schemaStatements(targetType, preview.names).map(sql => `${sql};`)
  ];
  if (engine === 'mysql') {
    lines.push(`SET @maxauth_index_exists = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = '${preview.names.accounts}' AND index_name = '${preview.names.accounts}_pending_premium_uq');`);
    lines.push(`SET @maxauth_index_sql = IF(@maxauth_index_exists = 0, 'CREATE UNIQUE INDEX ${preview.names.accounts}_pending_premium_uq ON ${preview.names.accounts} (pendingPremiumId)', 'SELECT 1');`);
    lines.push('PREPARE maxauth_index_stmt FROM @maxauth_index_sql;', 'EXECUTE maxauth_index_stmt;', 'DEALLOCATE PREPARE maxauth_index_stmt;');
  } else {
    lines.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${preview.names.accounts}_pending_premium_uq ON ${preview.names.accounts} (pendingPremiumId);`);
  }
  lines.push('BEGIN;');
  const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
  for (const [key, value] of [
    ['mojang-claim-lock', 'serializes trusted and pending Mojang claims'],
    ['schema-version', '2']
  ]) {
    lines.push(`DELETE FROM ${preview.names.metadata} WHERE metaKey = ${sqlLiteral(key, engine)};`);
    lines.push(`INSERT INTO ${preview.names.metadata} (metaKey, metaValue, updatedAt) VALUES (${sqlLiteral(key, engine)}, ${sqlLiteral(value, engine)}, ${sqlLiteral(now, engine)});`);
  }
  for (const account of preview.accounts) {
    const values = ACCOUNT_COLUMNS.map(column => sqlLiteral(account[column], engine)).join(', ');
    lines.push(`INSERT INTO ${preview.names.accounts} (${ACCOUNT_COLUMNS.join(', ')}) VALUES (${values});`);
  }
  const markerValue = `status=completed,migrated=${preview.migrated},skipped=${preview.skipped},repaired=${preview.repaired},pendingPremiumVerification=${preview.pendingVerification}`;
  lines.push(`DELETE FROM ${preview.names.metadata} WHERE metaKey = ${sqlLiteral(preview.markerKey, engine)};`);
  lines.push(`INSERT INTO ${preview.names.metadata} (metaKey, metaValue, updatedAt) VALUES (${sqlLiteral(preview.markerKey, engine)}, ${sqlLiteral(markerValue, engine)}, ${sqlLiteral(now, engine)});`);
  lines.push('COMMIT;', '');
  return lines.join('\n');
}

function writeSqlFile(file, sql) {
  fs.writeFileSync(file, sql, 'utf8');
}

module.exports = { ACCOUNT_COLUMNS, schemaStatements, ensureSchema, writeMigration, exportSql, writeSqlFile };
