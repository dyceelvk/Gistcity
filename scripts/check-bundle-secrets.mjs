// Fails the build if a privileged Supabase key (sb_secret_* or a service_role JWT)
// ends up in the shipped bundle. Only the anon/publishable key may be in client code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(process.argv[2] ?? 'dist').filter((f) => /\.(js|html|css|json|webmanifest)$/.test(f));
const offenders = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.match(/sb_secret_[A-Za-z0-9_-]{16,}/g) ?? []) offenders.push(`${f}: ${m.slice(0, 14)}…`);
  for (const jwt of text.match(/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? []) {
    try {
      const payload = JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.role === 'service_role') offenders.push(`${f}: service_role JWT`);
    } catch { /* not a JWT */ }
  }
}
if (offenders.length) { console.error('Privileged key found in bundle:\n' + offenders.join('\n')); process.exit(1); }
console.log(`bundle secret check OK (${files.length} files)`);
