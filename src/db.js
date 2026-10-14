const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

const IDENTIFIER = /^[A-Za-z0-9_]+$/;
let sqlJsPromise;

function validateIdentifier(value, label = 'identifier') {
  if (!value || !IDENTIFIER.test(value)) throw new Error(`Invalid ${label}. Use only ASCII letters, numbers, and underscores.`);
  return value;
}

function normalizeConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('Database configuration is required.');
  const type = String(config.type || '').toLowerCase();
  if (!['sqlite', 'mysql', 'mariadb', 'postgresql'].includes(type)) throw new Error('Unsupported database type.');
  if (type === 'sqlite') {
    if (!config.file || !String(config.file).trim()) throw new Error('Select a SQLite database file.');
    return { type, file: path.resolve(String(config.file).trim()) };
  }
  const port = Number(config.port || (type === 'postgresql' ? 5432 : 3306));
  if (!String(config.host || '').trim()) throw new Error('Database host is required.');
  if (!String(config.database || '').trim()) throw new Error('Database name is required.');
  if (!String(config.user || '').trim()) throw new Error('Database user is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Database port must be between 1 and 65535.');
  return {
    type,
    host: String(config.host).trim(),
    port,
    database: String(config.database).trim(),
    user: String(config.user).trim(),
    password: String(config.password || ''),
    ssl: Boolean(config.ssl)
  };
}

function pgPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

class RemoteAdapter {
  constructor(config, connection) {
    this.config = config;
    this.connection = connection;
    this.type = config.type;
  }

  async query(sql, params = []) {
    if (this.type === 'postgresql') {
      const result = await this.connection.query(pgPlaceholders(sql), params);
      return result.rows;
    }
    const [rows] = await this.connection.query(sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  async run(sql, params = []) {
    if (this.type === 'postgresql') return this.connection.query(pgPlaceholders(sql), params);
    return this.connection.query(sql, params);
  }

  async transaction(work) {
    await this.run('BEGIN');
    try {
      const result = await work(this);
      await this.run('COMMIT');
      return result;
    } catch (error) {
      try { await this.run('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  async listTables() {
    if (this.type === 'postgresql') {
      return (await this.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name")).map(r => r.name);
    }
    return (await this.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\' ORDER BY table_name')).map(r => r.name);
  }

  async columnInfo(table) {
    validateIdentifier(table, 'table name');
    if (this.type === 'postgresql') {
      const rows = await this.query("SELECT column_name AS name, is_nullable AS nullable, data_type AS \"dataType\", character_maximum_length AS \"maxLength\" FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position", [table]);
      return rows.map(row => ({ name: row.name, nullable: row.nullable === 'YES', dataType: row.dataType, maxLength: row.maxLength === null ? null : Number(row.maxLength) }));
    }
    const rows = await this.query('SELECT column_name AS name, is_nullable AS nullable, data_type AS dataType, character_maximum_length AS maxLength FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position', [table]);
    return rows.map(row => ({ name: row.name, nullable: row.nullable === 'YES', dataType: row.dataType, maxLength: row.maxLength === null ? null : Number(row.maxLength) }));
  }

  async close() {
    if (this.type === 'postgresql') await this.connection.end();
    else await this.connection.end();
  }

  describe() {
    return `${this.type}://${this.config.host}:${this.config.port}/${this.config.database}`;
  }
}

class SqliteAdapter {
  constructor(config, database, existed) {
    this.config = config;
    this.database = database;
    this.type = 'sqlite';
    this.existed = existed;
    this.dirty = false;
  }

  async query(sql, params = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(params.map(sqliteValue));
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  async run(sql, params = []) {
    this.database.run(sql, params.map(sqliteValue));
    this.dirty = true;
  }

  async transaction(work) {
    await this.run('BEGIN IMMEDIATE');
    try {
      const result = await work(this);
      await this.run('COMMIT');
      return result;
    } catch (error) {
      try { await this.run('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  async listTables() {
    return (await this.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map(r => r.name);
  }

  async columnInfo(table) {
    validateIdentifier(table, 'table name');
    return (await this.query(`PRAGMA table_info(${table})`)).map(row => ({
      name: row.name,
      nullable: Number(row.notnull) === 0,
      dataType: String(row.type || ''),
      maxLength: varcharLength(row.type)
    }));
  }

  async flush() {
    if (!this.dirty) return;
    const bytes = this.database.export();
    fs.mkdirSync(path.dirname(this.config.file), { recursive: true });
    const temporary = `${this.config.file}.maxauth-migration.tmp`;
    fs.writeFileSync(temporary, Buffer.from(bytes));
    // copyFile replaces an existing Windows destination, while rename behavior
    // differs across filesystems. Keep the temporary complete image until copy.
    fs.copyFileSync(temporary, this.config.file);
    fs.unlinkSync(temporary);
    this.dirty = false;
  }

  async close() {
    await this.flush();
    this.database.close();
  }

  describe() { return this.config.file; }
}

function sqliteValue(value) {
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function varcharLength(type) {
  const match = String(type || '').match(/^VARCHAR\s*\(\s*(\d+)\s*\)$/i);
  return match ? Number(match[1]) : null;
}

async function openDatabase(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  if (config.type === 'sqlite') {
    const existed = fs.existsSync(config.file);
    if (!existed && !options.create) throw new Error(`SQLite file does not exist: ${config.file}`);
    if (!sqlJsPromise) {
      const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
      sqlJsPromise = initSqlJs({ wasmBinary });
    }
    const SQL = await sqlJsPromise;
    const database = existed ? new SQL.Database(fs.readFileSync(config.file)) : new SQL.Database();
    return new SqliteAdapter(config, database, existed);
  }
  if (config.type === 'postgresql') {
    const client = new Client({
      host: config.host, port: config.port, database: config.database,
      user: config.user, password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000
    });
    await client.connect();
    return new RemoteAdapter(config, client);
  }
  const connection = await mysql.createConnection({
    host: config.host, port: config.port, database: config.database,
    user: config.user, password: config.password,
    connectTimeout: 8000, charset: 'utf8mb4', multipleStatements: false
  });
  return new RemoteAdapter(config, connection);
}

async function withDatabase(config, options, work) {
  const adapter = await openDatabase(config, options);
  try { return await work(adapter); }
  finally { await adapter.close(); }
}

module.exports = { openDatabase, withDatabase, validateIdentifier, normalizeConfig };
