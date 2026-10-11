const crypto = require('node:crypto');
const { validateIdentifier } = require('./db');

const REQUIRED_COLUMNS = [
  'uniqueId', 'premiumId', 'lastNickname', 'hashedPassword', 'verificationToken', 'mailAddress',
  'sessionExpire', 'lastServer', 'lastAddress', 'lastSeen', 'firstAddress', 'firstSeen'
];
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

function compactUuid(value) { return value ? value.replaceAll('-', '').toLowerCase() : null; }

function parseUuid(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim().toLowerCase();
  const dashed = raw.length === 32
    ? raw.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : raw;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(dashed)) return null;
  return dashed;
}

function isUsableUuid(value) { return Boolean(value && value !== ZERO_UUID); }

function nameUuid(value) {
  const bytes = crypto.createHash('md5').update(value, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sourceLabel(sourceType) {
  if (sourceType === 'jpremium') return 'JPREMIUM';
  if (sourceType === 'maxauth-beta') return 'MAXAUTH_BETA';
  throw new Error('Select a supported source type.');
}

function markerKey(identity) {
  return `legacy-v2-source-${crypto.createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 40)}`;
}

function tableNames(prefix) {
  validateIdentifier(prefix, 'table prefix');
  if (prefix.length > 36) throw new Error('Table prefix may contain at most 36 characters.');
  return { accounts: `${prefix}accounts`, identities: `${prefix}identities`, metadata: `${prefix}metadata` };
}

function normalizeRow(row) {
  const lowered = Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  return Object.fromEntries(REQUIRED_COLUMNS.map(key => [key, lowered[key.toLowerCase()] ?? null]));
}

function serializeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace('Z', '');
}

async function inspectTables(database, sourceType) {
  const names = await database.listTables();
  const expected = sourceType === 'jpremium' ? ['user_profiles'] : ['maxauth_users'];
  const results = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    let columns = [];
    let count = null;
    try {
      const empty = await database.query(`SELECT * FROM ${name} WHERE 1 = 0`);
      // sql.js does not expose columns for an empty object result, so use a portable zero-row wrapper fallback.
      columns = empty.length ? Object.keys(empty[0]) : await discoverColumns(database, name);
      const countRows = await database.query(`SELECT COUNT(*) AS rowCount FROM ${name}`);
      count = Number(Object.values(countRows[0] || {})[0] || 0);
    } catch (error) {
      results.push({ name, columns: [], count: null, compatible: false, error: error.message, recommended: expected.includes(name.toLowerCase()) });
      continue;
    }
    const lower = new Set(columns.map(c => c.toLowerCase()));
    const missing = REQUIRED_COLUMNS.filter(c => !lower.has(c.toLowerCase()));
    results.push({
      name, columns, count, missing, compatible: missing.length === 0,
      recommended: expected.includes(name.toLowerCase()) || (sourceType === 'maxauth-beta' && name.toLowerCase().includes('maxauth'))
    });
  }
  return results.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name));
}

async function discoverColumns(database, table) {
  if (database.type === 'sqlite') {
    return (await database.query(`PRAGMA table_info(${table})`)).map(row => row.name);
  }
  if (database.type === 'postgresql') {
    return (await database.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position", [table])).map(row => row.column_name);
  }
  return (await database.query('SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [table])).map(row => row.column_name);
}

async function readLegacy(database, table) {
  validateIdentifier(table, 'source table');
  const rows = await database.query(`SELECT * FROM ${table}`);
  const normalized = rows.map(normalizeRow);
  const available = new Set(rows.length ? Object.keys(rows[0]).map(k => k.toLowerCase()) : (await discoverColumns(database, table)).map(k => k.toLowerCase()));
  const missing = REQUIRED_COLUMNS.filter(column => !available.has(column.toLowerCase()));
  if (missing.length) throw new Error(`Incompatible source table ${table}; missing required columns: ${missing.join(', ')}`);
  return normalized;
}

async function tableExists(database, table) {
  return (await database.listTables()).some(name => name.toLowerCase() === table.toLowerCase());
}

async function loadTargetState(database, names) {
  if (!(await tableExists(database, names.accounts))) return { nicknames: new Set(), backendUuids: new Set(), pendingIds: new Set(), trustedIds: new Set(), marker: null };
  const accounts = await database.query(`SELECT backendUuid, normalizedNickname, pendingPremiumId FROM ${names.accounts}`);
  const identities = (await tableExists(database, names.identities))
    ? await database.query(`SELECT externalId FROM ${names.identities} WHERE provider = ?`, ['MOJANG']) : [];
  const metadata = (await tableExists(database, names.metadata))
    ? await database.query(`SELECT metaKey, metaValue FROM ${names.metadata}`) : [];
  return {
    nicknames: new Set(accounts.map(r => String(r.normalizedNickname ?? r.normalizednickname ?? '').toLowerCase())),
    backendUuids: new Set(accounts.map(r => compactUuid(parseUuid(r.backendUuid ?? r.backenduuid))).filter(Boolean)),
    pendingIds: new Set(accounts.map(r => compactUuid(parseUuid(r.pendingPremiumId ?? r.pendingpremiumid))).filter(Boolean)),
    trustedIds: new Set(identities.map(r => compactUuid(parseUuid(r.externalId ?? r.externalid))).filter(Boolean)),
    metadata: new Map(metadata.map(r => [r.metaKey ?? r.metakey, r.metaValue ?? r.metavalue]))
  };
}

function transformRows(rows, source, targetState) {
  const accounts = [];
  const skippedRows = [];
  const repairedRows = [];
  const sourceNicknames = new Set();
  const sourceBackendUuids = new Set();
  const sourcePendingIds = new Set();
  for (const row of rows) {
    const nickname = row.lastNickname === null ? null : String(row.lastNickname);
    if (!nickname || !nickname.trim() || nickname.length > 16) {
      skippedRows.push({ nickname, legacyBackendUuid: row.uniqueId, reason: 'invalid-nickname' });
      continue;
    }
    const normalizedNickname = nickname.toLowerCase();
    let premiumId = parseUuid(row.premiumId);
    if (!isUsableUuid(premiumId)) premiumId = null;
    let backendUuid = parseUuid(row.uniqueId);
    let repairedFrom = null;
    if (!isUsableUuid(backendUuid)) {
      repairedFrom = row.uniqueId;
      let salt = 0;
      do { backendUuid = nameUuid(`MaxAuth-v2:${source}:${normalizedNickname}:${salt++}`); }
      while (targetState.backendUuids.has(compactUuid(backendUuid)) || sourceBackendUuids.has(compactUuid(backendUuid)));
    }
    const backendCompact = compactUuid(backendUuid);
    const premiumCompact = compactUuid(premiumId);
    let reason = null;
    if (targetState.nicknames.has(normalizedNickname) || sourceNicknames.has(normalizedNickname)) reason = 'nickname-collision';
    else if (targetState.backendUuids.has(backendCompact) || sourceBackendUuids.has(backendCompact)) reason = 'backend-uuid-collision';
    else if (premiumCompact && targetState.trustedIds.has(premiumCompact)) reason = 'mojang-identity-collision';
    else if (premiumCompact && (targetState.pendingIds.has(premiumCompact) || sourcePendingIds.has(premiumCompact))) reason = 'pending-mojang-identity-collision';
    if (reason) {
      skippedRows.push({ nickname, legacyBackendUuid: row.uniqueId, reason });
      continue;
    }
    const accountId = nameUuid(`maxauth-v2-account:${source}:${normalizedNickname}:${backendUuid}`);
    accounts.push({
      accountId, backendUuid: backendCompact, accountType: 'MIGRATED', lastNickname: nickname,
      mailAddress: row.mailAddress, hashedPassword: row.hashedPassword,
      verificationToken: row.verificationToken, lastServer: row.lastServer,
      lastServerRedirectionEnabled: false, lastAddress: row.lastAddress, firstAddress: row.firstAddress,
      sessionExpire: serializeDate(row.sessionExpire), lastSeen: serializeDate(row.lastSeen), firstSeen: serializeDate(row.firstSeen),
      pendingPremiumId: premiumCompact, normalizedNickname
    });
    sourceNicknames.add(normalizedNickname);
    sourceBackendUuids.add(backendCompact);
    if (premiumCompact) sourcePendingIds.add(premiumCompact);
    if (repairedFrom !== null) repairedRows.push({ accountId, nickname, oldBackendUuid: repairedFrom, newBackendUuid: backendUuid });
  }
  return {
    accounts, skippedRows, repairedRows,
    sourceRows: rows.length, migrated: accounts.length, skipped: skippedRows.length,
    repaired: repairedRows.length, pendingVerification: accounts.filter(a => a.pendingPremiumId).length
  };
}

async function buildMigrationPreview(sourceDb, targetDb, options) {
  const table = validateIdentifier(options.table, 'source table');
  const names = tableNames(options.prefix);
  const source = sourceLabel(options.sourceType);
  const rows = await readLegacy(sourceDb, table);
  const targetState = targetDb ? await loadTargetState(targetDb, names) : { nicknames: new Set(), backendUuids: new Set(), pendingIds: new Set(), trustedIds: new Set(), metadata: new Map() };
  const identity = `${sourceDb.describe()}:${source}:${table}`;
  const key = markerKey(identity);
  const result = transformRows(rows, source, targetState);
  return {
    ...result, source, table, names, sourceDescription: sourceDb.describe(),
    targetDescription: targetDb ? targetDb.describe() : 'SQL file', markerKey: key,
    alreadyCompleted: String(targetState.metadata?.get(key) || '').startsWith('status=completed,'),
    sample: result.accounts.slice(0, 20)
  };
}

module.exports = {
  REQUIRED_COLUMNS, inspectTables, readLegacy, loadTargetState, transformRows,
  buildMigrationPreview, tableNames, nameUuid, markerKey, compactUuid
};
