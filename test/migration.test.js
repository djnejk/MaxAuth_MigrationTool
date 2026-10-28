const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, mysqlConnectionOptions, configureMysqlSession } = require('../src/db');
const { nameUuid, transformRows, inspectTables, buildMigrationPreview } = require('../src/migration');
const { writeMigration, exportSql, ensureSchema, schemaStatements, ACCOUNT_COLUMNS } = require('../src/output');

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
  const result = transformRows([legacy({ premiumId: premium, gender: 'legacy-value-must-be-ignored' })], 'JPREMIUM', emptyTarget());
  assert.equal(result.migrated, 1);
  assert.equal(result.accounts[0].accountType, 'MIGRATED');
  assert.equal(result.accounts[0].pendingPremiumId, premium.replaceAll('-', ''));
  assert.equal(result.accounts[0].gender, null);
  assert.equal(result.pendingVerification, 1);
});

test('invalid UUID is repaired and source collisions are skipped', () => {
  const rows = [legacy({ uniqueId: '00000000-0000-0000-0000-000000000000' }), legacy({ uniqueId: 'bad', lastNickname: 'player' })];
  const result = transformRows(rows, 'MAXAUTH_BETA', emptyTarget());
  assert.equal(result.migrated, 1);
  assert.equal(result.repaired, 1);
  assert.equal(result.skippedRows[0].reason, 'nickname-collision');
});

test('MySQL and MariaDB connections use UTC to avoid daylight-saving gaps', async () => {
  const options = mysqlConnectionOptions({
    host: 'localhost', port: 3306, database: 'maxauth', user: 'user', password: 'password'
  });
  assert.equal(options.timezone, 'Z');

  const statements = [];
  await configureMysqlSession({ query: async sql => statements.push(sql) });
  assert.deepEqual(statements, ["SET time_zone = '+00:00'"]);
});

test('DST-gap-looking UTC timestamps remain writable migration values', () => {
  const result = transformRows([
    legacy({ firstSeen: new Date('2025-03-30T02:48:31.000Z') })
  ], 'MAXAUTH_BETA', emptyTarget());
  assert.equal(result.accounts[0].firstSeen, '2025-03-30 02:48:31.000');
});

async function migrateLegacySource(t, sourceType, sourceTable, nickname) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maxauth-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'migration.db');
  const config = { type: 'sqlite', file };
  let db = await openDatabase(config, { create: true });
  await db.run(`CREATE TABLE ${sourceTable} (uniqueId TEXT, premiumId TEXT, lastNickname TEXT, hashedPassword TEXT, verificationToken TEXT, mailAddress TEXT, sessionExpire DATETIME, lastServer TEXT, lastAddress TEXT, lastSeen DATETIME, firstAddress TEXT, firstSeen DATETIME)`);
  await db.run(`INSERT INTO ${sourceTable} (uniqueId, lastNickname, hashedPassword) VALUES (?, ?, ?)`, ['00000000-0000-0000-0000-000000000000', nickname, 'legacy-hash']);
  await db.close();

  db = await openDatabase(config);
  const tables = await inspectTables(db, sourceType);
  assert.equal(tables[0].name, sourceTable);
  assert.equal(tables[0].recommended, true);
  assert.equal(tables[0].compatible, true);
  const preview = await buildMigrationPreview(db, db, { table: sourceTable, prefix: 'maxauth_', sourceType });
  assert.equal(preview.migrated, 1);
  assert.equal(preview.accounts[0].gender, null);
  await writeMigration(db, preview);
  await db.close();

  db = await openDatabase(config);
  const sourceCount = await db.query(`SELECT COUNT(*) AS count FROM ${sourceTable}`);
  const accounts = await db.query('SELECT * FROM maxauth_accounts');
  const metadata = await db.query("SELECT metaValue FROM maxauth_metadata WHERE metaKey LIKE 'legacy-v2-source-%'");
  assert.equal(Number(sourceCount[0].count), 1);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountType, 'MIGRATED');
  assert.equal(accounts[0].gender, null);
  assert.match(metadata[0].metaValue, /^status=completed,/);
  await db.close();
}

test('jPremium migration creates a target account with NULL gender', async t => {
  await migrateLegacySource(t, 'jpremium', 'user_profiles', 'JPremiumUser');
});

test('MaxAuth BETA migration creates a target account with NULL gender', async t => {
  await migrateLegacySource(t, 'maxauth-beta', 'maxauth_users', 'BetaUser');
});

test('created SQLite accounts schema has nullable VARCHAR(32) gender in the required position', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maxauth-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = await openDatabase({ type: 'sqlite', file: path.join(directory, 'schema.db') }, { create: true });
  const names = { accounts: 'maxauth_accounts', identities: 'maxauth_identities', metadata: 'maxauth_metadata' };
  await ensureSchema(db, names);
  const columns = await db.query('PRAGMA table_info(maxauth_accounts)');
  const genderIndex = columns.findIndex(column => column.name === 'gender');
  assert.equal(columns[genderIndex - 1].name, 'pendingPremiumId');
  assert.equal(columns[genderIndex + 1].name, 'normalizedNickname');
  assert.equal(columns[genderIndex].type.toUpperCase(), 'VARCHAR(32)');
  assert.equal(Number(columns[genderIndex].notnull), 0);
  await db.close();
});

test('all supported target dialects define nullable VARCHAR(32) gender', () => {
  const names = { accounts: 'maxauth_accounts', identities: 'maxauth_identities', metadata: 'maxauth_metadata' };
  for (const type of ['sqlite', 'mysql', 'mariadb', 'postgresql']) {
    const accountsDdl = schemaStatements(type, names)[0];
    assert.match(accountsDdl, /pendingPremiumId [^,]+, gender VARCHAR\(32\) NULL, normalizedNickname/);
  }
});

test('existing target accounts table without gender is rejected clearly', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maxauth-incompatible-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = await openDatabase({ type: 'sqlite', file: path.join(directory, 'incompatible.db') }, { create: true });
  const names = { accounts: 'maxauth_accounts', identities: 'maxauth_identities', metadata: 'maxauth_metadata' };
  const oldAccountsDdl = schemaStatements('sqlite', names)[0].replace(', gender VARCHAR(32) NULL', '');
  await db.run(oldAccountsDdl);
  await db.run('CREATE TABLE user_profiles (uniqueId TEXT, premiumId TEXT, lastNickname TEXT, hashedPassword TEXT, verificationToken TEXT, mailAddress TEXT, sessionExpire DATETIME, lastServer TEXT, lastAddress TEXT, lastSeen DATETIME, firstAddress TEXT, firstSeen DATETIME)');
  await assert.rejects(
    buildMigrationPreview(db, db, { table: 'user_profiles', prefix: 'maxauth_', sourceType: 'jpremium' }),
    /Incompatible target table maxauth_accounts; missing required columns: gender.*automatic schema upgrade is not supported/
  );
  const tables = await db.listTables();
  assert.deepEqual(tables, ['maxauth_accounts', 'user_profiles']);
  await db.close();
});

test('SQL export includes nullable gender and explicitly inserts NULL for every dialect', () => {
  const account = transformRows([
    legacy({ premiumId: '12345678-1234-1234-9234-123456789abc' })
  ], 'JPREMIUM', emptyTarget()).accounts[0];
  const preview = {
    source: 'JPREMIUM', table: 'user_profiles', names: { accounts: 'x_accounts', identities: 'x_identities', metadata: 'x_metadata' },
    accounts: [account], markerKey: 'legacy-v2-source-abc', migrated: 1, skipped: 0, repaired: 0, pendingVerification: 1
  };
  assert.equal(ACCOUNT_COLUMNS.at(-2), 'gender');
  for (const type of ['sqlite', 'mysql', 'mariadb', 'postgresql']) {
    const sql = exportSql(preview, type);
    assert.ok(sql.indexOf('CREATE TABLE') < sql.indexOf('BEGIN;'));
    assert.match(sql, /gender VARCHAR\(32\) NULL/);
    assert.match(sql, /pendingPremiumId, gender, normalizedNickname\) VALUES \([^\n]+, '12345678123412349234123456789abc', NULL, 'player'\);/);
    assert.ok(sql.endsWith('COMMIT;\n'));
    if (type === 'mysql' || type === 'mariadb') {
      assert.match(sql, /SET time_zone = '\+00:00';/);
    } else {
      assert.doesNotMatch(sql, /SET time_zone/);
    }
  }
});
