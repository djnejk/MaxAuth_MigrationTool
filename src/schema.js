const ACCOUNT_COLUMNS = [
  'accountId', 'backendUuid', 'accountType', 'lastNickname', 'mailAddress', 'hashedPassword',
  'verificationToken', 'lastServer', 'lastServerRedirectionEnabled', 'lastAddress', 'firstAddress',
  'sessionExpire', 'lastSeen', 'firstSeen', 'pendingPremiumId', 'gender', 'normalizedNickname'
];

const REQUIRED_COLUMNS = {
  accounts: ACCOUNT_COLUMNS,
  identities: ['provider', 'externalId', 'accountId'],
  metadata: ['metaKey', 'metaValue', 'updatedAt']
};

function dialect(databaseType) {
  return databaseType === 'postgresql' ? 'postgresql' : databaseType === 'sqlite' ? 'sqlite' : 'mysql';
}

function schemaStatements(type, names) {
  const engine = dialect(type);
  const sqlite = engine === 'sqlite';
  const uuidType = sqlite ? 'TEXT' : 'VARCHAR(36)';
  const timeType = sqlite ? 'DATETIME' : 'TIMESTAMP NULL';
  const booleanType = sqlite ? 'INTEGER' : 'BOOLEAN';
  const falseValue = sqlite ? '0' : 'FALSE';
  const nicknameType = sqlite ? 'TEXT COLLATE NOCASE' : 'VARCHAR(16)';
  return [
    `CREATE TABLE IF NOT EXISTS ${names.accounts} (` +
      `accountId ${uuidType} NOT NULL PRIMARY KEY, backendUuid ${uuidType} NOT NULL UNIQUE, ` +
      `accountType VARCHAR(24) NOT NULL, lastNickname ${nicknameType} NOT NULL UNIQUE, ` +
      `hashedPassword VARCHAR(256), verificationToken VARCHAR(64), mailAddress VARCHAR(128), ` +
      `sessionExpire ${timeType}, lastServer VARCHAR(64), lastServerRedirectionEnabled ${booleanType} NOT NULL DEFAULT ${falseValue}, ` +
      `lastAddress VARCHAR(45), lastSeen ${timeType}, firstAddress VARCHAR(45), firstSeen ${timeType}, ` +
      `pendingPremiumId ${uuidType}, gender VARCHAR(32) NULL, normalizedNickname VARCHAR(16) NOT NULL UNIQUE)`,
    `CREATE TABLE IF NOT EXISTS ${names.identities} (` +
      `provider VARCHAR(24) NOT NULL, externalId ${uuidType} NOT NULL, accountId ${uuidType} NOT NULL, ` +
      `PRIMARY KEY (provider, externalId), UNIQUE (provider, accountId))`,
    `CREATE TABLE IF NOT EXISTS ${names.metadata} (` +
      `metaKey VARCHAR(64) NOT NULL PRIMARY KEY, metaValue VARCHAR(512), updatedAt ${timeType})`
  ];
}

async function validateExistingTargetSchema(database, names, requireAll = false) {
  const existing = new Map((await database.listTables()).map(name => [name.toLowerCase(), name]));
  for (const [kind, required] of Object.entries(REQUIRED_COLUMNS)) {
    const table = names[kind];
    const actualTable = existing.get(table.toLowerCase());
    if (!actualTable) {
      if (requireAll) throw new Error(`Target table ${table} was not created.`);
      continue;
    }
    const columns = await database.columnInfo(actualTable);
    const actual = new Set(columns.map(column => String(column.name).toLowerCase()));
    const missing = required.filter(column => !actual.has(column.toLowerCase()));
    if (missing.length) {
      throw new Error(`Incompatible target table ${table}; missing required columns: ${missing.join(', ')}. Use clean MaxAuth target tables; automatic schema upgrade is not supported.`);
    }
    if (kind === 'accounts') validateGenderColumn(table, columns);
  }
}

function validateGenderColumn(table, columns) {
  const gender = columns.find(column => String(column.name).toLowerCase() === 'gender');
  if (!gender.nullable) {
    throw new Error(`Incompatible target table ${table}; column gender must be nullable.`);
  }
  const type = String(gender.dataType || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const varchar = type === 'varchar' || type === 'character varying' || /^varchar\s*\(\s*32\s*\)$/i.test(type);
  if (!varchar || Number(gender.maxLength) !== 32) {
    throw new Error(`Incompatible target table ${table}; column gender must be VARCHAR(32) NULL.`);
  }
}

module.exports = { ACCOUNT_COLUMNS, REQUIRED_COLUMNS, dialect, schemaStatements, validateExistingTargetSchema };
