/**
 * Unit tests — pure business logic, no database, no network.
 */
import { hashPassword, verifyPassword, needsRehash, validatePassword } from '../src/lib/password';
import { similarity } from '../src/repo/business';
import { evaluateBranch } from '../src/engine/sequenceBranching';
import { classifySentiment, cosineSimilarity, extractiveSummary } from '../src/lib/ai/local';
import { normalizeDomain, normalizeEmail, normalizePhone, slugify } from '../src/lib/id';
import { inQuietHours } from '../src/engine/compliance';
import { scoreBand, PIPELINE, PILLARS, BRAND, SERVICE_CATALOGUE } from '../src/lib/brand';
import { STAGE_ORDER, PIPELINE_STAGES } from '../src/lib/domain';
import { buildSiteModel } from '../src/engine/site';

const a = (globalThis as unknown as { assert: typeof import('node:assert') }).assert as never as {
  (c: unknown, m?: string): void;
  ok(v: unknown, m?: string): void;
  equal(a: unknown, b: unknown, m?: string): void;
  includes(h: unknown, n: unknown, m?: string): void;
  throws(f: () => void, m?: string): void;
};

export default [
  {
    name: 'Password hashing (§35)',
    tests: [
      {
        name: 'a password verifies against its own hash',
        run: () => {
          const { hash } = hashPassword('correct horse battery staple');
          a(verifyPassword('correct horse battery staple', hash), 'should verify');
        },
      },
      {
        name: 'a wrong password does not verify',
        run: () => {
          const { hash } = hashPassword('correct horse battery staple');
          a(!verifyPassword('wrong password entirely', hash), 'should not verify');
        },
      },
      {
        name: 'the same password hashes differently each time (salted)',
        run: () => {
          const h1 = hashPassword('same-password-here').hash;
          const h2 = hashPassword('same-password-here').hash;
          a(h1 !== h2, 'hashes must differ because the salt differs');
          a(verifyPassword('same-password-here', h1) && verifyPassword('same-password-here', h2), 'both must verify');
        },
      },
      {
        name: 'the plaintext is never stored in the hash',
        run: () => {
          const { hash } = hashPassword('mySecretPassword123');
          a(!hash.includes('mySecretPassword123'), 'plaintext must not appear');
          a(hash.startsWith('scrypt$'), 'must be self-describing scrypt format');
        },
      },
      {
        name: 'a malformed hash does not verify and does not throw',
        run: () => {
          a(!verifyPassword('anything', 'not-a-hash'), 'malformed hash must fail safely');
          a(!verifyPassword('anything', null), 'null hash must fail safely');
          a(!verifyPassword('anything', 'bcrypt$10$abc$def'), 'unsupported algorithm must fail safely');
        },
      },
      {
        name: 'weak parameters are flagged for rehash',
        run: () => {
          a(needsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA=='), 'low N must need rehash');
          a(!needsRehash(hashPassword('a-strong-password').hash), 'current params must not need rehash');
          a(needsRehash(null), 'missing hash must need rehash');
        },
      },
      {
        name: 'the password policy rejects short and common passwords',
        run: () => {
          a(validatePassword('short').length > 0, 'short must be rejected');
          a(validatePassword('password').some((i) => i.code === 'common'), 'common must be rejected');
          a(validatePassword('clientforge').some((i) => i.code === 'common'), 'product name must be rejected');
          a(validatePassword('Str0ng!Passw0rd#2026').length === 0, 'a strong password must pass');
        },
      },
    ],
  },

  {
    name: 'Fuzzy deduplication (§5)',
    tests: [
      {
        name: 'identical names score 1.0',
        run: () => a.equal(similarity('Bella Crust Bakery', 'Bella Crust Bakery'), 1, 'exact match'),
      },
      {
        name: 'legal suffixes are ignored',
        run: () => {
          const s = similarity('Bella Crust Bakery Ltd', 'Bella Crust Bakery');
          a(s > 0.9, `"Ltd" must not prevent a match (got ${s.toFixed(3)})`);
        },
      },
      {
        name: 'unrelated businesses score low and would not be merged',
        run: () => {
          const s = similarity('Bella Crust Bakery', 'Harbour Dental Studio');
          a(s < 0.5, `unrelated businesses must not match (got ${s.toFixed(3)})`);
        },
      },
      {
        name: 'similar-but-different businesses in the same trade stay distinct',
        run: () => {
          // The dangerous case: same trade, same city, different owner.
          const s = similarity('Smith Plumbing Co', 'Smiths Plumbing Ltd');
          a(s < 0.93, `near-miss must fall below the auto-merge threshold (got ${s.toFixed(3)})`);
        },
      },
      {
        name: 'empty and single-character inputs are handled safely',
        run: () => {
          a.equal(similarity('', 'anything'), 0);
          a.equal(similarity('a', 'a'), 1);
          a.equal(similarity('a', 'b'), 0);
        },
      },
    ],
  },

  {
    name: 'Compliance: quiet hours (§13)',
    tests: [
      {
        name: 'an overnight window blocks late night and allows midday',
        run: () => {
          a(inQuietHours('20:00', '08:00', new Date('2026-08-26T23:00:00Z'), 'UTC'), '23:00 must be quiet');
          a(inQuietHours('20:00', '08:00', new Date('2026-08-26T03:00:00Z'), 'UTC'), '03:00 must be quiet');
          a(!inQuietHours('20:00', '08:00', new Date('2026-08-26T12:00:00Z'), 'UTC'), '12:00 must be allowed');
        },
      },
      {
        name: 'a same-day window behaves correctly',
        run: () => {
          a(inQuietHours('12:00', '14:00', new Date('2026-08-26T13:00:00Z'), 'UTC'), '13:00 inside 12-14 must be quiet');
          a(!inQuietHours('12:00', '14:00', new Date('2026-08-26T15:00:00Z'), 'UTC'), '15:00 must be allowed');
        },
      },
      {
        name: 'window boundaries are inclusive at start and exclusive at end',
        run: () => {
          a(inQuietHours('20:00', '08:00', new Date('2026-08-26T20:00:00Z'), 'UTC'), 'exactly 20:00 must be quiet');
          a(!inQuietHours('20:00', '08:00', new Date('2026-08-26T08:00:00Z'), 'UTC'), 'exactly 08:00 must be allowed');
        },
      },
    ],
  },

  {
    name: 'Response sentiment (§14)',
    tests: [
      {
        name: 'an explicit opt-out is classified negative',
        run: () => {
          const r = classifySentiment('Please unsubscribe, I am not interested.');
          a.equal(r.label, 'negative');
        },
      },
      {
        name: 'a request to talk is classified positive',
        run: () => {
          const r = classifySentiment("Thanks, let's talk next week — send me some times.");
          a.equal(r.label, 'positive');
        },
      },
      {
        name: 'a neutral acknowledgement is not over-read',
        run: () => {
          const r = classifySentiment('Received.');
          a.equal(r.label, 'neutral');
        },
      },
    ],
  },

  {
    name: 'Identifiers and normalisation',
    tests: [
      {
        name: 'domains are normalised consistently',
        run: () => {
          a.equal(normalizeDomain('https://www.Example.com/path?q=1'), 'example.com');
          a.equal(normalizeDomain('http://example.com'), 'example.com');
          a.equal(normalizeDomain(''), null);
          a.equal(normalizeDomain(null), null);
        },
      },
      {
        name: 'emails are lowercased and invalid ones rejected',
        run: () => {
          a.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
          a.equal(normalizeEmail('not-an-email'), null);
          a.equal(normalizeEmail('a@b'), null);
        },
      },
      {
        name: 'phones reduce to comparable digits',
        run: () => {
          a.equal(normalizePhone('+44 (117) 496-0142'), '1174960142');
          a.equal(normalizePhone('123'), null, 'too short to be a phone number');
        },
      },
      {
        name: 'slugs are url-safe',
        run: () => {
          a.equal(slugify('Bella Crust & Co. — Bakery!'), 'bella-crust-co-bakery');
        },
      },
    ],
  },

  {
    name: 'Text utilities',
    tests: [
      {
        name: 'cosine similarity separates distinct texts',
        run: () => {
          const same = cosineSimilarity('the quick brown fox', 'the quick brown fox');
          const diff = cosineSimilarity('the quick brown fox', 'completely unrelated sentence here');
          a(same > 0.99, `identical texts must be ~1.0 (got ${same})`);
          a(diff < 0.3, `unrelated texts must be low (got ${diff.toFixed(3)})`);
        },
      },
      {
        name: 'extractive summary keeps the most informative sentences',
        run: () => {
          const text = 'Alpha beta gamma. Delta epsilon. Zeta eta theta iota kappa lambda mu.';
          const summary = extractiveSummary(text, 1);
          a(summary.length > 0 && summary.length < text.length, 'summary must be shorter than the source');
        },
      },
    ],
  },

  {
    name: 'Brand invariants (§ product identity)',
    tests: [
      {
        name: 'the product name is exactly "ClientForge AI"',
        run: () => a.equal(BRAND.name, 'ClientForge AI'),
      },
      {
        name: 'the wordmark splits ClientForge dominant and AI secondary',
        run: () => {
          a.equal(BRAND.markPrimary, 'ClientForge');
          a.equal(BRAND.markSecondary, 'AI');
        },
      },
      {
        name: 'the tagline matches the brand spec',
        run: () => a.equal(BRAND.tagline, 'Discover. Personalize. Convert. Deliver.'),
      },
      {
        name: 'there are exactly seven pillars, ending at Grow',
        run: () => {
          a.equal(PILLARS.length, 7);
          a.equal(PILLARS[6].key, 'grow');
          a.equal(PILLARS[0].key, 'discover');
        },
      },
      {
        name: 'the pipeline has 14 ClientForge stages',
        run: () => a.equal(PIPELINE.length, 14),
      },
      {
        name: 'the service catalogue is service-agnostic',
        run: () => a(SERVICE_CATALOGUE.length >= 14, `expected >= 14 services, got ${SERVICE_CATALOGUE.length}`),
      },
      {
        name: 'every pipeline stage has a defined order',
        run: () => {
          for (const s of PIPELINE_STAGES) {
            a(typeof STAGE_ORDER[s] === 'number', `${s} must have an order`);
          }
        },
      },
    ],
  },

  {
    name: 'Opportunity score banding (§7)',
    tests: [
      {
        name: 'bands map to the documented thresholds',
        run: () => {
          a.equal(scoreBand(95).tone, 'critical');
          a.equal(scoreBand(88).tone, 'critical');
          a.equal(scoreBand(75).tone, 'high');
          a.equal(scoreBand(70).tone, 'high');
          a.equal(scoreBand(50).tone, 'medium');
          a.equal(scoreBand(45).tone, 'medium');
          a.equal(scoreBand(20).tone, 'low');
        },
      },
      {
        name: 'every band has a human-readable label',
        run: () => {
          for (const score of [0, 30, 60, 80, 99]) {
            a(scoreBand(score).label.length > 0, `${score} must have a label`);
          }
        },
      },
    ],
  },

  {
    name: 'Website concept generation (§15)',
    tests: [
      {
        name: 'a concept contains the required sections',
        run: () => {
          const model = buildSiteModel({
            name: 'Bella Crust Bakery',
            category: 'Bakery',
            industry: 'Food & Hospitality',
            locality: 'Bristol',
            services: ['Sourdough loaves', 'Celebration cakes'],
            rating: 4.8,
            reviewCount: 214,
            phone: '+44 117 496 0142',
          });
          const types = model.sections.map((s) => s.type);
          const required: (typeof types)[number][] = ['hero', 'services', 'about', 'contact', 'footer'];
          for (const r of required) {
            a(types.includes(r), `missing required section: ${r}`);
          }
        },
      },
      {
        name: 'two different businesses get different concepts',
        run: () => {
          const bakery = buildSiteModel({ name: 'Bella Crust Bakery', category: 'Bakery', phone: '+44 117 496 0142' });
          const dentist = buildSiteModel({ name: 'Harbour Dental Studio', category: 'Dentist', phone: '+44 23 9222 0188' });
          a(bakery.theme.direction !== dentist.theme.direction || bakery.theme.palette.accent !== dentist.theme.palette.accent,
            'concepts must not be identical');
        },
      },
      {
        name: 'the same business generates a stable concept',
        run: () => {
          const a1 = buildSiteModel({ name: 'Bella Crust Bakery', category: 'Bakery', phone: '+44 117 496 0142' });
          const a2 = buildSiteModel({ name: 'Bella Crust Bakery', category: 'Bakery', phone: '+44 117 496 0142' });
          a.equal(a1.theme.direction, a2.theme.direction, 'the seed is the business, so output must be stable');
          a.equal(a1.theme.palette.accent, a2.theme.palette.accent);
        },
      },
      {
        name: 'missing services produce flagged placeholders, not invented ones',
        run: () => {
          const model = buildSiteModel({ name: 'Unknown Business', category: 'Unknown' });
          const services = model.sections.find((s) => s.type === 'services');
          a(services?.needsReview === true, 'services section must be flagged for review');
          a(services?.items?.some((i) => i.title.includes('[Add')), 'placeholder must be visibly marked');
        },
      },
      {
        name: 'a real rating is used and no review quote is invented',
        run: () => {
          const model = buildSiteModel({
            name: 'Bella Crust Bakery',
            category: 'Bakery',
            rating: 4.8,
            reviewCount: 214,
          });
          const trust = model.sections.find((s) => s.type === 'trustbar');
          a(trust?.items?.some((i) => i.title.includes('4.8')), 'the real rating must appear');
          const testimonials = model.sections.find((s) => s.type === 'testimonials');
          // No review text was supplied, so either the section is absent or flagged.
          a(!testimonials || testimonials.needsReview === true, 'no review quote may be invented');
        },
      },
    ],
  },
];
