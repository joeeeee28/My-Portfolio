/**
 * Website model + renderer (§20, §21, §22).
 *
 * Two layers:
 *  1. A structured site model (theme + ordered sections + copy) derived from
 *     the business's real data and a deterministic design direction.
 *  2. A renderer that turns the model into a single self-contained HTML page.
 *
 * Uniqueness is structural, not cosmetic: the design direction changes the
 * typographic scale, spacing rhythm, corner treatment, hero construction,
 * section order and button language — so two bakeries do not get the same site.
 *
 * Grounding rule: copy is assembled only from facts on record. Where a fact is
 * missing the section is either omitted or carries a visible `[Add …]` marker
 * that the client must fill — the generator never invents a review, a price,
 * a year founded or a client name.
 */
import { seededRandom, slugify } from '@/lib/id';
import { inlineArtwork, logoMark } from '@/lib/artwork';

export type DesignDirection =
  | 'editorial'
  | 'minimal'
  | 'bold'
  | 'luxe'
  | 'technical'
  | 'warm'
  | 'clinical'
  | 'artisan';

export interface Theme {
  direction: DesignDirection;
  label: string;
  palette: {
    ink: string;
    paper: string;
    surface: string;
    accent: string;
    accentInk: string;
    muted: string;
    line: string;
  };
  fonts: { display: string; body: string; stackDisplay: string; stackBody: string };
  radius: string;
  buttonRadius: string;
  shadow: string;
  scale: { hero: string; h2: string; h3: string; body: string; small: string };
  spacing: { section: string; gap: string };
  rules: string;
  uppercaseNav: boolean;
  letterSpacing: string;
}

export type SectionType =
  | 'hero'
  | 'trustbar'
  | 'services'
  | 'about'
  | 'process'
  | 'gallery'
  | 'testimonials'
  | 'booking'
  | 'faq'
  | 'contact'
  | 'cta'
  | 'footer';

export interface Section {
  type: SectionType;
  id: string;
  title?: string;
  subtitle?: string;
  body?: string;
  items?: { title: string; body?: string; meta?: string; needsReview?: boolean }[];
  cta?: { label: string; href: string };
  needsReview?: boolean;
  note?: string;
}

export interface SiteModel {
  businessName: string;
  tagline: string | null;
  theme: Theme;
  layout: string;
  sections: Section[];
  logo: string;
  palette: string[];
  contact: { phone?: string | null; email?: string | null; address?: string | null };
  social: Record<string, string>;
  rating: { value: number; count: number } | null;
  seed: string;
  generationNotes: string[];
}

// ── Palettes ─────────────────────────────────────────────────
interface PaletteDef {
  name: string;
  industries: string[];
  colors: { ink: string; paper: string; surface: string; accent: string; accentInk: string }[];
}

const PALETTES: PaletteDef[] = [
  {
    name: 'bakery',
    industries: ['bakery', 'café', 'cafe', 'coffee', 'patisserie', 'food & hospitality'],
    colors: [
      { ink: '#2a1f17', paper: '#fdf8f2', surface: '#f6ece0', accent: '#b5651d', accentInk: '#fff8ef' },
      { ink: '#241a15', paper: '#fbf5ee', surface: '#f0e3d3', accent: '#8c4a2f', accentInk: '#fff6ee' },
      { ink: '#1f1a16', paper: '#fcf7f0', surface: '#eee2d4', accent: '#c07b28', accentInk: '#2a1f17' },
    ],
  },
  {
    name: 'clinical',
    industries: ['dentist', 'clinic', 'health', 'medical', 'physio', 'veterinary', 'pharmacy', 'health & wellness'],
    colors: [
      { ink: '#0f2434', paper: '#f7fbfd', surface: '#e8f2f7', accent: '#1b7a9c', accentInk: '#ffffff' },
      { ink: '#12232e', paper: '#f6fafb', surface: '#e6eff2', accent: '#2f7d6e', accentInk: '#ffffff' },
      { ink: '#141f2b', paper: '#f8fafc', surface: '#eaeff4', accent: '#3d6fb4', accentInk: '#ffffff' },
    ],
  },
  {
    name: 'trades',
    industries: ['plumber', 'electrician', 'home services', 'builder', 'roofing', 'hvac', 'carpenter'],
    colors: [
      { ink: '#141a20', paper: '#f8f9fa', surface: '#eceff2', accent: '#e0561f', accentInk: '#ffffff' },
      { ink: '#10161c', paper: '#f7f8f9', surface: '#e9edf1', accent: '#0f6fb8', accentInk: '#ffffff' },
      { ink: '#161b1f', paper: '#f9f9f7', surface: '#ebece8', accent: '#c8a415', accentInk: '#161b1f' },
    ],
  },
  {
    name: 'professional',
    industries: ['lawyer', 'law firm', 'accountant', 'financial', 'consulting', 'professional services', 'real estate'],
    colors: [
      { ink: '#11151c', paper: '#fbfbfa', surface: '#f0f1ef', accent: '#1f3a5f', accentInk: '#ffffff' },
      { ink: '#0f1216', paper: '#fafaf8', surface: '#eeeeea', accent: '#5a4a2f', accentInk: '#ffffff' },
      { ink: '#131720', paper: '#f9fafb', surface: '#eceef2', accent: '#2b3f6b', accentInk: '#ffffff' },
    ],
  },
  {
    name: 'beauty',
    industries: ['beauty', 'salon', 'hair', 'spa', 'barber', 'beauty & personal care'],
    colors: [
      { ink: '#241a1e', paper: '#fdf7f8', surface: '#f6e9ec', accent: '#a8556d', accentInk: '#fff8fa' },
      { ink: '#1d1a20', paper: '#faf8fc', surface: '#eee9f3', accent: '#6b4f8a', accentInk: '#ffffff' },
      { ink: '#221b18', paper: '#fdf8f5', surface: '#f3e8e0', accent: '#b07a4f', accentInk: '#ffffff' },
    ],
  },
  {
    name: 'retail',
    industries: ['retail', 'boutique', 'shop', 'store', 'furniture', 'florist'],
    colors: [
      { ink: '#161312', paper: '#fcfbf9', surface: '#f1efeb', accent: '#2f6b4f', accentInk: '#ffffff' },
      { ink: '#191417', paper: '#fbfaf9', surface: '#efece9', accent: '#8a3b3b', accentInk: '#ffffff' },
      { ink: '#14161a', paper: '#fafafa', surface: '#ededee', accent: '#3a5a8c', accentInk: '#ffffff' },
    ],
  },
  {
    name: 'hospitality',
    industries: ['hotel', 'guest house', 'restaurant', 'bar', 'travel & hospitality'],
    colors: [
      { ink: '#1a1512', paper: '#fdfaf6', surface: '#f2ece2', accent: '#7a5c3e', accentInk: '#fffaf3' },
      { ink: '#12161a', paper: '#f9fafb', surface: '#eaeef1', accent: '#2d5f5a', accentInk: '#ffffff' },
      { ink: '#191319', paper: '#fbf9fb', surface: '#efe9ef', accent: '#6d3f5c', accentInk: '#ffffff' },
    ],
  },
  {
    name: 'neutral',
    industries: [],
    colors: [
      { ink: '#14161a', paper: '#fafafa', surface: '#ededee', accent: '#3f4a5c', accentInk: '#ffffff' },
      { ink: '#17140f', paper: '#fbfaf7', surface: '#efeee9', accent: '#5d5340', accentInk: '#ffffff' },
      { ink: '#101418', paper: '#f9fbfb', surface: '#e8eef0', accent: '#2b6270', accentInk: '#ffffff' },
    ],
  },
];

const DIRECTIONS: { key: DesignDirection; label: string; industries: string[] }[] = [
  { key: 'editorial', label: 'Editorial', industries: ['restaurant', 'boutique', 'hotel', 'florist', 'photographer'] },
  { key: 'minimal', label: 'Minimal', industries: ['accountant', 'consulting', 'architect', 'designer'] },
  { key: 'bold', label: 'Bold', industries: ['gym', 'bar', 'retail', 'barber', 'cafe'] },
  { key: 'luxe', label: 'Refined', industries: ['law firm', 'hotel', 'spa', 'jeweller', 'real estate'] },
  { key: 'technical', label: 'Technical', industries: ['electrician', 'hvac', 'it', 'engineering', 'developer'] },
  { key: 'warm', label: 'Warm', industries: ['bakery', 'cafe', 'childcare', 'pet', 'florist'] },
  { key: 'clinical', label: 'Clinical', industries: ['dentist', 'clinic', 'physio', 'medical', 'veterinary'] },
  { key: 'artisan', label: 'Artisan', industries: ['bakery', 'tailor', 'carpenter', 'brewery', 'craft'] },
];

const FONT_SETS: Record<DesignDirection, { display: string; body: string; stackDisplay: string; stackBody: string }[]> = {
  editorial: [
    { display: 'Fraunces', body: 'Inter', stackDisplay: '"Fraunces", Georgia, "Times New Roman", serif', stackBody: '"Inter", -apple-system, "Segoe UI", sans-serif' },
    { display: 'Playfair Display', body: 'Source Sans 3', stackDisplay: '"Playfair Display", Georgia, serif', stackBody: '"Source Sans 3", -apple-system, sans-serif' },
  ],
  minimal: [
    { display: 'Inter', body: 'Inter', stackDisplay: '"Inter", -apple-system, sans-serif', stackBody: '"Inter", -apple-system, sans-serif' },
    { display: 'Work Sans', body: 'Work Sans', stackDisplay: '"Work Sans", -apple-system, sans-serif', stackBody: '"Work Sans", -apple-system, sans-serif' },
  ],
  bold: [
    { display: 'Archivo', body: 'Inter', stackDisplay: '"Archivo", -apple-system, sans-serif', stackBody: '"Inter", -apple-system, sans-serif' },
    { display: 'Space Grotesk', body: 'Inter', stackDisplay: '"Space Grotesk", -apple-system, sans-serif', stackBody: '"Inter", -apple-system, sans-serif' },
  ],
  luxe: [
    { display: 'Cormorant Garamond', body: 'Jost', stackDisplay: '"Cormorant Garamond", Georgia, serif', stackBody: '"Jost", -apple-system, sans-serif' },
    { display: 'Marcellus', body: 'Jost', stackDisplay: '"Marcellus", Georgia, serif', stackBody: '"Jost", -apple-system, sans-serif' },
  ],
  technical: [
    { display: 'Space Grotesk', body: 'IBM Plex Sans', stackDisplay: '"Space Grotesk", -apple-system, sans-serif', stackBody: '"IBM Plex Sans", -apple-system, sans-serif' },
    { display: 'JetBrains Mono', body: 'IBM Plex Sans', stackDisplay: '"JetBrains Mono", ui-monospace, monospace', stackBody: '"IBM Plex Sans", -apple-system, sans-serif' },
  ],
  warm: [
    { display: 'Nunito', body: 'Karla', stackDisplay: '"Nunito", -apple-system, sans-serif', stackBody: '"Karla", -apple-system, sans-serif' },
    { display: 'Quicksand', body: 'Nunito Sans', stackDisplay: '"Quicksand", -apple-system, sans-serif', stackBody: '"Nunito Sans", -apple-system, sans-serif' },
  ],
  clinical: [
    { display: 'Manrope', body: 'Inter', stackDisplay: '"Manrope", -apple-system, sans-serif', stackBody: '"Inter", -apple-system, sans-serif' },
    { display: 'Public Sans', body: 'Public Sans', stackDisplay: '"Public Sans", -apple-system, sans-serif', stackBody: '"Public Sans", -apple-system, sans-serif' },
  ],
  artisan: [
    { display: 'Libre Baskerville', body: 'Karla', stackDisplay: '"Libre Baskerville", Georgia, serif', stackBody: '"Karla", -apple-system, sans-serif' },
    { display: 'Bitter', body: 'Karla', stackBody: '"Karla", -apple-system, sans-serif', stack: '', stackDisplay: '"Bitter", Georgia, serif' } as never,
  ],
};

// ── Theme construction ───────────────────────────────────────
export function buildTheme(seed: string, opts: { category?: string | null; industry?: string | null; direction?: DesignDirection; palette?: string[] } = {}): Theme {
  const rand = seededRandom(seed);
  const haystack = `${opts.category ?? ''} ${opts.industry ?? ''}`.toLowerCase();

  const direction =
    opts.direction ??
    DIRECTIONS.filter((d) => d.industries.some((i) => haystack.includes(i)))[Math.floor(rand() * Math.max(1, DIRECTIONS.filter((d) => d.industries.some((i) => haystack.includes(i))).length))]?.key ??
    DIRECTIONS[Math.floor(rand() * DIRECTIONS.length)].key;

  const paletteDef =
    PALETTES.find((p) => p.industries.some((i) => haystack.includes(i))) ?? PALETTES[PALETTES.length - 1];
  const colorSet = opts.palette && opts.palette.length >= 2
    ? { ink: opts.palette[0], paper: '#ffffff', surface: mix(opts.palette[0], '#ffffff', 0.92), accent: opts.palette[1], accentInk: '#ffffff' }
    : paletteDef.colors[Math.floor(rand() * paletteDef.colors.length)];

  const fontSet = FONT_SETS[direction][Math.floor(rand() * FONT_SETS[direction].length)];
  const muted = mix(colorSet.ink, colorSet.paper, 0.45);
  const line = mix(colorSet.ink, colorSet.paper, 0.86);

  const preset: Record<DesignDirection, Partial<Theme>> = {
    editorial: { radius: '2px', buttonRadius: '2px', shadow: '0 1px 0 rgba(0,0,0,0.04)', scale: { hero: 'clamp(2.6rem, 6.2vw, 5.2rem)', h2: 'clamp(1.8rem,3.4vw,2.9rem)', h3: '1.25rem', body: '1.0625rem', small: '0.8125rem' }, spacing: { section: 'clamp(5rem,10vw,9rem)', gap: '2rem' }, rules: '1px solid', uppercaseNav: false, letterSpacing: '-0.02em' },
    minimal: { radius: '4px', buttonRadius: '4px', shadow: 'none', scale: { hero: 'clamp(2.2rem,5vw,4rem)', h2: 'clamp(1.5rem,2.6vw,2.2rem)', h3: '1.0625rem', body: '1rem', small: '0.8125rem' }, spacing: { section: 'clamp(4rem,8vw,7rem)', gap: '1.5rem' }, rules: '1px solid', uppercaseNav: false, letterSpacing: '-0.015em' },
    bold: { radius: '10px', buttonRadius: '999px', shadow: '0 12px 32px -18px rgba(0,0,0,0.45)', scale: { hero: 'clamp(2.8rem,7vw,6rem)', h2: 'clamp(2rem,4vw,3.4rem)', h3: '1.3rem', body: '1.0625rem', small: '0.8125rem' }, spacing: { section: 'clamp(4rem,8vw,7rem)', gap: '1.75rem' }, rules: '2px solid', uppercaseNav: true, letterSpacing: '-0.035em' },
    luxe: { radius: '0px', buttonRadius: '0px', shadow: '0 20px 50px -30px rgba(0,0,0,0.6)', scale: { hero: 'clamp(2.6rem,6vw,5rem)', h2: 'clamp(1.9rem,3.6vw,3rem)', h3: '1.2rem', body: '1.0625rem', small: '0.75rem' }, spacing: { section: 'clamp(6rem,12vw,10rem)', gap: '2.25rem' }, rules: '1px solid', uppercaseNav: true, letterSpacing: '0.01em' },
    technical: { radius: '3px', buttonRadius: '3px', shadow: '0 1px 2px rgba(0,0,0,0.06)', scale: { hero: 'clamp(2.2rem,5vw,3.8rem)', h2: 'clamp(1.5rem,2.8vw,2.3rem)', h3: '1.0625rem', body: '1rem', small: '0.75rem' }, spacing: { section: 'clamp(4rem,8vw,6.5rem)', gap: '1.5rem' }, rules: '1px solid', uppercaseNav: true, letterSpacing: '-0.01em' },
    warm: { radius: '18px', buttonRadius: '999px', shadow: '0 14px 34px -22px rgba(0,0,0,0.35)', scale: { hero: 'clamp(2.4rem,5.4vw,4.2rem)', h2: 'clamp(1.7rem,3.2vw,2.6rem)', h3: '1.2rem', body: '1.0625rem', small: '0.8125rem' }, spacing: { section: 'clamp(4.5rem,9vw,7.5rem)', gap: '1.75rem' }, rules: '1px solid', uppercaseNav: false, letterSpacing: '-0.02em' },
    clinical: { radius: '8px', buttonRadius: '8px', shadow: '0 2px 10px -6px rgba(15,36,52,0.25)', scale: { hero: 'clamp(2.2rem,4.8vw,3.6rem)', h2: 'clamp(1.6rem,3vw,2.4rem)', h3: '1.125rem', body: '1rem', small: '0.8125rem' }, spacing: { section: 'clamp(4.5rem,9vw,7rem)', gap: '1.625rem' }, rules: '1px solid', uppercaseNav: false, letterSpacing: '-0.015em' },
    artisan: { radius: '2px', buttonRadius: '2px', shadow: '0 1px 0 rgba(0,0,0,0.05)', scale: { hero: 'clamp(2.4rem,5.4vw,4.4rem)', h2: 'clamp(1.7rem,3.2vw,2.7rem)', h3: '1.1875rem', body: '1.0625rem', small: '0.8125rem' }, spacing: { section: 'clamp(5rem,10vw,8.5rem)', gap: '2rem' }, rules: '1px dashed', uppercaseNav: true, letterSpacing: '0.02em' },
  };

  const p = preset[direction];
  return {
    direction,
    label: DIRECTIONS.find((d) => d.key === direction)?.label ?? direction,
    palette: { ...colorSet, muted, line },
    fonts: fontSet,
    radius: p.radius!,
    buttonRadius: p.buttonRadius!,
    shadow: p.shadow!,
    scale: p.scale!,
    spacing: p.spacing!,
    rules: p.rules!,
    uppercaseNav: p.uppercaseNav!,
    letterSpacing: p.letterSpacing!,
  };
}

/** Blend two hex colours — used to derive surfaces, muted text and rules. */
export function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  if (!pa || !pb) return a;
  const c = [0, 1, 2].map((i) => Math.round(pa[i] + (pb[i] - pa[i]) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex: string): number[] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── Model construction ───────────────────────────────────────
export interface SiteInputs {
  name: string;
  category?: string | null;
  industry?: string | null;
  description?: string | null;
  services?: string[];
  rating?: number | null;
  reviewCount?: number | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  /** City / town. Used to personalise the hero; never required. */
  locality?: string | null;
  social?: Record<string, string>;
  foundedYear?: number | null;
  testimonials?: { quote: string; author: string; source?: string }[];
  differentiators?: string[];
  bookingAvailable?: boolean;
  openingHours?: string | null;
  direction?: DesignDirection;
  palette?: string[];
  seed?: string;
}

export function buildSiteModel(input: SiteInputs): SiteModel {
  const seed = input.seed ?? `${input.name}:${input.category ?? ''}`;
  const rand = seededRandom(seed);
  const theme = buildTheme(seed, { category: input.category, industry: input.industry, direction: input.direction, palette: input.palette });
  const notes: string[] = [];

  const services = (input.services ?? []).filter(Boolean).slice(0, 8);
  if (!services.length) notes.push('No services on record — the services section lists placeholders for the client to complete.');

  const sections: Section[] = [];
  const slug = (t: string) => slugify(t, 24) || 'section';

  // Hero — construction varies by direction.
  const tagline = deriveTagline(input, theme, rand);
  sections.push({
    type: 'hero',
    id: 'hero',
    title: tagline.headline,
    subtitle: tagline.subheadline,
    cta: primaryCta(input, theme),
    body: input.description ? firstClause(input.description) : undefined,
  });

  // Trust bar — only when there is something real to show.
  const trust: string[] = [];
  if (input.rating && input.reviewCount) trust.push(`${input.rating.toFixed(1)}★ from ${input.reviewCount} reviews`);
  else if (input.rating) trust.push(`${input.rating.toFixed(1)}★ rated`);
  if (input.foundedYear) trust.push(`Established ${input.foundedYear}`);
  if (input.bookingAvailable) trust.push('Online booking available');
  const socialCount = Object.keys(input.social ?? {}).length;
  if (socialCount) trust.push(`Find us on ${Object.keys(input.social!).join(' · ')}`);
  if (trust.length) {
    sections.push({ type: 'trustbar', id: 'trustbar', items: trust.map((t) => ({ title: t })) });
  } else {
    notes.push('No ratings, founding year or booking data on record — the trust bar was omitted rather than filled with invented proof.');
  }

  // Services
  sections.push({
    type: 'services',
    id: 'services',
    title: sectionTitle(theme, ['What we do', 'Services', 'Our services', 'What we offer']),
    subtitle: input.category
      ? `${input.category}${input.address ? ` in ${shortPlace(input.address)}` : ''}.`
      : undefined,
    items: services.length
      ? services.map((s) => ({ title: s }))
      : [
          // No services on record. These are visibly marked placeholders (§22)
          // rather than plausible-looking filler, so nothing invented can ship.
          { title: '[Add your first service]', needsReview: true },
          { title: '[Add your second service]', needsReview: true },
          { title: '[Add your third service]', needsReview: true },
        ],
    needsReview: !services.length,
  });

  // About — only a real sentence when we have a description.
  sections.push({
    type: 'about',
    id: 'about',
    title: sectionTitle(theme, ['About us', `About ${input.name}`, 'Who we are']),
    body: input.description
      ? input.description
      : `[Add a short paragraph about ${input.name} — who you are, how long you have been operating and what makes you different.]`,
    needsReview: !input.description,
    items: input.differentiators?.length ? input.differentiators.map((d) => ({ title: d })) : undefined,
  });

  // Process / how it works — useful for service businesses, skipped for pure retail.
  const isServiceBusiness = /dentist|clinic|plumber|electrician|lawyer|accountant|salon|gym|physio|veterinary|hair|beauty|repair|service/i.test(
    `${input.category ?? ''} ${input.industry ?? ''}`
  );
  if (isServiceBusiness) {
    sections.push({
      type: 'process',
      id: 'process',
      title: sectionTitle(theme, ['How it works', 'Working with us', 'The process']),
      items: [
        { title: 'Enquire', body: 'Tell us what you need using the form or by phone.' },
        { title: 'We respond', body: input.phone ? `Call us on ${input.phone} or send a message — we reply quickly.` : 'We reply quickly with next steps.' },
        { title: 'We deliver', body: 'Clear scope, clear timing, no surprises.' },
      ],
    });
  }

  // Testimonials — only real ones.
  const realTestimonials = (input.testimonials ?? []).filter((t) => t.quote && t.author);
  if (realTestimonials.length) {
    sections.push({
      type: 'testimonials',
      id: 'testimonials',
      title: sectionTitle(theme, ['What people say', 'Reviews', 'Client feedback']),
      subtitle: input.rating && input.reviewCount ? `${input.rating.toFixed(1)}★ average from ${input.reviewCount} reviews` : undefined,
      items: realTestimonials.map((t) => ({ title: t.quote, meta: `${t.author}${t.source ? ` · ${t.source}` : ''}` })),
    });
  } else if (input.rating && input.reviewCount) {
    // We know the rating exists but have no quotable text — say so honestly.
    sections.push({
      type: 'testimonials',
      id: 'testimonials',
      title: sectionTitle(theme, ['What people say', 'Reviews']),
      subtitle: `${input.rating.toFixed(1)}★ from ${input.reviewCount} reviews`,
      items: [{ title: '[Add three recent customer reviews here]', needsReview: true }],
      needsReview: true,
      note: 'Review text is not held on record, so no quote has been invented.',
    });
  } else {
    notes.push('No review text on record — the testimonials section was omitted.');
  }

  // Booking / enquiry
  sections.push({
    type: 'booking',
    id: 'booking',
    title: input.bookingAvailable ? 'Book online' : sectionTitle(theme, ['Get in touch', 'Request a quote', 'Enquire', 'Book your visit']),
    subtitle: input.bookingAvailable
      ? 'Choose a time that suits you.'
      : 'Send us a message and we will come back to you.',
    items: [
      { title: 'Your name', needsReview: false },
      { title: 'Phone or email', needsReview: false },
      { title: 'What do you need?', needsReview: false },
    ],
    cta: { label: input.bookingAvailable ? 'Check availability' : 'Send enquiry', href: '#contact' },
  });

  // Contact
  const contactItems: { title: string; body?: string }[] = [];
  if (input.phone) contactItems.push({ title: 'Phone', body: input.phone });
  if (input.email) contactItems.push({ title: 'Email', body: input.email });
  if (input.address) contactItems.push({ title: 'Visit us', body: input.address });
  if (input.openingHours) contactItems.push({ title: 'Hours', body: input.openingHours });
  sections.push({
    type: 'contact',
    id: 'contact',
    title: sectionTitle(theme, ['Contact', 'Find us', 'Get in touch']),
    items: contactItems.length ? contactItems : [{ title: '[Add contact details]', needsReview: true }],
    needsReview: !contactItems.length,
  });

  sections.push({
    type: 'cta',
    id: 'cta',
    title: ctaHeadline(input, theme),
    body: input.description ? undefined : `Talk to ${input.name} about what you need.`,
    cta: primaryCta(input, theme),
  });

  sections.push({ type: 'footer', id: 'footer', title: input.name });

  return {
    businessName: input.name,
    tagline: tagline.headline,
    theme,
    layout: `${theme.direction}-${Math.floor(rand() * 3)}`,
    sections,
    logo: logoMark(initials(input.name), [theme.palette.accent, theme.palette.ink], seed),
    palette: [theme.palette.ink, theme.palette.accent, theme.palette.paper, theme.palette.surface],
    contact: { phone: input.phone, email: input.email, address: input.address },
    social: input.social ?? {},
    rating: input.rating ? { value: input.rating, count: input.reviewCount ?? 0 } : null,
    seed,
    generationNotes: notes,
  };
}

function deriveTagline(input: SiteInputs, theme: Theme, rand: () => number) {
  const name = input.name;
  const what = input.category ? input.category.toLowerCase() : null;
  const place = input.locality || (input.address ? shortPlace(input.address) : null);

  const patterns: { headline: string; sub: string }[] = what
    ? [
        { headline: `${cap(what)} worth travelling for`, sub: `${name}${place ? ` in ${place}` : ''}.${input.description ? ` ${firstClause(input.description)}` : ''}` },
        { headline: `The ${what} locals recommend`, sub: `${name}${place ? ` — ${place}` : ''}.` },
        { headline: `${name}`, sub: `${cap(what)}${place ? ` in ${place}` : ''}.${input.description ? ` ${firstClause(input.description)}` : ''}` },
        { headline: `Careful work, every time`, sub: `${name} — ${what}${place ? ` in ${place}` : ''}.` },
      ]
    : [
        { headline: name, sub: input.description ? firstClause(input.description) : '[Add a one-line description of what you do.]' },
        { headline: `Welcome to ${name}`, sub: input.description ? firstClause(input.description) : '[Add a one-line description of what you do.]' },
      ];

  const chosen = patterns[Math.floor(rand() * patterns.length)];
  void theme;
  return { headline: chosen.headline, subheadline: chosen.sub };
}

function primaryCta(input: SiteInputs, theme: Theme) {
  const verb =
    /dentist|clinic|physio|veterinary|salon|hair|beauty|gym|spa|restaurant|hotel/i.test(`${input.category ?? ''}`)
      ? 'Book now'
      : /plumber|electrician|builder|repair|lawyer|accountant/i.test(`${input.category ?? ''}`)
        ? 'Request a quote'
        : 'Get in touch';
  return { label: verb, href: '#contact' };
}

function ctaHeadline(input: SiteInputs, theme: Theme) {
  const options = [
    `Ready when you are`,
    `Let's get you booked in`,
    `Questions? Ask us`,
    `Start with a conversation`,
  ];
  void theme;
  return options[Math.floor(seededRandom(input.name + 'cta')() * options.length)];
}

function sectionTitle(theme: Theme, options: string[]): string {
  const rand = seededRandom(options.join('|') + theme.direction);
  return options[Math.floor(rand() * options.length)];
}

function firstClause(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const cut = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return cut.length > 220 ? `${cut.slice(0, 217)}…` : cut;
}

function shortPlace(address: string): string {
  const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? address;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || 'A';
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { FONT_SETS, DIRECTIONS, PALETTES };
