/**
 * GistCity SQL test-suite against an embedded PostgreSQL — no system database
 * or psql required (CI uses supabase/tests/run_local.sh with real psql).
 *
 *   node scripts/db-tests.mjs
 *
 * Dev-only dependencies (not shipped in the app bundle):
 *   npm i --no-save embedded-postgres pg
 */
import { readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const EmbeddedPostgres = require('embedded-postgres').default ?? require('embedded-postgres');
const { Client } = require('pg');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PGPORT ?? 5433);
const DATA = process.env.PGDATA_DIR ?? '/tmp/gist-pgdata';
// Drop psql meta lines and whole-line comments (a ';' inside a comment must not split statements).
const stripMeta = (f) => readFileSync(f, 'utf8').split('\n')
  .filter((l) => { const t = l.trimStart(); return !t.startsWith('\\') && !t.startsWith('--'); })
  .join('\n');

/** Split SQL into statements, honouring dollar-quoted bodies and `--` comments — like psql -f. */
function splitSql(sql) {
  const out = [];
  let buf = '', i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {                 // line comment: copy through
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl + 1;
      buf += sql.slice(i, stop); i = stop; continue;
    }
    if (ch === "'") {                                       // string literal
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } j++; break; } j++; }
      buf += sql.slice(i, j); i = j; continue;
    }
    if (ch === '$') {                                       // dollar-quoted body
      const m = sql.slice(i).match(/^\$[A-Za-z_0-9]*\$/);
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length);
        const stop = end === -1 ? sql.length : end + m[0].length;
        buf += sql.slice(i, stop); i = stop; continue;
      }
    }
    if (ch === ';') { out.push(buf.trim()); buf = ''; i++; continue; }
    buf += ch; i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out
    .map((s) => s.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

async function main() {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const pg = new EmbeddedPostgres({
    databaseDir: DATA,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();

  const admin = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query('drop database if exists gist_test');
  await admin.query('create database gist_test');
  await admin.end();

  const db = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: 'gist_test' });
  await db.connect();

  const steps = [];
  steps.push(['auth stub', join(ROOT, 'supabase/tests/local_auth_stub.sql')]);
  const migrations = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const m of migrations) steps.push([`migration ${m}`, join(ROOT, 'supabase/migrations', m)]);
  // idempotency: the newest migration must be re-runnable
  steps.push([`migration re-apply (idempotency) ${migrations[migrations.length - 1]}`, join(ROOT, 'supabase/migrations', migrations[migrations.length - 1])]);
  const tests = readdirSync(join(ROOT, 'supabase/tests')).filter((f) => f.endsWith('_test.sql')).sort();
  for (const t of tests) steps.push([`test ${t}`, join(ROOT, 'supabase/tests', t)]);

  let failed = 0;
  const resetSession = async () => {
    try { await db.query('reset role'); await db.query("select set_config('request.jwt.claim.sub', '', false)"); } catch { /* ignore */ }
  };
  for (const [label, file] of steps) {
    try {
      let out = '';
      await resetSession();
      for (const stmt of splitSql(stripMeta(file))) {
        const res = await db.query(stmt);
        const rows = Array.isArray(res) ? res.flat() : [res];
        out += rows.map((r) => r?.rows?.map((x) => Object.values(x).join(' ')).join('\n')).filter(Boolean).join('\n');
      }
      console.log(`PASS  ${label}${out ? ` — ${out.split('\n').filter(Boolean).pop()}` : ''}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  ${label}\n      ${String(e.message).split('\n').slice(0, 4).join('\n      ')}`);
    }
    await resetSession();
  }

  await db.end();
  await pg.stop();
  console.log(failed ? `\n${failed} step(s) failed.` : '\nAll database steps passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
