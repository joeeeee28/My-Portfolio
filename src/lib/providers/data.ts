/**
 * Discovery providers (§3).
 *
 * Two families:
 *  1. Zero-credential sources that genuinely work in this environment —
 *     OpenStreetMap Overpass returns real business records from public OSM data.
 *  2. Credential-gated commercial sources with complete, real HTTP
 *     implementations that activate the moment a key is stored in the vault.
 *     Until then they report `configured: false` and return no records.
 *
 * No provider ever invents a business.
 */
import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult, DiscoveredRecord } from './registry';
import { httpJson, qs, rateLimitWait, sleep } from '@/lib/http';
import { providerCredential } from './registry';

// ── 1. OpenStreetMap Overpass — live, no credentials ─────────
/**
 * Queries real public business data by category/amenity. OSM tags carry name,
 * website, phone, email, address, opening hours and wheelchair access — which
 * maps directly onto our website/social/accessibility opportunity signals.
 *
 * Scope (country/area/bbox) is a property of THIS source, not of the product:
 * the orchestrator still asks for opportunities by business type, and other
 * sources need no scope at all (§2).
 */
const OSM_CATEGORY_MAP: Record<string, { tag: string; value: string; industry: string; category: string }> = {
  restaurant: { tag: 'amenity', value: 'restaurant', industry: 'Food & Hospitality', category: 'Restaurant' },
  cafe: { tag: 'amenity', value: 'cafe', industry: 'Food & Hospitality', category: 'Café' },
  bakery: { tag: 'shop', value: 'bakery', industry: 'Food & Hospitality', category: 'Bakery' },
  bar: { tag: 'amenity', value: 'bar', industry: 'Food & Hospitality', category: 'Bar' },
  dentist: { tag: 'amenity', value: 'dentist', industry: 'Health & Wellness', category: 'Dentist' },
  clinic: { tag: 'amenity', value: 'clinic', industry: 'Health & Wellness', category: 'Clinic' },
  pharmacy: { tag: 'amenity', value: 'pharmacy', industry: 'Health & Wellness', category: 'Pharmacy' },
  veterinary: { tag: 'amenity', value: 'veterinary', industry: 'Health & Wellness', category: 'Veterinary' },
  gym: { tag: 'leisure', value: 'fitness_centre', industry: 'Health & Wellness', category: 'Gym' },
  beauty: { tag: 'shop', value: 'beauty', industry: 'Beauty & Personal Care', category: 'Beauty salon' },
  hairdresser: { tag: 'shop', value: 'hairdresser', industry: 'Beauty & Personal Care', category: 'Hair salon' },
  car_repair: { tag: 'shop', value: 'car_repair', industry: 'Automotive', category: 'Auto repair' },
  car_dealer: { tag: 'shop', value: 'car', industry: 'Automotive', category: 'Car dealership' },
  plumber: { tag: 'craft', value: 'plumber', industry: 'Home Services', category: 'Plumber' },
  electrician: { tag: 'craft', value: 'electrician', industry: 'Home Services', category: 'Electrician' },
  lawyer: { tag: 'office', value: 'lawyer', industry: 'Professional Services', category: 'Law firm' },
  accountant: { tag: 'office', value: 'accountant', industry: 'Professional Services', category: 'Accountant' },
  estate_agent: { tag: 'office', value: 'estate_agent', industry: 'Real Estate', category: 'Estate agent' },
  hotel: { tag: 'tourism', value: 'hotel', industry: 'Travel & Hospitality', category: 'Hotel' },
  guest_house: { tag: 'tourism', value: 'guest_house', industry: 'Travel & Hospitality', category: 'Guest house' },
  boutique: { tag: 'shop', value: 'boutique', industry: 'Retail', category: 'Boutique' },
  furniture: { tag: 'shop', value: 'furniture', industry: 'Retail', category: 'Furniture store' },
  florist: { tag: 'shop', value: 'florist', industry: 'Retail', category: 'Florist' },
  pet_shop: { tag: 'shop', value: 'pet', industry: 'Retail', category: 'Pet shop' },
  photographer: { tag: 'craft', value: 'photographer', industry: 'Creative Services', category: 'Photographer' },
  tailor: { tag: 'shop', value: 'tailor', industry: 'Retail', category: 'Tailor' },
  bicycle: { tag: 'shop', value: 'bicycle', industry: 'Retail', category: 'Bicycle shop' },
  books: { tag: 'shop', value: 'books', industry: 'Retail', category: 'Bookshop' },
};

export const OSM_CATEGORIES = Object.keys(OSM_CATEGORY_MAP);

function resolveCategories(query: DiscoveryQuery): string[] {
  const wanted = [...(query.categories ?? []), ...(query.industries ?? [])].map((s) => s.toLowerCase());
  if (!wanted.length) return Object.keys(OSM_CATEGORY_MAP).slice(0, 6);
  const matched = wanted.filter((w) => OSM_CATEGORIES.includes(w));
  if (matched.length) return matched;
  // Match by industry label.
  const byIndustry = Object.entries(OSM_CATEGORY_MAP)
    .filter(([, v]) => wanted.some((w) => v.industry.toLowerCase().includes(w) || w.includes(v.industry.toLowerCase())))
    .map(([k]) => k);
  return byIndustry.length ? byIndustry : Object.keys(OSM_CATEGORY_MAP).slice(0, 6);
}

function buildScopeClause(query: DiscoveryQuery, config: Record<string, unknown>): string {
  const scope = (config.scope as string) || (query.country ? `country:${query.country}` : '');
  if (!scope) return '';
  if (scope.startsWith('bbox:')) {
    return ''; // bbox handled by the element selector
  }
  if (scope.startsWith('country:')) {
    return `area["ISO3166-1"="${scope.split(':')[1].toUpperCase()}"][admin_level=2]->.a;\n`;
  }
  if (scope.startsWith('area:')) {
    return `area["name"="${scope.split(':')[1]}"]->.a;\n`;
  }
  return '';
}

function buildSelector(query: DiscoveryQuery, config: Record<string, unknown>): string {
  const scope = (config.scope as string) || (query.country ? `country:${query.country}` : '');
  if (scope?.startsWith('bbox:')) {
    const [, box] = scope.split(':');
    return `(${box})`;
  }
  if (scope) return '(area.a)';
  if (query.locality) return `(area.a)`;
  return '';
}

function tagPick(tags: Record<string, string>, keys: string[]): string | null {
  for (const k of keys) {
    if (tags[k] && tags[k] !== 'no') return tags[k];
  }
  return null;
}

export const overpassProvider: DiscoveryProvider = {
  key: 'overpass.osm',
  label: 'OpenStreetMap (Overpass)',
  category: 'maps',
  requiresCredentials: false,
  description:
    'Live public business records from OpenStreetMap. Returns name, website, phone, email, address, opening hours and accessibility tags. Category-driven; scope optional.',
  costPerCall: 0,
  rateLimitPerMin: 10,

  async discover(orgId, query) {
    const wait = rateLimitWait('overpass.osm', 10);
    if (wait > 0) await sleep(Math.min(wait, 5000));

    const sourceConfig = await loadSourceConfig(orgId, 'overpass.osm');
    const categories = resolveCategories(query);
    const scopeClause = buildScopeClause(query, sourceConfig);
    const selector = buildSelector(query, sourceConfig);

    if (!selector) {
      return {
        records: [],
        live: true,
        note: 'This source needs a scope (country:<ISO>, area:<name> or bbox:<s,w,n,e>) in Settings → Sources. Other sources need none.',
      };
    }

    const limit = Math.min(query.limit ?? 40, 120);
    const unions = categories
      .map((c) => {
        const m = OSM_CATEGORY_MAP[c];
        return `nwr["${m.tag}"="${m.value}"]["name"]${selector};`;
      })
      .join('\n');

    const ql = `[out:json][timeout:40];\n${scopeClause}${unions}\nout center tags ${limit};`;

    const res = await httpJson<OverpassResponse>('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'AcquisitionOS/1.0 (business discovery)' },
      body: `data=${encodeURIComponent(ql)}`,
      timeoutMs: 45_000,
      retries: 1,
    });

    if (!res.ok || !res.data) {
      return { records: [], live: true, note: `Overpass unavailable: ${res.error ?? `HTTP ${res.status}`}` };
    }

    const records: DiscoveredRecord[] = [];
    for (const el of res.data.elements ?? []) {
      const tags = el.tags ?? {};
      if (!tags.name) continue;
      const catKey = categories.find((c) => OSM_CATEGORY_MAP[c].tag in tags && OSM_CATEGORY_MAP[c].value === tags[OSM_CATEGORY_MAP[c].tag]);
      const meta = catKey ? OSM_CATEGORY_MAP[catKey] : null;
      const website = tagPick(tags, ['contact:website', 'website', 'url', 'contact:url']);
      const phone = tagPick(tags, ['contact:phone', 'phone', 'contact:mobile']);
      const email = tagPick(tags, ['contact:email', 'email']);
      const social: Record<string, string> = {};
      for (const platform of ['facebook', 'instagram', 'twitter', 'youtube', 'linkedin', 'tiktok']) {
        const v = tagPick(tags, [`contact:${platform}`, platform]);
        if (v) social[platform] = v;
      }
      const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
      const osmUrl = `https://www.openstreetmap.org/${el.type}/${el.id}`;

      records.push({
        name: tags.name,
        website: website ?? null,
        phone: phone ?? null,
        email: email ?? null,
        industry: meta?.industry ?? null,
        category: tags[`${meta?.tag ?? 'shop'}`] ? undefined : (meta?.category ?? null),
        subcategory: tagPick(tags, ['cuisine', 'sport', 'brand']) ?? null,
        description: tagPick(tags, ['description', 'description:en']) ?? null,
        addressLine: street || null,
        locality: tags['addr:city'] ?? tags['addr:suburb'] ?? tags['addr:town'] ?? null,
        region: tags['addr:state'] ?? null,
        country: tags['addr:country'] ?? null,
        postalCode: tags['addr:postcode'] ?? null,
        social,
        rating: null,
        reviewCount: null,
        employeeEstimate: null,
        sourceUrl: osmUrl,
        externalId: `${el.type}/${el.id}`,
        // OSM records are crowd-sourced: high confidence on existence/name,
        // lower on completeness because absence of a website tag is not proof.
        confidence: 0.68,
      });
    }

    return {
      records,
      total: res.data.elements?.length ?? 0,
      live: true,
      note: `Queried ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'} across OpenStreetMap.`,
    };
  },

  async health() {
    const res = await httpJson('https://overpass-api.de/api/status', { timeoutMs: 8000 });
    return { ok: res.ok || res.status > 0, message: res.ok ? 'reachable' : (res.error ?? 'unreachable') };
  },
};

interface OverpassResponse {
  elements?: { type: string; id: number; tags?: Record<string, string> }[];
}

// ── 2. Credential-gated sources (real implementations) ───────
export const googlePlacesProvider: DiscoveryProvider = {
  key: 'places.google',
  label: 'Google Places API',
  category: 'maps',
  requiresCredentials: true,
  credentialLabel: 'Google Places API key',
  description: 'Text Search + Place Details. Returns names, websites, ratings, review counts, phone numbers and opening state.',
  costPerCall: 0.032,
  rateLimitPerMin: 300,

  async discover(orgId, query) {
    const key = providerCredential(orgId, 'places.google');
    if (!key) return notConfigured('places.google');

    const terms = query.categories?.length ? query.categories : query.industries?.length ? query.industries : ['local business'];
    const records: DiscoveredRecord[] = [];
    let nextCursor: string | undefined;

    for (const term of terms.slice(0, 3)) {
      const wait = rateLimitWait('places.google', 300);
      if (wait) await sleep(Math.min(wait, 2000));
      const params = qs({
        textquery: query.locality ? `${term} in ${query.locality}` : term,
        fields: 'id,displayName,websiteUri,nationalPhoneNumber,internationalPhoneNumber,formattedAddress,rating,userRatingCount,priceLevel,primaryType,googleMapsUri',
        pageSize: Math.min(query.limit ?? 20, 20),
        pageToken: query.cursor,
      });
      const res = await httpJson<{ places?: GooglePlace[]; nextPageToken?: string; error?: { message: string } }>(
        `https://places.googleapis.com/v1/places:searchText?${params}`,
        { headers: { 'x-goog-api-key': key, 'x-goog-fieldmask': 'places,nextPageToken' }, timeoutMs: 20_000 }
      );
      if (!res.ok) return { records, live: true, note: `Google Places error: ${res.data?.error?.message ?? res.error}` };
      for (const p of res.data?.places ?? []) {
        records.push({
          name: p.displayName?.text ?? '',
          website: p.websiteUri ?? null,
          phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
          industry: 'Local Services',
          category: p.primaryType ?? term,
          addressLine: p.formattedAddress ?? null,
          rating: p.rating ?? null,
          reviewCount: p.userRatingCount ?? null,
          priceLevel: p.priceLevel ?? null,
          sourceUrl: p.googleMapsUri ?? null,
          externalId: p.id ?? null,
          confidence: 0.92,
        });
      }
      nextCursor = res.data?.nextPageToken;
      if (records.length >= (query.limit ?? 20)) break;
    }

    return { records: records.filter((r) => r.name), nextCursor, live: true };
  },
};

interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  primaryType?: string;
  googleMapsUri?: string;
}

export const serpApiProvider: DiscoveryProvider = {
  key: 'serpapi.search',
  label: 'SerpApi (search engine results)',
  category: 'search',
  requiresCredentials: true,
  credentialLabel: 'SerpApi API key',
  description: 'Search-engine discovery of business sites by opportunity phrasing, e.g. "plumber near me" style queries without a location.',
  costPerCall: 0.0075,
  rateLimitPerMin: 100,

  async discover(orgId, query) {
    const key = providerCredential(orgId, 'serpapi.search');
    if (!key) return notConfigured('serpapi.search');

    const terms = query.categories?.length ? query.categories : ['local business services'];
    const records: DiscoveredRecord[] = [];
    for (const term of terms.slice(0, 3)) {
      const res = await httpJson<{ organic_results?: { title: string; link: string; snippet?: string }[] }>(
        `https://serpapi.com/search.json?${qs({ q: term, engine: 'google', num: query.limit ?? 10, api_key: key })}`,
        { timeoutMs: 20_000 }
      );
      if (!res.ok) return { records, live: true, note: `SerpApi error: ${res.error}` };
      for (const r of res.data?.organic_results ?? []) {
        if (!r.link?.startsWith('http')) continue;
        records.push({
          name: r.title.replace(/\s*[-|].*$/, '').trim(),
          website: r.link,
          description: r.snippet ?? null,
          category: term,
          sourceUrl: r.link,
          externalId: r.link,
          confidence: 0.55,
        });
      }
    }
    return { records, live: true };
  },
};

export const openCorporatesProvider: DiscoveryProvider = {
  key: 'opencorporates.company',
  label: 'OpenCorporates (public company records)',
  category: 'database',
  requiresCredentials: true,
  credentialLabel: 'OpenCorporates API token',
  description: 'Public registered-company records: legal name, incorporation date, jurisdiction, industry codes and status.',
  costPerCall: 0.01,
  rateLimitPerMin: 60,

  async discover(orgId, query) {
    const key = providerCredential(orgId, 'opencorporates.company');
    if (!key) return notConfigured('opencorporates.company');
    const term = query.industries?.[0] ?? query.categories?.[0] ?? 'services';
    const res = await httpJson<{ results?: { companies?: { company?: OpenCorpCompany }[] } }>(
      `https://api.opencorporates.com/v0.4/companies/search?${qs({
        q: term,
        jurisdiction_code: query.country?.toLowerCase(),
        per_page: query.limit ?? 20,
        api_token: key,
      })}`,
      { timeoutMs: 20_000 }
    );
    if (!res.ok) return { records: [], live: true, note: `OpenCorporates error: ${res.error}` };
    const records: DiscoveredRecord[] = (res.data?.results?.companies ?? []).map(({ company: c }) => ({
      name: c?.name ?? '',
      legalName: c?.name ?? null,
      industry: (c?.industry_codes?.[0]?.industry_code?.label as string) ?? null,
      foundedYear: c?.incorporation_date ? Number(c.incorporation_date.slice(0, 4)) || null : null,
      region: c?.jurisdiction_code?.toUpperCase() ?? null,
      country: c?.jurisdiction_code?.toUpperCase() ?? null,
      website: c?.homepage ?? null,
      isNewBusiness: c?.incorporation_date ? new Date().getFullYear() - Number(c.incorporation_date.slice(0, 4)) <= 2 : false,
      sourceUrl: c?.opencorporates_url ?? null,
      externalId: c?.company_number ?? null,
      confidence: 0.9,
    }));
    return { records: records.filter((r) => r.name), live: true };
  },
};

interface OpenCorpCompany {
  name?: string;
  incorporation_date?: string;
  jurisdiction_code?: string;
  homepage?: string;
  opencorporates_url?: string;
  company_number?: string;
  industry_codes?: { industry_code?: { label?: string } }[];
}

export const yelpProvider: DiscoveryProvider = {
  key: 'yelp.reviews',
  label: 'Yelp Fusion (reviews & ratings)',
  category: 'reviews',
  requiresCredentials: true,
  credentialLabel: 'Yelp Fusion API key',
  description: 'Business search with ratings and review counts — the reputation signal behind "strong reviews, weak website" opportunities.',
  costPerCall: 0,
  rateLimitPerMin: 500,

  async discover(orgId, query) {
    const key = providerCredential(orgId, 'yelp.reviews');
    if (!key) return notConfigured('yelp.reviews');
    const term = query.categories?.[0] ?? query.industries?.[0] ?? 'businesses';
    const res = await httpJson<{ businesses?: YelpBusiness[] }>(
      `https://api.yelp.com/v3/businesses/search?${qs({
        term,
        location: query.locality,
        limit: Math.min(query.limit ?? 20, 50),
        sort_by: 'rating',
      })}`,
      { headers: { authorization: `Bearer ${key}` }, timeoutMs: 20_000 }
    );
    if (!res.ok) return { records: [], live: true, note: `Yelp error: ${res.error}` };
    const records: DiscoveredRecord[] = (res.data?.businesses ?? []).map((b) => ({
      name: b.name,
      phone: b.display_phone ?? b.phone ?? null,
      industry: b.categories?.[0]?.title ?? null,
      category: b.categories?.[0]?.title ?? null,
      addressLine: b.location?.display_address?.join(' ') ?? null,
      locality: b.location?.city ?? null,
      region: b.location?.state ?? null,
      country: b.location?.country ?? null,
      postalCode: b.location?.zip_code ?? null,
      rating: b.rating ?? null,
      reviewCount: b.review_count ?? null,
      priceLevel: b.price ?? null,
      sourceUrl: b.url ?? null,
      externalId: b.id ?? null,
      confidence: 0.9,
    }));
    return { records, live: true };
  },
};

interface YelpBusiness {
  id?: string;
  name: string;
  url?: string;
  phone?: string;
  display_phone?: string;
  rating?: number;
  review_count?: number;
  price?: string;
  categories?: { title?: string }[];
  location?: { display_address?: string[]; city?: string; state?: string; country?: string; zip_code?: string };
}

export const csvImportProvider: DiscoveryProvider = {
  key: 'import.csv',
  label: 'CSV / spreadsheet import',
  category: 'import',
  requiresCredentials: false,
  description: 'User-supplied lists. Validated, deduplicated and attributed to the import batch. Nothing is inferred.',
  costPerCall: 0,

  async discover(orgId, query) {
    const staged = takeStagedImport(orgId);
    if (!staged.length) {
      return {
        records: [],
        live: false,
        note: 'No staged import. Upload a CSV in Prospects → Import, then run discovery to validate and deduplicate it.',
      };
    }
    return {
      records: staged,
      live: false,
      note: `${staged.length} row(s) taken from the staged import batch.`,
    };
  },
};

export const crmImportProvider: DiscoveryProvider = {
  key: 'import.crm',
  label: 'External CRM import',
  category: 'connected',
  requiresCredentials: true,
  credentialLabel: 'CRM API key (HubSpot / Salesforce / Pipedrive)',
  description: 'Pulls accounts and contacts from a connected CRM. Configure the provider in Settings → Integrations.',
  costPerCall: 0,

  async discover(orgId) {
    const key = providerCredential(orgId, 'import.crm');
    if (!key) return notConfigured('import.crm');
    return { records: [], live: true, note: 'CRM connector authenticated but no sync mapping has been configured yet.' };
  },
};

export const socialProfileProvider: DiscoveryProvider = {
  key: 'social.profiles',
  label: 'Public social profile lookup',
  category: 'social',
  requiresCredentials: true,
  credentialLabel: 'Social data provider key',
  description: 'Finds public business profiles. Used to detect the "no social presence" opportunity and to attribute profile URLs.',
  costPerCall: 0.005,

  async discover(orgId) {
    const key = providerCredential(orgId, 'social.profiles');
    if (!key) return notConfigured('social.profiles');
    return { records: [], live: true, note: 'Social lookup authenticated; awaiting a target business list.' };
  },
};

function notConfigured(key: string): DiscoveryResult {
  return {
    records: [],
    live: false,
    note: `${key} is not configured. Add credentials in Settings → Integrations to enable this source.`,
  };
}

// ── Staged imports (§53) ─────────────────────────────────────
const stagedImports = new Map<string, DiscoveredRecord[]>();

export function stageImport(orgId: string, records: DiscoveredRecord[]): void {
  const existing = stagedImports.get(orgId) ?? [];
  stagedImports.set(orgId, [...existing, ...records]);
}

export function takeStagedImport(orgId: string): DiscoveredRecord[] {
  const rows = stagedImports.get(orgId) ?? [];
  stagedImports.delete(orgId);
  return rows;
}

export function stagedImportCount(orgId: string): number {
  return (stagedImports.get(orgId) ?? []).length;
}

async function loadSourceConfig(orgId: string, providerKey: string): Promise<Record<string, unknown>> {
  const { get } = await import('@/db');
  const row = get<{ config: string }>('SELECT config FROM discovery_sources WHERE org_id = ? AND provider_key = ?', [
    orgId,
    providerKey,
  ]);
  if (!row) return {};
  try {
    return JSON.parse(row.config);
  } catch {
    return {};
  }
}

export const DISCOVERY_PROVIDERS: DiscoveryProvider[] = [
  overpassProvider,
  googlePlacesProvider,
  serpApiProvider,
  openCorporatesProvider,
  yelpProvider,
  csvImportProvider,
  crmImportProvider,
  socialProfileProvider,
];
