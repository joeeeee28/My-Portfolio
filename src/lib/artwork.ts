/**
 * Procedural SVG artwork (§22).
 *
 * Generates real, deterministic brand artwork from a seed + palette. Used for
 * hero backgrounds and image placeholders. It is abstract by design: the system
 * never pretends to have a photograph of the business.
 */
import { seededRandom } from './id';

export interface ArtworkOptions {
  width?: number;
  height?: number;
  palette?: string[];
  style?: 'mesh' | 'waves' | 'grid' | 'arcs' | 'duotone';
}

export function svgArtwork(seed: string, opts: ArtworkOptions = {}): string {
  const w = opts.width ?? 1200;
  const h = opts.height ?? 800;
  const rand = seededRandom(seed);
  const palette = opts.palette && opts.palette.length >= 2 ? opts.palette : ['#1f2937', '#6366f1', '#a5b4fc'];
  const [base, accent, soft] = [palette[0], palette[1] ?? palette[0], palette[2] ?? palette[1] ?? palette[0]];
  const styles: ArtworkOptions['style'][] = ['mesh', 'waves', 'grid', 'arcs', 'duotone'];
  const style = opts.style ?? styles[Math.floor(rand() * styles.length)];
  const gid = `g${Math.floor(rand() * 1e6).toString(36)}`;

  let body = '';
  if (style === 'mesh') {
    for (let i = 0; i < 5; i++) {
      const cx = Math.round(rand() * w);
      const cy = Math.round(rand() * h);
      const r = Math.round(200 + rand() * 420);
      const color = [accent, soft, base][i % 3];
      body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" opacity="${(0.14 + rand() * 0.2).toFixed(2)}" filter="url(#${gid}b)"/>`;
    }
  } else if (style === 'waves') {
    for (let i = 0; i < 6; i++) {
      const y = (h / 6) * i + 60;
      const amp = 30 + rand() * 70;
      const color = i % 2 ? accent : soft;
      body += `<path d="M0 ${y} C ${w * 0.25} ${y - amp}, ${w * 0.55} ${y + amp}, ${w} ${y}" stroke="${color}" stroke-width="${(1 + rand() * 3).toFixed(1)}" fill="none" opacity="${(0.25 + rand() * 0.4).toFixed(2)}"/>`;
    }
  } else if (style === 'grid') {
    const step = 48;
    for (let x = 0; x < w; x += step) {
      for (let y = 0; y < h; y += step) {
        if (rand() > 0.86) {
          const s = 6 + rand() * 22;
          body += `<rect x="${x}" y="${y}" width="${s.toFixed(0)}" height="${s.toFixed(0)}" rx="${(rand() * 6).toFixed(1)}" fill="${rand() > 0.5 ? accent : soft}" opacity="${(0.12 + rand() * 0.35).toFixed(2)}"/>`;
        }
      }
    }
  } else if (style === 'arcs') {
    for (let i = 0; i < 7; i++) {
      const cx = Math.round(rand() * w);
      const cy = Math.round(rand() * h);
      const r = Math.round(80 + rand() * 300);
      const start = Math.round(rand() * 360);
      const sweep = 90 + Math.round(rand() * 180);
      const rad = (a: number) => (a * Math.PI) / 180;
      const x1 = cx + r * Math.cos(rad(start));
      const y1 = cy + r * Math.sin(rad(start));
      const x2 = cx + r * Math.cos(rad(start + sweep));
      const y2 = cy + r * Math.sin(rad(start + sweep));
      body += `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${i % 2 ? accent : soft}" stroke-width="${(2 + rand() * 8).toFixed(1)}" fill="none" opacity="${(0.2 + rand() * 0.4).toFixed(2)}" stroke-linecap="round"/>`;
    }
  } else {
    body += `<rect width="${w}" height="${h}" fill="url(#${gid}l)"/>`;
    for (let i = 0; i < 4; i++) {
      const y = Math.round(rand() * h);
      body += `<rect x="0" y="${y}" width="${w}" height="${Math.round(20 + rand() * 120)}" fill="${i % 2 ? accent : soft}" opacity="${(0.08 + rand() * 0.16).toFixed(2)}"/>`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Abstract brand artwork">
<defs>
<filter id="${gid}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>
<linearGradient id="${gid}l" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${base}"/><stop offset="100%" stop-color="${accent}"/></linearGradient>
</defs>
<rect width="${w}" height="${h}" fill="${base}"/>
${body}
</svg>`;
}

export function dataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Compact inline placeholder used inside generated mockups — keeps them self-contained. */
export function inlineArtwork(seed: string, palette: string[], style?: ArtworkOptions['style']): string {
  return dataUri(svgArtwork(seed, { width: 1200, height: 700, palette, style }));
}

/** Simple inline SVG "logo mark" derived from the business initials and palette. */
export function logoMark(initials: string, palette: string[], seed: string): string {
  const rand = seededRandom(seed);
  const [a, b] = [palette[0] ?? '#111827', palette[1] ?? '#4f46e5'];
  const shape = Math.floor(rand() * 3);
  const inner =
    shape === 0
      ? `<rect x="10" y="10" width="44" height="44" rx="10" fill="${a}"/>`
      : shape === 1
        ? `<circle cx="32" cy="32" r="24" fill="${a}"/>`
        : `<path d="M32 8 L56 56 L8 56 Z" fill="${a}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${inner}<text x="32" y="40" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="#fff" text-anchor="middle">${escape(initials)}</text><circle cx="50" cy="16" r="5" fill="${b}"/></svg>`;
  return dataUri(svg);
}

function escape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}
