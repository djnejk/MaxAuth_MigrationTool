const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../src/db');
const { nameUuid, transformRows, inspectTables, buildMigrationPreview } = require('../src/migration');
const { writeMigration, exportSql } = require('../src/output');

const emptyTarget = () => ({ nicknames: new Set(), backendUuids: new Set(), pendingIds: new Set(), trustedIds: new Set(), metadata: new Map() });
const legacy = overrides => ({
  uniqueId: 'd03322e0-9b9a-4be6-80a2-818b2642be3d', premiumId: null,
  lastNickname: 'Player', hashedPassword: 'hash', verificationToken: null,
  mailAddress: null, sessionExpire: null, lastServer: null, lastAddress: null,
  lastSeen: null, firstAddress: null, firstSeen: null, ...overrides
});

test('Java-compatible name UUID generation is deterministic', () => {
  assert.equal(nameUuid('hello'), '5d41402a-bc4b-3a76-b971-9d911017c592');
});

test('transformation marks accounts MIGRATED and keeps premium identity pending', () => {
  const premium = '12345678-1234-1234-9234-123456789abc';
  const result = transformRows([legacy({ premiumId: premium })], 'JPREMIUM', emptyTarget());
  assert.equal(result.migrated, 1);
  assert.equal(result.accounts[0].accountType, 'MIGRATED');
  assert.equal(result.accounts[0].pendingPremiumId, premium.replaceAll('-', ''));
  assert.equal(result.pendingVerification, 1);
});

test('invalid UUID is repaired and source collisions are skipped', () => {
  const rows = [legacy({ uniqueId: '00000000-0000-0000-0000-000000000000' }), legacy({ uniqueId: 'bad', lastNickname: 'player' })];
  const result = transformRows(rows, 'MAXAUTH_BETA', emptyTarget());
  assert.equal(result.migrated, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.skippedRows[0].reason, 'nickname-collision');
});

test('SQLite integration inspects, previews, and migrates without changing legacy rows', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maxauth-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'migration.db');
  const config = { type: 'sqlite', file };
  let db = await openDatabase(config, { create: true });
  await db.run('CREATE TABLE user_profiles (uniqueId TEXT, premiumId TEXT, lastNickname TEXT, hashedPassword TEXT, verificationToken TEXT, mailAddress TEXT, sessionExpire DATETIME, lastServer TEXT, lastAddress TEXT, lastSeen DATETIME, firstAddress TEXT, firstSeen DATETIME)');
  await db.run('INSERT INTO user_profiles (uniqueId, lastNickname, hashedPassword) VALUES (?, ?, ?)', ['00000000-0000-0000-0000-000000000000', 'ImportedUser', 'legacy-hash']);
  await db.close();

  db = await openDatabase(config);
  const tables = await inspectTables(db, 'jpremium');
  assert.equal(tables[0].name, 'user_profiles');
  assert.equal(tables[0].recommended, true);
  assert.equal(tables[0].compatible, true);
  const preview = await buildMigrationPreview(db, db, { table: 'user_profiles', prefix: 'maxauth_', sourceType: 'jpremium' });
  assert.equal(preview.migrated, 1);
  await writeMigration(db, preview);
  await db.close();

  db = await openDatabase(config);
  const sourceCount = await db.query('SELECT COUNT(*) AS count FROM user_profiles');
  const accounts = await db.query('SELECT * FROM maxauth_accounts');
  const metadata = await db.query("SELECT metaValue FROM maxauth_metadata WHERE metaKey LIKE 'legacy-v2-source-%'");
  assert.equal(Number(sourceCount[0].count), 1);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountType, 'MIGRATED');
  assert.match(metadata[0].metaValue, /^status=completed,/);
  await db.close();
});

test('SQL export places DDL before the data transaction', () => {
  const preview = {
    source: 'JPREMIUM', table: 'user_profiles', names: { accounts: 'x_accounts', identities: 'x_identities', metadata: 'x_metadata' },
    accounts: [], markerKey: 'legacy-v2-source-abc', migrated: 0, skipped: 0, repaired: 0, pendingVerification: 0
  };
  const sql = exportSql(preview, 'mysql');
  assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('BEGIN;'));
  assert.ok(sql.endsWith('COMMIT;\n'));
});
