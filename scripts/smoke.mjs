/**
 * Production smoke tests (§45, §51).
 *
 * Hits a running instance and asserts the things that must be true for the
 * deploy to be acceptable: health endpoints answer, auth is enforced, public
 * surfaces are reachable, and security headers are present.
 *
 * Usage: SMOKE_BASE_URL=https://staging.example.com node scripts/smoke.mjs
 */
const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

const get = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual', ...opts });
  const body = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, body, location: res.headers.get('location') };
};

console.log(`\n══ ClientForge AI — smoke tests ══\nTarget: ${BASE}\n`);

console.log('Health');
const live = await get('/api/health?live=1');
check('liveness answers 200', live.status === 200, `got ${live.status}`);
check('liveness reports uptime', /uptimeSec/.test(live.body));

const ready = await get('/api/health');
check('readiness answers 200 or 503', ready.status === 200 || ready.status === 503, `got ${ready.status}`);
check('readiness reports components', /components/.test(ready.body));
if (ready.status === 200) {
  const report = JSON.parse(ready.body);
  const unhealthy = report.components.filter((c) => c.status === 'unhealthy').map((c) => c.component);
  check('no component is unhealthy', unhealthy.length === 0, unhealthy.join(', ') || report.components.length + ' components healthy');
  check('database is healthy', report.components.find((c) => c.component === 'database')?.status === 'healthy');
  check('scheduler is running', report.components.find((c) => c.component === 'scheduler')?.status === 'healthy');
}

console.log('\nAuthentication is enforced');
for (const path of ['/', '/prospects', '/settings', '/analytics', '/automation', '/pipeline']) {
  const res = await get(path);
  const redirectedToLogin = res.status >= 300 && res.status < 400 && (res.location || '').includes('/login');
  check(`${path} redirects to /login when unauthenticated`, redirectedToLogin, `${res.status} → ${res.location || 'no redirect'}`);
}

const login = await get('/login');
check('/login is reachable', login.status === 200, `got ${login.status}`);
check('/login renders the sign-in form', /type="password"/.test(login.body) && /ClientForge/.test(login.body));

console.log('\nSecurity headers');
const home = await get('/login');
check('X-Frame-Options is set', !!home.headers.get('x-frame-options'), home.headers.get('x-frame-options') || 'missing');
check('X-Content-Type-Options is set', home.headers.get('x-content-type-options') === 'nosniff', home.headers.get('x-content-type-options') || 'missing');
check('Referrer-Policy is set', !!home.headers.get('referrer-policy'), home.headers.get('referrer-policy') || 'missing');

console.log('\nPublic surfaces');
const badConcept = await get('/mockup/this-token-does-not-exist');
check('an unknown concept token is rejected', badConcept.status === 404 || badConcept.status === 403, `got ${badConcept.status}`);
check('the rejection does not leak a stack trace', !/at \w+ \(/.test(badConcept.body));

const badPortal = await get('/portal/this-token-does-not-exist');
check('an unknown portal token is rejected', badPortal.status === 404, `got ${badPortal.status}`);

console.log('\nTracking endpoint');
const track = await fetch(`${BASE}/api/track`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: 'nonexistent-token', durationMs: 100 }),
});
check('an unknown tracking token is rejected', track.status === 404, `got ${track.status}`);

console.log('\nError handling');
const notFound = await get('/this-route-does-not-exist');
check('an unknown route answers 404', notFound.status === 404, `got ${notFound.status}`);
check('the 404 does not leak a stack trace', !/at \w+ \(/.test(notFound.body));

console.log('\nNo secret leakage');
check('no credential appears in the login page', !/sk-[A-Za-z0-9]{20,}/.test(login.body));
const envProbe = await get('/.env');
check('/.env is not served', envProbe.status === 404, `got ${envProbe.status}`);

console.log('\n' + '═'.repeat(48));
console.log(`  ${passed} passed · ${failed} failed`);
if (failures.length) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('═'.repeat(48) + '\n');
process.exit(failed ? 1 : 0);
