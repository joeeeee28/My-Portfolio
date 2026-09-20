/**
 * Secret scan (§35, §45).
 *
 * Fails CI when a credential-shaped string appears in tracked source, or when a
 * file that should never be committed is present. Deliberately conservative:
 * false positives are cheap, a leaked key is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

const PATTERNS = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'Stripe secret key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'Twilio account sid', re: /\bAC[a-f0-9]{32}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'Generic assignment of a long secret', re: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{24,}['"]/i },
];

/** Strings that look like a credential but are legitimately in the repo. */
const ALLOWLIST = [
  /\.env\.example$/,
  /check-secrets\.mjs$/,       // this file defines the patterns
  /security\.test\.ts$/,       // asserts on the patterns
  /password\.ts$/,             // hashing tests use obvious fixtures
  /\.md$/,
];

function trackedFiles() {
  try {
    return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') return [];
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(ts|tsx|js|mjs|json|yml|yaml|sql|sh)$/.test(e.name) ? [p] : [];
  });
}

const trackedSource = trackedFiles().filter((f) => /\.(ts|tsx|js|mjs|json|yml|yaml|sql|sh)$/.test(f));
const files = trackedSource.length ? trackedSource : walk(ROOT);
if (!trackedSource.length) {
  console.log('note: no tracked files found — scanning the working tree instead.');
}

const findings = [];

for (const rel of files) {
  if (ALLOWLIST.some((re) => re.test(rel))) continue;
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;

  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }

  const lines = content.split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // Skip comments that merely document a variable name.
    if (/^\s*(\/\/|\*|#)/.test(trimmed) && !/[A-Za-z0-9]{24,}/.test(trimmed)) return;
    // Skip obvious placeholders.
    if (/your[_-]?|example|placeholder|xxxx|changeme|<[^>]+>/i.test(trimmed)) return;

    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push(`${rel}:${i + 1} — ${name}`);
    }
  });
}

// Files that must never be committed.
const forbidden = ['.env', '.env.local', '.env.production', '.data/master.key', '.data/acquisition.db'];
const present = forbidden.filter((f) => fs.existsSync(path.join(ROOT, f)));
const tracked = new Set(trackedFiles());
const committedForbidden = present.filter((f) => tracked.has(f));

console.log(`Scanned ${files.length} tracked source files.`);

let failed = false;

if (findings.length) {
  failed = true;
  console.log(`\n✗ ${findings.length} possible credential(s) in source:`);
  for (const f of findings.slice(0, 20)) console.log(`    ${f}`);
}

if (committedForbidden.length) {
  failed = true;
  console.log(`\n✗ Files that must never be committed are tracked by git:`);
  for (const f of committedForbidden) console.log(`    ${f}`);
}

// A .env or a database file may exist locally, but must be gitignored.
// Ask git itself rather than pattern-matching .gitignore, because a rule like
// ".data" or "*.db" covers these paths without naming them literally.
if (present.length && committedForbidden.length === 0) {
  const unignored = present.filter((f) => {
    try {
      execSync(`git check-ignore -q ${JSON.stringify(f)}`, { cwd: ROOT, stdio: 'ignore' });
      return false; // ignored — good
    } catch {
      return true; // not ignored — a problem
    }
  });
  if (unignored.length) {
    failed = true;
    console.log(`\n✗ Present locally but not gitignored: ${unignored.join(', ')}`);
  } else {
    console.log(`✓ ${present.length} sensitive local file(s) are correctly gitignored.`);
  }
}

if (failed) {
  console.log('\nSecret scan FAILED.');
  process.exit(1);
}

console.log('✓ No credentials found in tracked source.');
console.log('✓ No secret-bearing files are tracked by git.');
