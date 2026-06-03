const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'statusfe',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('Unexpected pg pool error:', err);
    });
  }
  return pool;
}

// Helper: normalize params from (text, params) or (text, p1, p2, ...)
function normalizeParams(text, ...args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

// Raw query helpers
async function query(text, ...params) {
  params = normalizeParams(text, ...params);
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function queryOne(text, ...params) {
  const { rows } = await query(text, ...params);
  return rows[0] || null;
}

async function queryAll(text, ...params) {
  const { rows } = await query(text, ...params);
  return rows;
}

async function run(text, ...params) {
  params = normalizeParams(text, ...params);
  const result = await query(text, ...params);
  return { changes: result.rowCount || 0 };
}

// Prepare returns an object with .get(), .all(), .run() — async like pg
function prepare(text) {
  return {
    get(...params) { return queryOne(text, ...params); },
    all(...params) { return queryAll(text, ...params); },
    run(...params) { return run(text, ...params); },
  };
}

// pragma() is a no-op for pg
function pragma() {
  return Promise.resolve(true);
}

module.exports = { prepare, query, queryOne, queryAll, run, getPool, pragma };
