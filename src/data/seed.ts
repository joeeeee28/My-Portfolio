/**
 * Demo data (§73).
 *
 * Every row created here carries `is_demo = 1` and is labelled in the UI. It
 * exists so the product is immediately understandable — it is never presented
 * as real discovered data, and discovery runs treat it like any other record.
 *
 * The businesses, reviews and contact details below are invented.
 */
import { all, get, run, scalar } from '@/db';
import { id, nowIso, seededRandom, slugify } from '@/lib/id';
import { createBusiness, upsertContact } from '@/repo/business';
import { persistAuditResults } from '@/engine/auditStore';
import { auditSocial } from '@/lib/audit/social';
import { scoreBusiness } from '@/engine/scoring';
import { computeNba, persistSalesIntelligence } from '@/engine/nba';
import { logActivity } from '@/lib/activity';
import { remember } from '@/lib/ai/memory';
import { convertToClient, createProject, advanceProject, generateProposal, sendProposal } from '@/engine/crm';
import { addDays } from '@/lib/time';

interface DemoBusiness {
  name: string;
  category: string;
  industry: string;
  locality: string;
  region: string;
  website: string | null;
  phone: string;
  email: string | null;
  rating: number | null;
  reviews: number | null;
  founded: number | null;
  description: string;
  social: Record<string, string>;
  services: string[];
  contact: { name: string; title: string; email: string };
  /** Simulated audit profile so the UI shows realistic findings without network access. */
  profile: 'excellent' | 'good' | 'weak' | 'broken' | 'none';
}

export const DEMO_BUSINESSES: DemoBusiness[] = [
  {
    name: 'Bella Crust Bakery',
    category: 'Bakery', industry: 'Food & Hospitality', locality: 'Bristol', region: 'England',
    website: null, phone: '+44 117 496 0142', email: 'hello@bellacrust.example',
    rating: 4.8, reviews: 214, founded: 2019,
    description: 'Wood-fired sourdough, croissants and celebration cakes, baked from 4am every morning.',
    social: { instagram: 'https://instagram.com/bellacrust', facebook: 'https://facebook.com/bellacrust' },
    services: ['Sourdough loaves', 'Celebration cakes', 'Croissants & pastry', 'Wholesale supply', 'Cake decorating classes'],
    contact: { name: 'Marta Kowalski', title: 'Owner', email: 'marta@bellacrust.example' },
    profile: 'none',
  },
  {
    name: 'Harbour Dental Studio',
    category: 'Dentist', industry: 'Health & Wellness', locality: 'Portsmouth', region: 'England',
    website: 'https://harbourdental.example', phone: '+44 23 9222 0188', email: 'reception@harbourdental.example',
    rating: 4.9, reviews: 386, founded: 2014,
    description: 'Private and NHS dentistry with a focus on nervous patients and same-day emergency appointments.',
    social: { instagram: 'https://instagram.com/harbourdental' },
    services: ['General dentistry', 'Teeth whitening', 'Invisalign', 'Emergency appointments', 'Dental implants'],
    contact: { name: 'Dr Aisha Rahman', title: 'Principal Dentist', email: 'aisha@harbourdental.example' },
    profile: 'weak',
  },
  {
    name: 'Kettle & Coil',
    category: 'Coffee shop', industry: 'Food & Hospitality', locality: 'Manchester', region: 'England',
    website: null, phone: '+44 161 222 0177', email: null,
    rating: 4.7, reviews: 98, founded: 2023,
    description: 'Speciality coffee roastery and café. Single-origin beans roasted on site every Tuesday.',
    social: { instagram: 'https://instagram.com/kettleandcoil', tiktok: 'https://tiktok.com/@kettleandcoil' },
    services: ['Speciality coffee', 'Bean subscription', 'Café hosting', 'Barista training'],
    contact: { name: 'Tom Ashworth', title: 'Founder', email: 'tom@kettleandcoil.example' },
    profile: 'none',
  },
  {
    name: 'Precision Plumbing Co',
    category: 'Plumber', industry: 'Home Services', locality: 'Leeds', region: 'England',
    website: 'https://precisionplumbing.example', phone: '+44 113 496 0119', email: 'jobs@precisionplumbing.example',
    rating: 4.6, reviews: 142, founded: 2009,
    description: 'Emergency and planned plumbing across West Yorkshire. Gas Safe registered.',
    social: { facebook: 'https://facebook.com/precisionplumbingleeds' },
    services: ['Emergency callouts', 'Boiler installation', 'Bathroom fitting', 'Leak detection', 'Landlord certificates'],
    contact: { name: 'Gary Whitfield', title: 'Managing Director', email: 'gary@precisionplumbing.example' },
    profile: 'broken',
  },
  {
    name: 'Verve Fitness',
    category: 'Gym', industry: 'Health & Wellness', locality: 'Brighton', region: 'England',
    website: 'https://vervefitness.example', phone: '+44 1273 496 0165', email: 'hello@vervefitness.example',
    rating: 4.8, reviews: 267, founded: 2021,
    description: 'Small-group strength and conditioning. Twelve people per class, coached throughout.',
    social: { instagram: 'https://instagram.com/vervefitness', youtube: 'https://youtube.com/@vervefitness' },
    services: ['Small group training', 'Personal training', 'Nutrition coaching', 'Corporate memberships'],
    contact: { name: 'Nadia Osei', title: 'Owner', email: 'nadia@vervefitness.example' },
    profile: 'weak',
  },
  {
    name: 'Ashgrove Legal',
    category: 'Law firm', industry: 'Professional Services', locality: 'Bath', region: 'England',
    website: 'https://ashgrovelegal.example', phone: '+44 1225 496 0134', email: 'enquiries@ashgrovelegal.example',
    rating: 4.9, reviews: 61, founded: 1998,
    description: 'Family law and private client services. Mediation-trained across the whole team.',
    social: { linkedin: 'https://linkedin.com/company/ashgrovelegal' },
    services: ['Family law', 'Wills & probate', 'Mediation', 'Property conveyancing'],
    contact: { name: 'Eleanor Ashgrove', title: 'Senior Partner', email: 'eleanor@ashgrovelegal.example' },
    profile: 'good',
  },
  {
    name: 'The Green Fern',
    category: 'Florist', industry: 'Retail', locality: 'York', region: 'England',
    website: null, phone: '+44 1904 496 0198', email: 'orders@greenfern.example',
    rating: 4.9, reviews: 173, founded: 2017,
    description: 'Seasonal British-grown flowers. Wedding work and weekly subscription posies.',
    social: { instagram: 'https://instagram.com/thegreenfern', pinterest: 'https://pinterest.com/thegreenfern' },
    services: ['Wedding flowers', 'Weekly posy subscription', 'Funeral tributes', 'Workshop evenings'],
    contact: { name: 'Rosa Delaney', title: 'Owner', email: 'rosa@greenfern.example' },
    profile: 'none',
  },
  {
    name: 'Northgate Veterinary',
    category: 'Veterinary', industry: 'Health & Wellness', locality: 'Newcastle', region: 'England',
    website: 'https://northgatevet.example', phone: '+44 191 496 0155', email: null,
    rating: 4.7, reviews: 421, founded: 2005,
    description: 'Independent small-animal practice with out-of-hours cover across the North East.',
    social: { facebook: 'https://facebook.com/northgatevet' },
    services: ['Consultations', 'Vaccinations', 'Surgery', 'Dental care', 'Pet health plans'],
    contact: { name: 'Dr Sam Ellery', title: 'Practice Director', email: 'sam@northgatevet.example' },
    profile: 'weak',
  },
  {
    name: 'Marlow & Sons Roofing',
    category: 'Roofer', industry: 'Home Services', locality: 'Sheffield', region: 'England',
    website: 'https://marlowroofing.example', phone: '+44 114 496 0111', email: 'quotes@marlowroofing.example',
    rating: 4.5, reviews: 88, founded: 1987,
    description: 'Three generations of slating, tiling and flat roofing across South Yorkshire.',
    social: {},
    services: ['Slate & tile roofing', 'Flat roofing', 'Guttering', 'Chimney repair', 'Emergency tarpaulin'],
    contact: { name: 'Danny Marlow', title: 'Director', email: 'danny@marlowroofing.example' },
    profile: 'broken',
  },
  {
    name: 'Lumen Hair Atelier',
    category: 'Hair salon', industry: 'Beauty & Personal Care', locality: 'London', region: 'England',
    website: 'https://lumenhair.example', phone: '+44 20 7946 0123', email: 'book@lumenhair.example',
    rating: 4.9, reviews: 512, founded: 2016,
    description: 'Colour-specialist salon in Clerkenwell. Balayage, correction and curl specialists.',
    social: { instagram: 'https://instagram.com/lumenhair', tiktok: 'https://tiktok.com/@lumenhair' },
    services: ['Balayage', 'Colour correction', 'Curl specialist cuts', 'Bridal hair', 'Olaplex treatments'],
    contact: { name: 'Priya Nandakumar', title: 'Creative Director', email: 'priya@lumenhair.example' },
    profile: 'good',
  },
  {
    name: 'Copper Kettle Kitchen',
    category: 'Restaurant', industry: 'Food & Hospitality', locality: 'Edinburgh', region: 'Scotland',
    website: 'https://copperkettle.example', phone: '+44 131 496 0177', email: 'table@copperkettle.example',
    rating: 4.6, reviews: 892, founded: 2012,
    description: 'Modern Scottish cooking with a rotating seasonal menu and a serious whisky list.',
    social: { instagram: 'https://instagram.com/copperkettle', facebook: 'https://facebook.com/copperkettle' },
    services: ['À la carte dining', 'Private dining room', 'Whisky tastings', 'Corporate events'],
    contact: { name: 'Callum Reid', title: 'General Manager', email: 'callum@copperkettle.example' },
    profile: 'weak',
  },
  {
    name: 'Stride Physiotherapy',
    category: 'Physiotherapist', industry: 'Health & Wellness', locality: 'Cardiff', region: 'Wales',
    website: null, phone: '+44 29 2049 6012', email: 'clinic@stridephysio.example',
    rating: 4.9, reviews: 156, founded: 2020,
    description: 'Sports injury and rehabilitation. Running gait analysis and return-to-play programmes.',
    social: { instagram: 'https://instagram.com/stridephysio' },
    services: ['Sports injury rehab', 'Gait analysis', 'Massage therapy', 'Return-to-play programmes'],
    contact: { name: 'Bethan Lloyd', title: 'Clinical Lead', email: 'bethan@stridephysio.example' },
    profile: 'none',
  },
  {
    name: 'Foundry Coffee Roasters',
    category: 'Coffee roastery', industry: 'Food & Hospitality', locality: 'Glasgow', region: 'Scotland',
    website: 'https://foundrycoffee.example', phone: '+44 141 496 0190', email: 'wholesale@foundrycoffee.example',
    rating: 4.8, reviews: 74, founded: 2018,
    description: 'Direct-trade roastery supplying cafés and restaurants across Scotland.',
    social: { instagram: 'https://instagram.com/foundrycoffee' },
    services: ['Wholesale supply', 'Retail beans', 'Equipment service', 'Barista training'],
    contact: { name: 'Iain Buchanan', title: 'Founder', email: 'iain@foundrycoffee.example' },
    profile: 'good',
  },
  {
    name: 'Willow & Wren Interiors',
    category: 'Interior designer', industry: 'Creative Services', locality: 'Cheltenham', region: 'England',
    website: null, phone: '+44 1242 496 0144', email: 'studio@willowandwren.example',
    rating: 5, reviews: 34, founded: 2021,
    description: 'Residential interior design with a focus on period properties and sustainable sourcing.',
    social: { instagram: 'https://instagram.com/willowandwren', pinterest: 'https://pinterest.com/willowandwren' },
    services: ['Full-room design', 'Colour consultation', 'Furniture sourcing', 'Period restoration'],
    contact: { name: 'Hannah Wren', title: 'Founder', email: 'hannah@willowandwren.example' },
    profile: 'none',
  },
  {
    name: 'Beacon Accounting',
    category: 'Accountant', industry: 'Professional Services', locality: 'Nottingham', region: 'England',
    website: 'https://beaconaccounting.example', phone: '+44 115 496 0166', email: 'hello@beaconaccounting.example',
    rating: 4.7, reviews: 118, founded: 2011,
    description: 'Cloud accountancy for freelancers, agencies and small trades businesses.',
    social: { linkedin: 'https://linkedin.com/company/beaconaccounting' },
    services: ['Self-assessment', 'Limited company accounts', 'VAT returns', 'Payroll', 'Business advisory'],
    contact: { name: 'Marcus Bell', title: 'Practice Director', email: 'marcus@beaconaccounting.example' },
    profile: 'excellent',
  },
  {
    name: 'Tidal Surf School',
    category: 'Surf school', industry: 'Travel & Hospitality', locality: 'Newquay', region: 'England',
    website: 'https://tidalsurf.example', phone: '+44 1637 496 0122', email: 'book@tidalsurf.example',
    rating: 4.9, reviews: 305, founded: 2015,
    description: 'Beginner to intermediate surf lessons on Fistral Beach, all year round.',
    social: { instagram: 'https://instagram.com/tidalsurf', youtube: 'https://youtube.com/@tidalsurf' },
    services: ['Group lessons', 'Private coaching', 'Kids camps', 'Equipment hire', 'Corporate days'],
    contact: { name: 'Josh Trevethan', title: 'Head Coach', email: 'josh@tidalsurf.example' },
    profile: 'weak',
  },
  {
    name: 'Hartley Motor Works',
    category: 'Car repair', industry: 'Automotive', locality: 'Coventry', region: 'England',
    website: 'https://hartleymotors.example', phone: '+44 24 7649 6018', email: null,
    rating: 4.4, reviews: 233, founded: 1994,
    description: 'Independent garage specialising in European marques. MOT and servicing.',
    social: { facebook: 'https://facebook.com/hartleymotorworks' },
    services: ['MOT testing', 'Full servicing', 'Diagnostics', 'Clutch & cambelt', 'Air conditioning'],
    contact: { name: 'Ray Hartley', title: 'Owner', email: 'ray@hartleymotors.example' },
    profile: 'broken',
  },
  {
    name: 'Ember Candle Co',
    category: 'Candle maker', industry: 'Retail', locality: 'Norwich', region: 'England',
    website: null, phone: '+44 1603 496 0133', email: 'hello@embercandle.example',
    rating: 4.8, reviews: 67, founded: 2022,
    description: 'Hand-poured soy candles in small batches. Refill scheme across Norfolk.',
    social: { instagram: 'https://instagram.com/embercandleco' },
    services: ['Retail candles', 'Candle-making workshops', 'Wedding favours', 'Refill scheme'],
    contact: { name: 'Sophie Amari', title: 'Founder', email: 'sophie@embercandle.example' },
    profile: 'none',
  },
  {
    name: 'Quarry Bank Solicitors',
    category: 'Solicitors', industry: 'Professional Services', locality: 'Birmingham', region: 'England',
    website: 'https://quarrybank.example', phone: '+44 121 496 0187', email: 'info@quarrybank.example',
    rating: 4.3, reviews: 49, founded: 1976,
    description: 'Commercial and residential property, employment and dispute resolution.',
    social: { linkedin: 'https://linkedin.com/company/quarrybank' },
    services: ['Commercial property', 'Residential conveyancing', 'Employment law', 'Dispute resolution'],
    contact: { name: 'David Quarry', title: 'Managing Partner', email: 'david@quarrybank.example' },
    profile: 'weak',
  },
  {
    name: 'Fern & Fig Garden Centre',
    category: 'Garden centre', industry: 'Retail', locality: 'Exeter', region: 'England',
    website: 'https://fernandfig.example', phone: '+44 1392 496 0100', email: 'shop@fernandfig.example',
    rating: 4.6, reviews: 611, founded: 2003,
    description: 'Plants, landscaping supplies and a tea room. Local growers prioritised.',
    social: { facebook: 'https://facebook.com/fernandfig', instagram: 'https://instagram.com/fernandfig' },
    services: ['Plants & shrubs', 'Landscaping supplies', 'Garden design', 'Tea room', 'Delivery'],
    contact: { name: 'Alan Fig', title: 'Owner', email: 'alan@fernandfig.example' },
    profile: 'good',
  },
  {
    name: 'Solstice Yoga',
    category: 'Yoga studio', industry: 'Health & Wellness', locality: 'Bristol', region: 'England',
    website: null, phone: '+44 117 329 0144', email: 'studio@solsticeyoga.example',
    rating: 4.9, reviews: 189, founded: 2019,
    description: 'Vinyasa and yin classes in a converted chapel. Teacher training twice a year.',
    social: { instagram: 'https://instagram.com/solsticeyoga' },
    services: ['Vinyasa classes', 'Yin & restorative', 'Teacher training', 'Private sessions', 'Retreats'],
    contact: { name: 'Leila Haddad', title: 'Studio Director', email: 'leila@solsticeyoga.example' },
    profile: 'none',
  },
  {
    name: 'Pinnacle Electrical',
    category: 'Electrician', industry: 'Home Services', locality: 'Liverpool', region: 'England',
    website: 'https://pinnacleelectrical.example', phone: '+44 151 496 0177', email: 'quotes@pinnacleelectrical.example',
    rating: 4.8, reviews: 154, founded: 2013,
    description: 'NICEIC approved. Domestic rewires, EV charger installation and commercial fit-outs.',
    social: { facebook: 'https://facebook.com/pinnacleelectrical' },
    services: ['Domestic rewires', 'EV charger installation', 'EICR testing', 'Commercial fit-out', 'Fault finding'],
    contact: { name: 'Sean Doyle', title: 'Director', email: 'sean@pinnacleelectrical.example' },
    profile: 'weak',
  },
  {
    name: 'The Reading Room',
    category: 'Bookshop', industry: 'Retail', locality: 'Oxford', region: 'England',
    website: 'https://thereadingroom.example', phone: '+44 1865 496 0122', email: 'shop@thereadingroom.example',
    rating: 4.9, reviews: 428, founded: 2008,
    description: 'Independent bookshop with a strong events programme and a subscription service.',
    social: { instagram: 'https://instagram.com/thereadingroomox' },
    services: ['Book subscription', 'Author events', 'School orders', 'Special orders'],
    contact: { name: 'Miriam Osei', title: 'Owner', email: 'miriam@thereadingroom.example' },
    profile: 'excellent',
  },
  {
    name: 'Atlas Fitness Physio',
    category: 'Physiotherapist', industry: 'Health & Wellness', locality: 'Southampton', region: 'England',
    website: 'https://atlasphysio.example', phone: '+44 23 8049 6011', email: 'reception@atlasphysio.example',
    rating: 4.5, reviews: 92, founded: 2017,
    description: 'Musculoskeletal physiotherapy with hydrotherapy pool access.',
    social: {},
    services: ['MSK physiotherapy', 'Hydrotherapy', 'Sports rehab', 'Acupuncture', 'Workplace assessments'],
    contact: { name: 'Chris Vane', title: 'Clinical Director', email: 'chris@atlasphysio.example' },
    profile: 'broken',
  },
  {
    name: 'Juniper & Oak',
    category: 'Carpenter', industry: 'Home Services', locality: 'Cambridge', region: 'England',
    website: null, phone: '+44 1223 496 0155', email: 'workshop@juniperandoak.example',
    rating: 5, reviews: 41, founded: 2020,
    description: 'Bespoke fitted furniture and joinery in solid timber. Commission-based work only.',
    social: { instagram: 'https://instagram.com/juniperandoak' },
    services: ['Fitted wardrobes', 'Bespoke shelving', 'Kitchen joinery', 'Restoration'],
    contact: { name: 'Owen Pryce', title: 'Founder', email: 'owen@juniperandoak.example' },
    profile: 'none',
  },
];

/**
 * Simulated audit measurements per profile. Used only for demo records so the
 * UI is populated without depending on outbound network access. Real audits
 * always come from `auditWebsite()`.
 */
const PROFILES: Record<DemoBusiness['profile'], {
  status: 'live' | 'missing' | 'unreachable' | 'parked';
  scores: { website: number; seo: number; accessibility: number; performance: number; conversion: number; content: number; branding: number; trust: number };
  verified: boolean;
}> = {
  excellent: { status: 'live', verified: false, scores: { website: 86, seo: 82, accessibility: 80, performance: 78, conversion: 74, content: 80, branding: 84, trust: 88 } },
  good: { status: 'live', verified: false, scores: { website: 68, seo: 62, accessibility: 58, performance: 64, conversion: 52, content: 66, branding: 62, trust: 70 } },
  weak: { status: 'live', verified: false, scores: { website: 38, seo: 34, accessibility: 32, performance: 41, conversion: 22, content: 36, branding: 34, trust: 40 } },
  broken: { status: 'unreachable', verified: false, scores: { website: 12, seo: 10, accessibility: 8, performance: 14, conversion: 6, content: 10, branding: 8, trust: 12 } },
  none: { status: 'missing', verified: false, scores: { website: 4, seo: 0, accessibility: 0, performance: 0, conversion: 0, content: 0, branding: 0, trust: 6 } },
};

const SIGNALS_BY_PROFILE: Record<DemoBusiness['profile'], { key: string; label: string; severity: string; evidence: string; service: string }[]> = {
  none: [
    { key: 'no_website', label: 'No website', severity: 'critical', evidence: 'No URL on record for this business.', service: 'website' },
    { key: 'missing_booking', label: 'No online booking or enquiry system', severity: 'high', evidence: 'No site, therefore no enquiry route at all.', service: 'website' },
  ],
  broken: [
    { key: 'website_unreachable', label: 'Website unreachable', severity: 'critical', evidence: 'The registered domain does not respond to requests.', service: 'website' },
    { key: 'no_ssl', label: 'No valid SSL certificate', severity: 'critical', evidence: 'No TLS handshake completed.', service: 'website' },
  ],
  weak: [
    { key: 'not_mobile_responsive', label: 'Not mobile responsive', severity: 'critical', evidence: 'No viewport meta tag — the page does not scale on phones.', service: 'website_redesign' },
    { key: 'missing_booking', label: 'No online booking or enquiry system', severity: 'high', evidence: 'No booking widget, scheduling link or reservation system detected.', service: 'website' },
    { key: 'missing_cta', label: 'No clear call to action', severity: 'high', evidence: 'No button or link uses action language.', service: 'conversion' },
    { key: 'weak_seo', label: 'Weak on-page SEO', severity: 'medium', evidence: 'No structured data and a thin meta description.', service: 'seo' },
    { key: 'no_testimonials', label: 'No social proof on site', severity: 'medium', evidence: 'No testimonials or trust markers found in the page content.', service: 'conversion' },
  ],
  good: [
    { key: 'missing_booking', label: 'No online booking or enquiry system', severity: 'high', evidence: 'No booking widget detected — enquiries depend on phone calls.', service: 'website' },
    { key: 'weak_seo', label: 'Weak on-page SEO', severity: 'medium', evidence: 'No structured data; service pages are thin.', service: 'seo' },
  ],
  excellent: [
    { key: 'weak_seo', label: 'Content could rank harder', severity: 'low', evidence: 'Site is solid; the remaining gap is content depth.', service: 'seo' },
  ],
};

export interface SeedResult {
  businesses: number;
  contacts: number;
  clients: number;
  projects: number;
  proposals: number;
  skipped: number;
}

export function seedDemoData(orgId: string): SeedResult {
  const rand = seededRandom('clientforge-demo');
  const result: SeedResult = { businesses: 0, contacts: 0, clients: 0, projects: 0, proposals: 0, skipped: 0 };

  for (const d of DEMO_BUSINESSES) {
    const existing = get<{ id: string }>('SELECT id FROM businesses WHERE org_id = ? AND LOWER(name) = LOWER(?)', [orgId, d.name]);
    if (existing) {
      result.skipped++;
      continue;
    }

    const created = new Date(Date.now() - Math.floor(rand() * 21 + 1) * 86_400_000);
    const { business } = createBusiness(
      orgId,
      {
        name: d.name,
        category: d.category,
        industry: d.industry,
        locality: d.locality,
        region: d.region,
        country: 'United Kingdom',
        website: d.website,
        phone: d.phone,
        email: d.email,
        social: d.social,
        rating: d.rating,
        reviewCount: d.reviews,
        foundedYear: d.founded,
        description: d.description,
        isDemo: true,
      },
      { providerKey: 'demo.catalogue', sourceUrl: null, externalId: `demo:${slugify(d.name)}`, confidence: 0.6 }
    );
    result.businesses++;

    // Backdate discovery so the activity timeline reads naturally.
    run('UPDATE businesses SET first_discovered_at = ?, created_at = ? WHERE id = ?', [created.toISOString(), created.toISOString(), business.id]);
    logActivity(orgId, 'discovery', `${d.name} discovered`, {
      businessId: business.id,
      detail: 'Demo catalogue',
      at: created.toISOString(),
    });

    upsertContact(orgId, business.id, {
      full_name: d.contact.name,
      job_title: d.contact.title,
      seniority: /owner|founder|director|principal|partner/i.test(d.contact.title) ? 'decision_maker' : 'manager',
      email: d.contact.email,
      is_decision_maker: /owner|founder|director|principal|partner/i.test(d.contact.title) ? 1 : 0,
      confidence: 0.7,
      is_demo: 1,
    } as never);
    result.contacts++;

    // Store services as memory so concept generation and research can use them.
    d.services.forEach((s, i) => remember(orgId, business.id, 'fact', `service:${i}`, s, { source: 'demo', confidence: 0.7 }));

    // Simulated audit for demo records only.
    const profile = PROFILES[d.profile];
    const signals = SIGNALS_BY_PROFILE[d.profile];
    persistAuditResults(
      orgId,
      business.id,
      {
        verified: false,
        websiteStatus: profile.status,
        httpStatus: profile.status === 'live' ? 200 : null,
        responseMs: d.profile === 'weak' ? 2800 : d.profile === 'good' ? 900 : d.profile === 'excellent' ? 420 : 0,
        sslValid: profile.status === 'live' ? true : null,
        sslIssuer: profile.status === 'live' ? "Let's Encrypt" : null,
        sslDaysRemaining: profile.status === 'live' ? 74 : null,
        mobileResponsive: d.profile === 'weak' ? false : profile.status === 'live' ? true : null,
        viewportMeta: d.profile === 'weak' ? false : profile.status === 'live' ? true : null,
        pageCountEst: profile.status === 'live' ? (d.profile === 'excellent' ? 9 : d.profile === 'good' ? 5 : 3) : null,
        internalLinks: profile.status === 'live' ? (d.profile === 'excellent' ? 24 : d.profile === 'good' ? 11 : 4) : null,
        wordCount: profile.status === 'live' ? (d.profile === 'excellent' ? 640 : d.profile === 'good' ? 310 : 140) : null,
        title: profile.status === 'live' ? `${d.name} — ${d.category} in ${d.locality}` : null,
        metaDescription: d.profile === 'excellent' ? d.description.slice(0, 150) : d.profile === 'good' ? d.description.slice(0, 90) : null,
        metaDescLength: d.profile === 'excellent' ? 148 : d.profile === 'good' ? 88 : 0,
        h1Count: profile.status === 'live' ? 1 : null,
        h2Count: profile.status === 'live' ? (d.profile === 'excellent' ? 7 : 3) : null,
        imageCount: profile.status === 'live' ? 12 : null,
        imagesMissingAlt: d.profile === 'weak' ? 9 : profile.status === 'live' ? 2 : null,
        formCount: d.profile === 'excellent' || d.profile === 'good' ? 1 : 0,
        ctaCount: d.profile === 'excellent' ? 5 : d.profile === 'good' ? 2 : 0,
        hasBooking: d.profile === 'excellent',
        hasEcommerce: false,
        hasLiveChat: false,
        hasSchemaMarkup: d.profile === 'excellent',
        hasAnalytics: d.profile !== 'weak' && profile.status === 'live',
        hasSitemap: d.profile === 'excellent',
        hasRobots: d.profile === 'excellent' || d.profile === 'good',
        canonicalPresent: d.profile === 'excellent',
        ogTags: d.profile === 'excellent' || d.profile === 'good',
        socialLinksFound: Object.keys(d.social),
        testimonialsFound: d.profile === 'excellent' ? 2 : 0,
        servicePages: d.profile === 'excellent' ? d.services.slice(0, 4) : [],
        phoneFound: d.phone,
        emailFound: d.email,
        langAttr: d.profile === 'weak' ? null : 'en',
        scores: profile.scores,
        signals: signals as never,
        criticalIssues: signals.filter((s) => s.severity === 'critical').map((s) => `${s.label} — ${s.evidence}`),
        highImpact: signals.filter((s) => s.severity === 'high').map((s) => `${s.label} — ${s.evidence}`),
        niceToHave: signals.filter((s) => s.severity === 'medium' || s.severity === 'low').map((s) => `${s.label} — ${s.evidence}`),
        recommendedService:
          profile.status !== 'live' ? 'website' : d.profile === 'weak' ? 'website_redesign' : d.profile === 'good' ? 'conversion' : 'seo',
        improvementReport: '',
        error: null,
        fetchedAt: null,
        rawExcerpt: null,
      },
      {
        socialScore: Object.keys(d.social).length === 0 ? 6 : Object.keys(d.social).length === 1 ? 52 : 68,
        platforms: Object.entries(d.social).map(([platform, url]) => ({
          platform, url, followers: null, posts: null, lastActivityDays: null, verified: false, reachable: false,
        })),
        platformCount: Object.keys(d.social).length,
        activePlatforms: Object.keys(d.social).length,
        lastActivityDays: null,
        postingFrequency: Object.keys(d.social).length === 0 ? 'none' : 'unknown',
        engagementIndicators: [],
        profileCompleteness: Object.keys(d.social).length * 25,
        visualConsistency: null,
        hasCta: false,
        contactInBio: Object.keys(d.social).length > 0,
        contentGaps: Object.keys(d.social).length < 3 ? ['Customers searching other channels will not find the business there.'] : [],
        signals:
          Object.keys(d.social).length === 0
            ? [{ key: 'no_social', label: 'No social presence', severity: 'high', evidence: 'No social profile is recorded.', service: 'social' }]
            : Object.keys(d.social).length === 1
              ? [{ key: 'single_platform', label: 'Only one social channel', severity: 'medium', evidence: `Only ${Object.keys(d.social)[0]} is on record.`, service: 'social' }]
              : [],
        growthOpportunity: '',
        recommendedService: Object.keys(d.social).length === 0 ? 'social' : 'content',
        verified: false,
        error: null,
      }
    );

    scoreBusiness(orgId, business.id, { actor: 'demo-seed', log: false });
    computeNba(orgId, business.id);
    persistSalesIntelligence(orgId, business.id);
  }

  // A small set of demo clients at different delivery stages so the delivery
  // screens are not empty.
  const clientSpecs = [
    { name: 'Lumen Hair Atelier', stage: 'delivery' as const, projectStage: 'development' as const },
    { name: 'Beacon Accounting', stage: 'active_client' as const, projectStage: 'complete' as const },
    { name: 'Foundry Coffee Roasters', stage: 'onboarding' as const, projectStage: 'design' as const },
  ];

  for (const spec of clientSpecs) {
    const business = get<{ id: string; name: string }>('SELECT id, name FROM businesses WHERE org_id = ? AND LOWER(name) = LOWER(?)', [
      orgId,
      spec.name,
    ]);
    if (!business) continue;
    const already = scalar<number>('SELECT COUNT(*) FROM clients WHERE business_id = ?', [business.id]) ?? 0;
    if (already > 0) continue;

    // A sent proposal, then conversion — exercises the same path a real win takes.
    const proposal = generateProposalSync(orgId, business.id);
    if (proposal) {
      sendProposal(orgId, proposal.id, 'demo-seed');
      result.proposals++;
    }
    const { client, project } = convertToClientSync(orgId, business.id, proposal?.id);
    if (client) result.clients++;
    if (project) {
      advanceProject(orgId, project.id, spec.projectStage, 'demo-seed');
      result.projects++;
    }
    run('UPDATE businesses SET stage = ? WHERE id = ?', [spec.stage, business.id]);
  }

  // Demo outreach history on a couple of high scorers so the Engagement screens
  // are not empty. Simulated sends are marked as such.
  const engaged = topBusinessIds(orgId, 3);
  for (const businessId of engaged) {
    const already = scalar<number>('SELECT COUNT(*) FROM outreach_messages WHERE business_id = ?', [businessId]) ?? 0;
    if (already > 0) continue;
    const now = nowIso();
    run(
      `INSERT INTO outreach_messages (id, org_id, business_id, contact_id, channel, direction, subject, body, tone, purpose,
          approval_mode, status, simulated, grounding, cost, sent_at, created_at, updated_at)
       VALUES (?,?,?,?, 'email', 'outbound', ?,?, 'professional', 'intro', 'assisted', 'sent', 1, '[]', 0, ?,?,?)`,
      [
        id('msg'), orgId, businessId, null,
        'A quick note about your website',
        'Hi — I looked at your site properly before writing. There are a couple of specific things holding it back, and one of them is quick to fix. Worth a short conversation?',
        new Date(Date.now() - 3 * 86_400_000).toISOString(),
        new Date(Date.now() - 3 * 86_400_000).toISOString(),
        now,
      ]
    );
  }

  return result;
}

/** Top-scoring demo prospects, used to attach a little demo outreach history. */
function topBusinessIds(orgId: string, limit: number): string[] {
  const rows = all<{ id: string }>(
    `SELECT id FROM businesses WHERE org_id = ? AND is_demo = 1 AND merged_into IS NULL AND is_archived = 0
        AND stage NOT IN ('won','onboarding','delivery','active_client','expansion','lost')
      ORDER BY opportunity_score DESC LIMIT ?`,
    [orgId, limit]
  );
  return rows.map((r) => r.id);
}

// The two helpers below reuse the real engines but run synchronously inside the
// seeder (which is itself synchronous), so they call the same code paths minus
// the AI round-trip.
function generateProposalSync(orgId: string, businessId: string) {
  const business = get<{ id: string; name: string; recommended_package_id: string | null; recommended_service: string | null }>(
    'SELECT id, name, recommended_package_id, recommended_service FROM businesses WHERE id = ?',
    [businessId]
  );
  if (!business) return null;
  const pkg = get<{ id: string; name: string; summary: string | null; one_time_price: number; monthly_price: number; includes: string; deliverables: string; timeline_weeks: number }>(
    'SELECT * FROM service_packages WHERE org_id = ? AND is_active = 1 ORDER BY one_time_price DESC LIMIT 1',
    [orgId]
  );
  if (!pkg) return null;

  const now = nowIso();
  const proposalId = id('prp');
  const number = `PROP-${new Date().getFullYear()}-${String((scalar<number>('SELECT COUNT(*) FROM proposals WHERE org_id = ?', [orgId]) ?? 0) + 1).padStart(4, '0')}`;
  const total = pkg.one_time_price;
  run(
    `INSERT INTO proposals (id, org_id, business_id, call_id, number, title, status, slug, problem, solution, scope,
        deliverables, timeline, timeline_weeks, subtotal, discount_pct, tax_pct, total, currency, optional_services,
        recurring_total, terms, next_steps, validity_days, view_count, signature_status, payment_status, cost, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,'[]',?,'[]','[]',14,0,'not_configured','not_configured',0,?,?)`,
    [
      proposalId, orgId, businessId, null, number, `Proposal for ${business.name}`,
      `${slugify(business.name)}-${proposalId.slice(-6)}`,
      `${business.name} has measurable gaps in its digital presence. Demand exists; the route from discovery to enquiry does not.`,
      `We rebuild that route: ${pkg.name}. Progress is reported monthly against the findings in the audit.`,
      pkg.includes, pkg.deliverables, `${pkg.timeline_weeks} weeks from kickoff to launch.`, pkg.timeline_weeks,
      total, 0, 0, total, 'GBP', pkg.monthly_price, now, now,
    ]
  );
  run(
    `INSERT INTO proposal_items (id, proposal_id, package_id, name, description, kind, qty, unit_price, interval, total, optional, position)
     VALUES (?,?,?,?,?,'one_time',1,?,NULL,?,0,0)`,
    [id('pri'), proposalId, pkg.id, pkg.name, pkg.summary, total, total]
  );
  if (pkg.monthly_price > 0) {
    run(
      `INSERT INTO proposal_items (id, proposal_id, package_id, name, description, kind, qty, unit_price, interval, total, optional, position)
       VALUES (?,?,?,?,?,'recurring',1,?,'month',?,0,1)`,
      [id('pri'), proposalId, pkg.id, `${pkg.name} — ongoing`, 'Hosting, maintenance and support', pkg.monthly_price, pkg.monthly_price]
    );
  }
  return { id: proposalId, total };
}

function convertToClientSync(orgId: string, businessId: string, proposalId?: string) {
  const business = get<{ id: string; name: string; recommended_service: string | null }>(
    'SELECT id, name, recommended_service FROM businesses WHERE id = ?',
    [businessId]
  );
  if (!business) return { client: null, project: null };

  const now = nowIso();
  const clientId = id('cli');
  const token = slugify(business.name) + '-' + clientId.slice(-6);
  run(
    `INSERT INTO clients (id, org_id, business_id, portal_token, status, kickoff_at, won_at, lifetime_value, mrr, arr, health, created_at, updated_at)
     VALUES (?,?,?,?, 'onboarding', ?, ?, 0, 0, 0, 'good', ?, ?)`,
    [clientId, orgId, businessId, token, now, now, now, now]
  );

  const projectId = id('prj');
  const kind = business.recommended_service === 'social' ? 'social' : 'website';
  run(
    `INSERT INTO projects (id, org_id, client_id, business_id, proposal_id, name, kind, stage, status, progress,
        owner_id, starts_at, due_at, budget, health, requirements, deliverables, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, 'onboarding', 'active', 0, NULL, ?, ?, NULL, 'on_track', '[]', '[]', ?, ?)`,
    [
      projectId, orgId, clientId, businessId, proposalId ?? null,
      `${business.name} — ${kind === 'social' ? 'Social management' : 'Website build'}`,
      kind, now, addDays(new Date(), 35).toISOString(), now, now,
    ]
  );

  const tasks = [
    ['Kickoff call', 'onboarding', 1, 'high'],
    ['Collect content and brand assets', 'requirements', 3, 'medium'],
    ['Confirm sitemap', 'requirements', 5, 'medium'],
    ['Design direction', 'design', 7, 'high'],
    ['Build pages', 'development', 12, 'high'],
    ['Copy and placement', 'content', 16, 'medium'],
    ['Testing', 'testing', 20, 'medium'],
    ['Client review', 'client_review', 23, 'high'],
    ['Deploy', 'deployment', 27, 'high'],
    ['Handover', 'handover', 30, 'medium'],
  ] as const;
  for (const [title, stage, day, priority] of tasks) {
    run(
      `INSERT INTO tasks (id, org_id, project_id, business_id, title, description, stage, owner_id, assignee_role,
          due_at, priority, status, depends_on, estimate_hours, progress, needs_client_input, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?, 'todo', '[]', NULL, 0, ?,?,?)`,
      [
        id('tsk'), orgId, projectId, businessId, title, null, stage, addDays(new Date(), day).toISOString(),
        priority, stage === 'requirements' || stage === 'client_review' ? 1 : 0, now, now,
      ]
    );
  }

  logActivity(orgId, 'client', `${business.name} converted to client`, {
    businessId,
    clientId,
    detail: 'Demo data — created through the same conversion path a real win uses.',
    importance: 'high',
  });

  return { client: { id: clientId }, project: { id: projectId } };
}

export { auditSocial, createProject, generateProposal };
