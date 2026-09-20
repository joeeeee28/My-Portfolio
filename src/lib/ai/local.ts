/**
 * Local grounded text intelligence.
 *
 * These functions are deterministic and offline. They can only work from the
 * facts they are handed, which is exactly the property we want: the system
 * never invents a business fact, a review, a statistic or a client claim.
 *
 * Domain-specific generators (outreach copy, website copy, proposals…) live
 * next to their engines and build on the utilities here.
 */
import type { AiRequest } from '@/lib/providers/registry';
import { round, sentence, truncate } from '@/lib/id';

// ── Extractive summarization ─────────────────────────────────
/** Scores sentences by term frequency and returns the top ones in source order. */
export function extractiveSummary(text: string, maxSentences = 4): string {
  const sentences = splitSentences(text);
  if (sentences.length <= maxSentences) return sentences.join(' ');
  const freq = termFrequencies(text);
  const scored = sentences.map((s, i) => {
    const terms = tokenize(s);
    const score = terms.reduce((a, t) => a + (freq[t] ?? 0), 0) / Math.max(1, Math.sqrt(terms.length));
    return { s, i, score: score * (i < 2 ? 1.15 : 1) };
  });
  const top = [...scored].sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.i - b.i);
  return top.map((t) => t.s).join(' ');
}

/** Compresses a block of notes into labelled bullets. */
export function bulletize(text: string, max = 8): string[] {
  return splitSentences(text)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)
    .slice(0, max);
}

export function splitSentences(text: string): string[] {
  return (text ?? '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'they', 'have', 'will', 'your', 'you', 'are', 'was', 'were',
  'been', 'has', 'had', 'its', 'our', 'their', 'his', 'her', 'not', 'but', 'can', 'all', 'one', 'out', 'into', 'about',
  'there', 'what', 'when', 'which', 'who', 'how', 'why', 'than', 'then', 'them', 'these', 'those', 'also', 'just',
]);

export function termFrequencies(text: string): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const t of tokenize(text)) freq[t] = (freq[t] ?? 0) + 1;
  return freq;
}

export function keywords(text: string, limit = 8): string[] {
  return Object.entries(termFrequencies(text))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

// ── Lightweight sentiment (used for reply classification, §19) ──
const POSITIVE = new Set([
  'interested', 'yes', 'great', 'thanks', 'thank', 'love', 'sounds', 'good', 'perfect', 'call', 'meeting', 'schedule',
  'tell', 'more', 'send', 'sure', 'happy', 'excellent', 'amazing', 'helpful', 'proceed', 'ready', 'book', 'available',
  'works', 'let', 'discuss', 'intrigued', 'impressive', 'wow', 'nice',
]);
const NEGATIVE = new Set([
  'no', 'not', 'stop', 'unsubscribe', 'remove', 'spam', 'never', 'uninterested', 'waste', 'annoying', 'dont', "don't",
  'do', 'not interested', 'delete', 'cancel', 'no thanks', 'leave', 'complaint', 'refuse', 'declined',
]);

export interface Sentiment {
  label: 'positive' | 'neutral' | 'negative';
  score: number;
  signals: string[];
}

export function classifySentiment(text: string): Sentiment {
  const lower = ` ${(text ?? '').toLowerCase()} `;
  const words = lower.split(/[^a-z']+/).filter(Boolean);
  let pos = 0;
  let neg = 0;
  const signals: string[] = [];
  for (const w of words) {
    if (POSITIVE.has(w)) {
      pos++;
      signals.push(w);
    }
    if (NEGATIVE.has(w)) {
      neg++;
      signals.push(w);
    }
  }
  for (const phrase of ['not interested', 'no thanks', 'please stop', 'unsubscribe', 'do not contact', 'take me off']) {
    if (lower.includes(phrase)) {
      neg += 3;
      signals.push(phrase);
    }
  }
  for (const phrase of ['let\'s talk', 'let us talk', "let's chat", 'book a call', 'send over', 'tell me more', 'sounds good']) {
    if (lower.includes(phrase)) {
      pos += 2;
      signals.push(phrase);
    }
  }
  const total = pos + neg;
  const score = total === 0 ? 0 : (pos - neg) / total;
  return {
    label: score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral',
    score: round(score, 2),
    signals: Array.from(new Set(signals)).slice(0, 6),
  };
}

// ── Template rendering ───────────────────────────────────────
/**
 * Renders `{{path.to.value}}` placeholders against a facts object.
 * Unknown placeholders collapse to an empty string and are reported, so a
 * message can never ship with a visible unfilled token.
 */
export function renderTemplate(
  template: string,
  facts: Record<string, unknown>
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, path: string) => {
    const value = resolvePath(facts, path);
    if (value === undefined || value === null || value === '') {
      missing.push(path);
      return '';
    }
    return String(value);
  });
  return { text: text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim(), missing };
}

export function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (Array.isArray(acc)) {
      const idx = Number(key);
      return Number.isFinite(idx) ? acc[idx] : undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// ── Copy helpers ─────────────────────────────────────────────
export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function titleize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .trim();
}

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/** "4.8★ from 126 reviews" — only rendered when the underlying data exists. */
export function ratingPhrase(rating: number | null | undefined, reviewCount: number | null | undefined): string | null {
  if (rating === null || rating === undefined) return null;
  if (reviewCount && reviewCount > 0) return `${rating.toFixed(1)}★ from ${reviewCount} ${pluralize(reviewCount, 'review')}`;
  return `${rating.toFixed(1)}★ rating`;
}

export function firstSentence(text: string): string {
  return splitSentences(text)[0] ?? '';
}

export function listPhrase(items: string[], max = 3): string {
  return sentence(items.slice(0, max).map((i) => i.toLowerCase()));
}

export function cap(s: string, max = 160): string {
  return truncate(s, max);
}

/** Naive but effective: strips HTML so audits and previews can share plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cosine similarity between two short texts — used for duplicate message protection. */
export function cosineSimilarity(a: string, b: string): number {
  const va = termFrequencies(a);
  const vb = termFrequencies(b);
  const keys = new Set([...Object.keys(va), ...Object.keys(vb)]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = va[k] ?? 0;
    const y = vb[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ── Generic AiProvider entry point ───────────────────────────
/**
 * Fallback for the provider interface. When the router ends up here it means no
 * hosted model is configured, so we return the most useful grounded thing we
 * can: an extractive summary of the prompt, clearly labelled.
 */
export function localGenerate(req: AiRequest): { text: string; json?: unknown } {
  const body = req.prompt ?? '';
  if (req.json) {
    return {
      text: '',
      json: {
        engine: 'local-grounded',
        note: 'No hosted model configured for this task. Configure one in Settings → AI Models for generative output.',
        summary: extractiveSummary(body, 3),
        keywords: keywords(body, 6),
      },
    };
  }
  return {
    text: extractiveSummary(body, req.maxTokens && req.maxTokens > 800 ? 6 : 3),
  };
}

export function confidencePhrase(confidence: number): string {
  if (confidence >= 0.85) return 'high confidence';
  if (confidence >= 0.6) return 'moderate confidence';
  if (confidence >= 0.35) return 'low confidence — verify before relying on this';
  return 'unverified';
}
