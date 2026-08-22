import { randomUUID } from 'node:crypto';

import { newId } from '@fiyatucuz/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createMerchantService,
  InvalidDomainError,
  MerchantNotFoundError,
  MerchantSiteDomainAlreadyExistsError,
  MerchantSiteDomainAlreadyVerifiedElsewhereError,
  MerchantSiteNotFoundError,
  MerchantSlugAlreadyExistsError,
  VerificationChallengeMissingError,
  VerificationTokenMismatchError,
  type MerchantService,
} from '../src/modules/merchants/index.js';

import { isPostgresReachable, makeTestDbHandle, truncateAllBusinessTables } from './helpers.js';

const reachable = await isPostgresReachable();

// ---------------------------------------------------------------------------
// Test-only harness: seed two tenants, produce a service instance sharing the
// same HMAC secret as the auth token module in tests.
// ---------------------------------------------------------------------------

const HMAC_SECRET = 'test_only_fixed_hmac_secret_at_least_32_chars_long_xxxxxxx';

async function ensureTenant(
  handle: ReturnType<typeof makeTestDbHandle>,
  slugSuffix: string,
): Promise<string> {
  const id = randomUUID();
  await handle.sql`
    insert into tenants (id, name, slug)
      values (${id}, ${'test-' + slugSuffix}, ${'t-' + slugSuffix + '-' + id.slice(0, 8)})
  `;
  return id;
}

describe.skipIf(!reachable)('merchants: service (integration)', () => {
  const dbHandle = makeTestDbHandle();
  let svc: MerchantService;

  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await truncateAllBusinessTables(dbHandle.sql);
    svc = createMerchantService({ db: dbHandle.db, hmacSecret: HMAC_SECRET });
  });

  afterEach(async () => {
    await truncateAllBusinessTables(dbHandle.sql);
  });

  afterAll(async () => {
    await dbHandle.close();
  });

  // Seed fresh tenants for each test since afterEach truncates them.
  async function seedTenants(): Promise<void> {
    tenantA = await ensureTenant(dbHandle, 'A');
    tenantB = await ensureTenant(dbHandle, 'B');
  }

  // -- MERCHANT ------------------------------------------------------------

  it('createMerchant returns a row with tenant + slug set', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'Acme', slug: 'acme' });
    expect(m.tenantId).toBe(tenantA);
    expect(m.slug).toBe('acme');
    expect(m.status).toBe('ACTIVE');
  });

  it('listMerchants returns only rows for the bound tenant', async () => {
    await seedTenants();
    await svc.createMerchant(tenantA, { name: 'Ma', slug: 'ma' });
    await svc.createMerchant(tenantB, { name: 'Mb', slug: 'mb' });
    const listA = await svc.listMerchants(tenantA);
    const listB = await svc.listMerchants(tenantB);
    expect(listA.map((m) => m.slug)).toEqual(['ma']);
    expect(listB.map((m) => m.slug)).toEqual(['mb']);
  });

  it('getMerchant returns row', async () => {
    await seedTenants();
    const created = await svc.createMerchant(tenantA, { name: 'X', slug: 'get-x' });
    const found = await svc.getMerchant(tenantA, created.id);
    expect(found.id).toBe(created.id);
  });

  it('updateMerchant patches name + status', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'Old', slug: 'upd' });
    const updated = await svc.updateMerchant(tenantA, m.id, {
      name: 'New',
      status: 'SUSPENDED',
    });
    expect(updated.name).toBe('New');
    expect(updated.status).toBe('SUSPENDED');
  });

  it('duplicate slug within same tenant is rejected as MerchantSlugAlreadyExistsError', async () => {
    await seedTenants();
    await svc.createMerchant(tenantA, { name: 'A', slug: 'dupe' });
    await expect(
      svc.createMerchant(tenantA, { name: 'B', slug: 'dupe' }),
    ).rejects.toBeInstanceOf(MerchantSlugAlreadyExistsError);
  });

  it('same slug in a different tenant is allowed', async () => {
    await seedTenants();
    await svc.createMerchant(tenantA, { name: 'A', slug: 'cross-tenant-slug' });
    // Must not throw.
    const b = await svc.createMerchant(tenantB, { name: 'B', slug: 'cross-tenant-slug' });
    expect(b.slug).toBe('cross-tenant-slug');
  });

  it('getMerchant for a merchant owned by another tenant → MerchantNotFoundError', async () => {
    await seedTenants();
    const mB = await svc.createMerchant(tenantB, { name: 'B', slug: 'xt' });
    await expect(svc.getMerchant(tenantA, mB.id)).rejects.toBeInstanceOf(MerchantNotFoundError);
  });

  it('updateMerchant against another tenant\'s merchant → MerchantNotFoundError', async () => {
    await seedTenants();
    const mB = await svc.createMerchant(tenantB, { name: 'B', slug: 'xu' });
    await expect(
      svc.updateMerchant(tenantA, mB.id, { name: 'hijack' }),
    ).rejects.toBeInstanceOf(MerchantNotFoundError);
  });

  it('concurrent slug INSERTs → exactly one 201, other becomes controlled 409', async () => {
    await seedTenants();
    const [a, b] = await Promise.allSettled([
      svc.createMerchant(tenantA, { name: 'A', slug: 'race' }),
      svc.createMerchant(tenantA, { name: 'B', slug: 'race' }),
    ]);
    const outcomes = [a, b].map((r) => (r.status === 'fulfilled' ? 'ok' : (r.reason as Error).name));
    expect(outcomes.filter((o) => o === 'ok').length).toBe(1);
    expect(outcomes.filter((o) => o === 'MerchantSlugAlreadyExistsError').length).toBe(1);
  });

  // -- MERCHANT_SITES ------------------------------------------------------

  it('createMerchantSite normalizes the domain', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'norm' });
    const s = await svc.createMerchantSite(tenantA, m.id, {
      name: 'Site',
      domain: 'https://WWW.Example.com/',
    });
    expect(s.normalizedDomain).toBe('example.com');
    expect(s.domain).toBe('https://WWW.Example.com/'); // display form preserved
    expect(s.verificationStatus).toBe('UNVERIFIED');
  });

  it('rejects invalid domain input with InvalidDomainError', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'inv' });
    await expect(
      svc.createMerchantSite(tenantA, m.id, { name: 'Bad', domain: 'not a domain' }),
    ).rejects.toBeInstanceOf(InvalidDomainError);
  });

  it('duplicate normalized_domain within same tenant is rejected', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'ddom' });
    await svc.createMerchantSite(tenantA, m.id, { name: 'A', domain: 'shop.example' });
    await expect(
      svc.createMerchantSite(tenantA, m.id, { name: 'B', domain: 'SHOP.Example' }),
    ).rejects.toBeInstanceOf(MerchantSiteDomainAlreadyExistsError);
  });

  it('same UNVERIFIED domain across DIFFERENT tenants is allowed (per ADR-0015)', async () => {
    await seedTenants();
    const mA = await svc.createMerchant(tenantA, { name: 'A', slug: 'xda' });
    const mB = await svc.createMerchant(tenantB, { name: 'B', slug: 'xdb' });
    await svc.createMerchantSite(tenantA, mA.id, {
      name: 'A',
      domain: 'contested.example',
    });
    // Different tenant, same domain, still UNVERIFIED → allowed.
    const b = await svc.createMerchantSite(tenantB, mB.id, {
      name: 'B',
      domain: 'contested.example',
    });
    expect(b.normalizedDomain).toBe('contested.example');
  });

  it('listMerchantSites returns only rows for the (tenant, merchant) pair', async () => {
    await seedTenants();
    const mA = await svc.createMerchant(tenantA, { name: 'A', slug: 'lsa' });
    const mB = await svc.createMerchant(tenantA, { name: 'B', slug: 'lsb' });
    await svc.createMerchantSite(tenantA, mA.id, { name: 'A', domain: 'a.example' });
    await svc.createMerchantSite(tenantA, mB.id, { name: 'B', domain: 'b.example' });
    const listA = await svc.listMerchantSites(tenantA, mA.id);
    expect(listA.map((s) => s.normalizedDomain)).toEqual(['a.example']);
  });

  it('getMerchantSite for another tenant\'s site → MerchantSiteNotFoundError (or MerchantNotFoundError depending on scoping)', async () => {
    await seedTenants();
    const mB = await svc.createMerchant(tenantB, { name: 'B', slug: 'xsb' });
    const sB = await svc.createMerchantSite(tenantB, mB.id, {
      name: 'B',
      domain: 'foreign.example',
    });
    // Tenant A cannot see tenant B's merchant → MerchantNotFoundError before we even reach the site lookup.
    await expect(svc.getMerchantSite(tenantA, mB.id, sB.id)).rejects.toBeInstanceOf(
      MerchantNotFoundError,
    );
  });

  // -- VERIFICATION --------------------------------------------------------

  it('createSiteVerificationChallenge returns raw token + instructions and stores ONLY the hash', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'vch' });
    const s = await svc.createMerchantSite(tenantA, m.id, {
      name: 'S',
      domain: 'chall.example',
    });
    const { site, challenge } = await svc.createSiteVerificationChallenge(
      tenantA,
      m.id,
      s.id,
      { method: 'DNS_TXT' },
    );
    // Raw token is high-entropy base64url and NEVER equals the stored hash.
    expect(challenge.rawToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(site.verificationTokenHash).not.toBe(challenge.rawToken);
    expect(site.verificationStatus).toBe('PENDING');
    expect(site.verificationMethod).toBe('DNS_TXT');

    // Confirm the stored value is a hash, not the raw token — directly from
    // the DB.
    const stored = await dbHandle.sql`
      select verification_token_hash from merchant_sites where id = ${s.id}
    `;
    const dbHash = (stored[0] as { verification_token_hash: string }).verification_token_hash;
    expect(dbHash).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(dbHash).not.toBe(challenge.rawToken);
    // No DB column contains the raw token verbatim.
    const anyRaw = await dbHandle.sql`
      select count(*)::int as c from merchant_sites
       where domain like ${'%' + challenge.rawToken + '%'}
          or normalized_domain like ${'%' + challenge.rawToken + '%'}
    `;
    expect((anyRaw[0] as { c: number }).c).toBe(0);
  });

  it('createSiteVerificationChallenge for HTML_FILE builds a well-known file path', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'hf' });
    const s = await svc.createMerchantSite(tenantA, m.id, {
      name: 'S',
      domain: 'hf.example',
    });
    const { challenge } = await svc.createSiteVerificationChallenge(tenantA, m.id, s.id, {
      method: 'HTML_FILE',
    });
    expect(challenge.instructions.filePath).toMatch(/^\/\.well-known\/fiyatucuz-challenge\//);
  });

  it('finalizeSiteVerification with correct raw token transitions to VERIFIED', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'fv' });
    const s = await svc.createMerchantSite(tenantA, m.id, {
      name: 'S',
      domain: 'good.example',
    });
    const { challenge } = await svc.createSiteVerificationChallenge(tenantA, m.id, s.id, {
      method: 'DNS_TXT',
    });
    const verified = await svc.finalizeSiteVerification(tenantA, m.id, s.id, challenge.rawToken);
    expect(verified.verificationStatus).toBe('VERIFIED');
    expect(verified.verifiedAt).toBeInstanceOf(Date);
  });

  it('finalizeSiteVerification with WRONG raw token → VerificationTokenMismatchError + status FAILED', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'mm' });
    const s = await svc.createMerchantSite(tenantA, m.id, {
      name: 'S',
      domain: 'wrong.example',
    });
    await svc.createSiteVerificationChallenge(tenantA, m.id, s.id, { method: 'DNS_TXT' });
    await expect(
      svc.finalizeSiteVerification(tenantA, m.id, s.id, 'not-the-real-token'),
    ).rejects.toBeInstanceOf(VerificationTokenMismatchError);
    const after = await svc.getMerchantSite(tenantA, m.id, s.id);
    expect(after.verificationStatus).toBe('FAILED');
  });

  it('finalizeSiteVerification without a prior challenge → VerificationChallengeMissingError', async () => {
    await seedTenants();
    const m = await svc.createMerchant(tenantA, { name: 'M', slug: 'nc' });
    const s = await svc.createMerchantSite(tenantA, m.id, {
      name: 'S',
      domain: 'never.example',
    });
    await expect(
      svc.finalizeSiteVerification(tenantA, m.id, s.id, 'anything'),
    ).rejects.toBeInstanceOf(VerificationChallengeMissingError);
  });

  it('cross-tenant verified-domain uniqueness: second finalize → MerchantSiteDomainAlreadyVerifiedElsewhereError', async () => {
    await seedTenants();
    const mA = await svc.createMerchant(tenantA, { name: 'A', slug: 'xa' });
    const mB = await svc.createMerchant(tenantB, { name: 'B', slug: 'xb' });
    const domain = 'race.example';
    const sA = await svc.createMerchantSite(tenantA, mA.id, { name: 'A', domain });
    const sB = await svc.createMerchantSite(tenantB, mB.id, { name: 'B', domain });

    const { challenge: chA } = await svc.createSiteVerificationChallenge(
      tenantA, mA.id, sA.id, { method: 'DNS_TXT' },
    );
    const { challenge: chB } = await svc.createSiteVerificationChallenge(
      tenantB, mB.id, sB.id, { method: 'DNS_TXT' },
    );
    await svc.finalizeSiteVerification(tenantA, mA.id, sA.id, chA.rawToken);
    await expect(
      svc.finalizeSiteVerification(tenantB, mB.id, sB.id, chB.rawToken),
    ).rejects.toBeInstanceOf(MerchantSiteDomainAlreadyVerifiedElsewhereError);
  });

  it('createSiteVerificationChallenge for a site under a different tenant is rejected (MerchantSiteNotFoundError)', async () => {
    await seedTenants();
    const mB = await svc.createMerchant(tenantB, { name: 'B', slug: 'xcv' });
    const sB = await svc.createMerchantSite(tenantB, mB.id, {
      name: 'B',
      domain: 'foreign2.example',
    });
    // The service enters withTenantTransaction bound to tenantA, then
    // requireMerchantSite filters by (tenantA, mB.id, sB.id) — no rows →
    // MerchantSiteNotFoundError. Either not-found variant is a correct
    // fail-closed outcome; test the actual behavior.
    await expect(
      svc.createSiteVerificationChallenge(tenantA, mB.id, sB.id, { method: 'DNS_TXT' }),
    ).rejects.toBeInstanceOf(MerchantSiteNotFoundError);
  });

  it('siteId that belongs to a different merchant of the same tenant → MerchantSiteNotFoundError', async () => {
    await seedTenants();
    const mA = await svc.createMerchant(tenantA, { name: 'A', slug: 'sma' });
    const mA2 = await svc.createMerchant(tenantA, { name: 'A2', slug: 'sma2' });
    const s = await svc.createMerchantSite(tenantA, mA.id, {
      name: 'S',
      domain: 'wrong-merchant.example',
    });
    // Right tenant, wrong merchant.
    await expect(
      svc.getMerchantSite(tenantA, mA2.id, s.id),
    ).rejects.toBeInstanceOf(MerchantSiteNotFoundError);
    // Reference newId is not used here but keeps @fiyatucuz/db imported for consistency.
    void newId;
  });
});

if (!reachable) {
  console.warn('[@fiyatucuz/api] merchants.test.ts: skipping — PG unreachable.');
}
