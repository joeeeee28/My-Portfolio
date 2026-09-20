/**
 * Minimal test runner — no external test framework dependency.
 *
 * Usage: node scripts/test-runner.mjs <glob-or-path> [...]
 * Test files export an array of { name, run } suites via default export.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const args = process.argv.slice(2);
const targets = args.length ? args : ['tests'];

let files = [];
for (const t of targets) {
  const abs = path.resolve(t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    files.push(
      ...fs
        .readdirSync(abs)
        .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.mjs'))
        .map((f) => path.join(abs, f))
    );
  } else if (fs.existsSync(abs)) {
    files.push(abs);
  }
}

let passed = 0;
let failed = 0;
const failures = [];

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}
assert.equal = (actual, expected, message) => {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};
assert.ok = (v, m) => assert(!!v, m || `expected truthy, got ${JSON.stringify(v)}`);
assert.includes = (haystack, needle, m) =>
  assert(String(haystack).includes(needle), m || `expected "${haystack}" to include "${needle}"`);
assert.throws = (fn, m) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, m || 'expected function to throw');
};

globalThis.assert = assert;

for (const file of files) {
  const mod = await import(pathToFileURL(file).href);
  const suites = mod.default ?? [];
  console.log(`\n${path.basename(file)}`);
  for (const suite of suites) {
    console.log(`  ${suite.name}`);
    for (const test of suite.tests) {
      try {
        await test.run();
        passed++;
        console.log(`    ✓ ${test.name}`);
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${path.basename(file)} › ${suite.name} › ${test.name}: ${message}`);
        console.log(`    ✗ ${test.name}\n        ${message}`);
      }
    }
  }
}

console.log(`\n${'═'.repeat(52)}`);
console.log(`  ${passed} passed · ${failed} failed`);
if (failures.length) {
  console.log('\n  Failures:');
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log('═'.repeat(52));
process.exit(failed ? 1 : 0);
