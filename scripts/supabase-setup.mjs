#!/usr/bin/env node
/**
 * One-shot backend setup through the Supabase Management API.
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_... [SUPABASE_PROJECT_REF=xxxx] node scripts/supabase-setup.mjs [--dry]
 *
 * 1. applies every file in supabase/migrations/ in order (idempotent SQL),
 * 2. verifies the ledger with public.economy_audit(),
 * 3. configures Auth for the game: Site URL + redirect allow-list (web build),
 *    anonymous sign-ins off, email templates that include the 6-digit code
 *    ({{ .Token }}) so the Android app can verify without deep links,
 * 4. prints the public values (project URL + anon key) for the client build.
 *
 * The token is read from the environment only and never written anywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) { console.error('SUPABASE_ACCESS_TOKEN is required'); process.exit(2); }
const DRY = process.argv.includes('--dry');
const WEB_URL = process.env.WEB_URL || 'https://dyceelvk.github.io/Gistcity/';
const API = 'https://api.supabase.com/v1';

async function api(method, path, body) {
  const res = await fetch(API + path, { method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data).slice(0, 400)}`);
  return data;
}
const sql = (ref, query) => api('POST', `/projects/${ref}/database/query`, { query });

// 1. project
const projects = await api('GET', '/projects');
let ref = process.env.SUPABASE_PROJECT_REF;
if (!ref) {
  if (projects.length === 1) ref = projects[0].id;
  else { console.error('Several projects — set SUPABASE_PROJECT_REF to one of:\n' + projects.map((p) => `  ${p.id}  ${p.name}  (${p.region}, ${p.status})`).join('\n')); process.exit(2); }
}
const project = projects.find((p) => p.id === ref);
if (!project) { console.error(`project ${ref} not found for this token`); process.exit(2); }
console.log(`project: ${project.name} (${ref}) · ${project.region} · ${project.status}`);
if (project.status !== 'ACTIVE_HEALTHY') console.warn(`warning: project status is ${project.status}`);

// 2. migrations
const dir = 'supabase/migrations';
for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
  const query = readFileSync(join(dir, f), 'utf8');
  console.log(`${DRY ? '[dry] ' : ''}applying ${f} (${query.length} chars)`);
  if (!DRY) await sql(ref, query);
}
if (!DRY) {
  const audit = await sql(ref, 'select public.economy_audit() as audit');
  console.log('economy_audit:', JSON.stringify(audit[0]?.audit ?? audit));
  const counts = await sql(ref, `select (select count(*) from public.accounts) as accounts, (select count(*) from public.catalog_items) as catalog_items, (select count(*) from public.hustles) as hustles, (select count(*) from public.profiles) as profiles, (select value from public.economy_config where key='currency') as currency`);
  console.log('tables:', JSON.stringify(counts[0]));
}

// 3. auth config
const confirmation = `<h2>Welcome to GistCity</h2>
<p>Your verification code is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Enter it in the GistCity app to activate your account. The code expires in 1 hour.</p>
<p>Or open this link on the web: <a href="{{ .ConfirmationURL }}">confirm my email</a></p>
<p style="color:#888;font-size:12px">If you did not create a GistCity account, ignore this email. GistCity is operated by Riel Inc.</p>`;
const recovery = `<h2>Reset your GistCity password</h2>
<p>Your reset code is:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>Enter it in the GistCity app together with your new password. The code expires in 1 hour.</p>
<p>Or open this link on the web: <a href="{{ .ConfirmationURL }}">reset my password</a></p>
<p style="color:#888;font-size:12px">If you did not ask for this, ignore this email and your password stays the same.</p>`;
const authPatch = {
  site_url: WEB_URL,
  uri_allow_list: [WEB_URL, WEB_URL + '**', 'https://gist.pages.dev/**', 'https://localhost/**', 'http://localhost:5173/**'].join(','),
  external_anonymous_users_enabled: false,
  mailer_autoconfirm: false,
  mailer_otp_exp: 3600,
  security_update_password_require_reauthentication: false,
  mailer_subjects_confirmation: 'Your GistCity verification code',
  mailer_templates_confirmation_content: confirmation,
  mailer_subjects_recovery: 'Your GistCity password reset code',
  mailer_templates_recovery_content: recovery,
  password_min_length: 8,
};
console.log(`${DRY ? '[dry] ' : ''}configuring auth: site_url=${WEB_URL}, anonymous off, OTP email templates`);
if (!DRY) {
  const cfg = await api('PATCH', `/projects/${ref}/config/auth`, authPatch);
  console.log('auth config:', JSON.stringify({ site_url: cfg.site_url, anonymous: cfg.external_anonymous_users_enabled, autoconfirm: cfg.mailer_autoconfirm, otp_exp: cfg.mailer_otp_exp, subject: cfg.mailer_subjects_confirmation }));
}

// 4. public client values
const keys = await api('GET', `/projects/${ref}/api-keys`);
const anon = keys.find((k) => k.name === 'anon')?.api_key;
console.log('\nVITE_SUPABASE_URL=' + `https://${ref}.supabase.co`);
console.log('VITE_SUPABASE_ANON_KEY=' + (anon ? anon : '(not found — copy the anon key from Project Settings → API)'));
