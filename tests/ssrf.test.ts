/**
 * SSRF protection tests (§17, §11, §35).
 *
 * The website auditor fetches URLs taken from discovered or imported business
 * records, which an attacker can influence. These tests prove the auditor
 * cannot be turned into a proxy into internal infrastructure.
 */
import { assertSafeUrl, assertSafeRedirectChain, isPrivateAddress, isObviouslyUnsafeUrl } from '../src/lib/ssrf';
import { auditWebsite, verifyWebsiteStatus } from '../src/lib/audit/website';

const a = (globalThis as unknown as { assert: unknown }).assert as never as {
  (c: unknown, m?: string): void;
  ok(v: unknown, m?: string): void;
  equal(a: unknown, b: unknown, m?: string): void;
};

const BLOCKED = [
  'http://127.0.0.1/admin',
  'http://127.0.0.1:3000/api/health',
  'http://localhost:3000/api/health',
  'http://localhost.localdomain/',
  'http://169.254.169.254/latest/meta-data/',
  'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
  'http://10.0.0.5/internal',
  'http://10.255.255.255/',
  'http://192.168.1.1/router',
  'http://192.168.0.1/',
  'http://172.16.0.1/',
  'http://172.31.255.255/',
  'http://0.0.0.0/',
  'http://224.0.0.1/',
  'http://255.255.255.255/',
  'http://100.64.0.1/',
  'http://198.18.0.1/',
  'http://[::1]/',
  'http://[::]/',
  'http://[fe80::1]/',
  'http://[fc00::1]/',
  'http://[fd00:ec2::254]/',
  'http://[::ffff:127.0.0.1]/',
  'http://metadata.google.internal/',
  'http://metadata/',
  'http://instance-data/',
  'http://db.internal/',
  'http://api.svc.cluster.local/',
  'http://router.lan/',
  'file:///etc/passwd',
  'gopher://127.0.0.1:6379/',
  'ftp://127.0.0.1/',
  'data:text/html,<script>alert(1)</script>',
  'javascript:alert(1)',
  'not a url at all',
];

export default [
  {
    name: 'SSRF: blocked targets',
    tests: BLOCKED.map((url) => ({
      name: `refuses ${url}`,
      run: async () => {
        const v = await assertSafeUrl(url);
        a.equal(v.safe, false, `must refuse ${url}${v.reason ? ` (got: ${v.reason})` : ''}`);
      },
    })),
  },

  {
    name: 'SSRF: address classification',
    tests: [
      {
        name: 'private and reserved IPv4 ranges are classified private',
        run: () => {
          for (const ip of [
            '127.0.0.1', '127.255.255.255', '10.0.0.1', '10.255.255.255',
            '192.168.0.1', '192.168.255.255', '172.16.0.1', '172.31.255.255',
            '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
            '100.64.0.1', '198.18.0.1',
          ]) {
            a.equal(isPrivateAddress(ip), true, `${ip} must be private`);
          }
        },
      },
      {
        name: 'public IPv4 addresses are not classified private',
        run: () => {
          for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '192.169.0.1', '100.63.255.255', '198.20.0.1', '93.184.216.34']) {
            a.equal(isPrivateAddress(ip), false, `${ip} must be public`);
          }
        },
      },
      {
        name: 'IPv6 loopback, link-local and unique-local are private',
        run: () => {
          for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fd00:ec2::254']) {
            a.equal(isPrivateAddress(ip), true, `${ip} must be private`);
          }
        },
      },
      {
        name: 'IPv4-mapped IPv6 is judged by its IPv4 half',
        run: () => {
          a.equal(isPrivateAddress('::ffff:127.0.0.1'), true, 'mapped loopback must be private');
          a.equal(isPrivateAddress('::ffff:10.0.0.1'), true, 'mapped private must be private');
          a.equal(isPrivateAddress('::ffff:8.8.8.8'), false, 'mapped public must be public');
        },
      },
      {
        name: 'a non-IP string cannot be proven public and is refused',
        run: () => a.equal(isPrivateAddress('not-an-ip'), true),
      },
    ],
  },

  {
    name: 'SSRF: the website auditor refuses internal targets',
    tests: [
      {
        name: 'auditWebsite refuses a loopback URL and fabricates nothing',
        run: async () => {
          const r = await auditWebsite('http://127.0.0.1:3000', { timeoutMs: 4000 });
          a.equal(r.websiteStatus, 'unreachable', 'must report unreachable');
          a.equal(r.verified, false, 'must not claim verification');
          a(String(r.error).startsWith('Refused'), `error must explain the refusal, got: ${r.error}`);
          a.equal(r.scores.website, 0, 'no fabricated score');
          a.equal(r.title, null, 'no fabricated title');
        },
      },
      {
        name: 'auditWebsite refuses the cloud metadata endpoint',
        run: async () => {
          const r = await auditWebsite('http://169.254.169.254/latest/meta-data/', { timeoutMs: 4000 });
          a.equal(r.verified, false, 'must not claim verification');
          a(String(r.error).startsWith('Refused'), `must refuse, got: ${r.error}`);
        },
      },
      {
        name: 'auditWebsite refuses localhost',
        run: async () => {
          const r = await auditWebsite('http://localhost/admin', { timeoutMs: 4000 });
          a(String(r.error).startsWith('Refused'), `must refuse, got: ${r.error}`);
        },
      },
      {
        name: 'verifyWebsiteStatus refuses internal targets too',
        run: async () => {
          const r = await verifyWebsiteStatus('http://10.0.0.1/internal');
          a.equal(r.status, 'unreachable');
          a.equal(r.httpStatus, null, 'no request may have been made');
        },
      },
      {
        name: 'a non-http scheme is refused by the auditor',
        run: async () => {
          const r = await auditWebsite('file:///etc/passwd', { timeoutMs: 4000 });
          a.equal(r.verified, false);
          a(String(r.error).startsWith('Refused'), `must refuse, got: ${r.error}`);
        },
      },
    ],
  },

  {
    name: 'SSRF: redirect chains',
    tests: [
      {
        name: 'a public URL that redirects to a private address is refused',
        run: async () => {
          const v = await assertSafeRedirectChain(['https://example.com/', 'http://169.254.169.254/latest/meta-data/']);
          a.equal(v.safe, false, 'the redirect hop must be caught');
          a(String(v.reason).includes('redirect'), `reason must name the redirect, got: ${v.reason}`);
        },
      },
      {
        name: 'a redirect into loopback is refused',
        run: async () => {
          const v = await assertSafeRedirectChain(['https://example.com/', 'http://127.0.0.1:3000/']);
          a.equal(v.safe, false);
        },
      },
      {
        name: 'a fully public chain is accepted',
        run: async () => {
          const v = await assertSafeRedirectChain(['https://example.com/', 'https://www.example.com/page']);
          a.equal(v.safe, true, `a public chain must be allowed, got: ${v.reason}`);
        },
      },
    ],
  },

  {
    name: 'SSRF: synchronous pre-filter',
    tests: [
      {
        name: 'obviously unsafe URLs are caught without DNS',
        run: () => {
          for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/', 'file:///etc/passwd', 'http://x.internal/', 'garbage']) {
            a.equal(isObviouslyUnsafeUrl(url), true, `${url} must be flagged`);
          }
        },
      },
      {
        name: 'a normal public URL is not flagged',
        run: () => a.equal(isObviouslyUnsafeUrl('https://example.com/'), false),
      },
    ],
  },
];
