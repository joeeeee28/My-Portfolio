/**
 * Site model → self-contained HTML (§20, §23).
 *
 * Output is a single document with inlined CSS: no build step, no external
 * assets except an optional webfont link that degrades to system fonts when
 * offline. Includes the view-tracking beacon used for mockup engagement
 * intelligence (§23, §24).
 */
import type { Section, SiteModel } from './site';
import { inlineArtwork } from '@/lib/artwork';

export interface RenderOptions {
  /** Base URL used for tracking + CTA links. Omit for a static export. */
  baseUrl?: string;
  trackingToken?: string;
  showReviewMarkers?: boolean;
  title?: string;
  /** Renders a narrow viewport wrapper for the mobile preview. */
  mobileFrame?: boolean;
}

export function renderSite(model: SiteModel, opts: RenderOptions = {}): string {
  const t = model.theme;
  const p = t.palette;
  const showMarkers = opts.showReviewMarkers !== false;
  const artwork = inlineArtwork(model.seed, [p.accent, p.ink, p.surface]);
  const reviewCount = model.sections.filter((s) => s.needsReview).length;

  const body = model.sections.map((s) => renderSection(s, model, opts, showMarkers)).join('\n');

  const fontHref = fontLink(t.fonts.display, t.fonts.body);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(opts.title ?? `${model.businessName} — concept website`)}</title>
<meta name="description" content="${esc(model.tagline ?? model.businessName)}"/>
<meta property="og:title" content="${esc(model.businessName)}"/>
<meta property="og:description" content="${esc(model.tagline ?? '')}"/>
<meta name="generator" content="Acquisition OS mockup engine"/>
${fontHref}
<style>
:root{
  --ink:${p.ink}; --paper:${p.paper}; --surface:${p.surface}; --accent:${p.accent};
  --accent-ink:${p.accentInk}; --muted:${p.muted}; --line:${p.line};
  --radius:${t.radius}; --btn-radius:${t.buttonRadius}; --shadow:${t.shadow};
  --hero:${t.scale.hero}; --h2:${t.scale.h2}; --h3:${t.scale.h3}; --body:${t.scale.body}; --small:${t.scale.small};
  --section:${t.spacing.section}; --gap:${t.spacing.gap};
  --font-display:${t.fonts.stackDisplay}; --font-body:${t.fonts.stackBody};
  --tracking:${t.letterSpacing};
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-body);font-size:var(--body);line-height:1.62;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}
a{color:inherit}
h1,h2,h3{font-family:var(--font-display);letter-spacing:var(--tracking);line-height:1.08;margin:0}
.wrap{width:min(1160px,92vw);margin-inline:auto}
.narrow{width:min(760px,92vw);margin-inline:auto}
section{padding:var(--section) 0}
.kicker{font-size:var(--small);text-transform:${t.uppercaseNav ? 'uppercase' : 'none'};letter-spacing:.14em;color:var(--muted);margin:0 0 .9rem;font-weight:600}
h2.sec{font-size:var(--h2);margin-bottom:.75rem;font-weight:${t.direction === 'luxe' || t.direction === 'editorial' ? 500 : 700}}
.sub{color:var(--muted);max-width:58ch;margin:0 0 2.5rem}

/* nav */
.nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb, var(--paper) 88%, transparent);backdrop-filter:blur(10px);border-bottom:${t.rules} var(--line)}
.nav-in{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.85rem 0}
.brand{display:flex;align-items:center;gap:.6rem;font-family:var(--font-display);font-weight:700;font-size:1.0625rem;letter-spacing:var(--tracking)}
.brand img{width:30px;height:30px;border-radius:${t.radius}}
.nav-links{display:flex;gap:1.5rem;font-size:var(--small);${t.uppercaseNav ? 'text-transform:uppercase;letter-spacing:.1em;' : ''}}
.nav-links a{text-decoration:none;color:var(--muted)}
.nav-links a:hover{color:var(--ink)}
@media(max-width:760px){.nav-links{display:none}}

/* buttons */
.btn{display:inline-flex;align-items:center;gap:.5rem;background:var(--accent);color:var(--accent-ink);border:${t.rules} var(--accent);
  padding:${t.direction === 'luxe' ? '.95rem 2rem' : '.8rem 1.5rem'};border-radius:var(--btn-radius);text-decoration:none;
  font-weight:600;font-size:${t.direction === 'luxe' ? 'var(--small)' : '.9375rem'};${t.uppercaseNav ? 'text-transform:uppercase;letter-spacing:.1em;' : ''}
  box-shadow:var(--shadow);transition:transform .16s ease,filter .16s ease;cursor:pointer;font-family:var(--font-body)}
.btn:hover{transform:translateY(-1px);filter:brightness(1.06)}
.btn-ghost{background:transparent;color:var(--ink);border:${t.rules} var(--line);box-shadow:none}
.btn-sm{padding:.55rem 1.05rem;font-size:.8125rem}

/* hero */
.hero{padding:${t.direction === 'luxe' ? 'calc(var(--section) * 1.15)' : 'var(--section)'} 0;position:relative;overflow:hidden}
.hero-grid{display:grid;grid-template-columns:${heroColumns(t.direction)};gap:calc(var(--gap) * 1.6);align-items:center}
.hero h1{font-size:var(--hero);font-weight:${t.direction === 'editorial' || t.direction === 'luxe' ? 500 : 800};margin-bottom:1.1rem}
.hero .lede{color:var(--muted);font-size:1.125rem;max-width:46ch;margin:0 0 2rem}
.hero-art{border-radius:${t.radius};overflow:hidden;box-shadow:var(--shadow);aspect-ratio:4/3;background:var(--surface)}
.hero-art img{width:100%;height:100%;object-fit:cover}
.hero-cta{display:flex;gap:.75rem;flex-wrap:wrap}
@media(max-width:820px){.hero-grid{grid-template-columns:1fr}.hero-art{order:-1;aspect-ratio:16/10}}

/* trust bar */
.trust{border-block:${t.rules} var(--line);background:var(--surface);padding:1.1rem 0}
.trust-in{display:flex;flex-wrap:wrap;gap:.5rem 2rem;font-size:var(--small);color:var(--muted);${t.uppercaseNav ? 'text-transform:uppercase;letter-spacing:.09em;' : ''}}
.trust-in span{display:inline-flex;align-items:center;gap:.45rem}
.trust-in span::before{content:"";width:5px;height:5px;background:var(--accent);border-radius:50%}

/* cards */
.grid{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
.card{background:var(--paper);border:${t.rules} var(--line);border-radius:var(--radius);padding:1.6rem;transition:border-color .16s ease,transform .16s ease}
.card:hover{border-color:var(--accent);transform:translateY(-2px)}
.card h3{font-size:var(--h3);margin-bottom:.4rem;font-weight:650}
.card p{margin:0;color:var(--muted);font-size:.9375rem}
.card .num{font-family:var(--font-display);font-size:.8125rem;color:var(--accent);letter-spacing:.12em;display:block;margin-bottom:.7rem}

/* about */
.about-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:calc(var(--gap) * 1.5);align-items:start}
.about-grid p{margin:0 0 1rem}
@media(max-width:820px){.about-grid{grid-template-columns:1fr}}
.pills{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:1.25rem}
.pill{border:${t.rules} var(--line);border-radius:var(--btn-radius);padding:.35rem .85rem;font-size:var(--small);color:var(--muted)}

/* process */
.steps{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fit,minmax(200px,1fr));counter-reset:s}
.step{border-top:${t.rules === '1px dashed' ? '1px dashed' : '2px solid'} var(--accent);padding-top:1.1rem}
.step .n{font-family:var(--font-display);font-size:var(--small);color:var(--accent);letter-spacing:.14em;display:block;margin-bottom:.6rem}
.step h3{font-size:1.0625rem;margin-bottom:.35rem}
.step p{margin:0;color:var(--muted);font-size:.9375rem}

/* testimonials */
.quote{background:var(--surface);border-radius:var(--radius);padding:1.75rem;border:${t.rules} var(--line)}
.quote p{margin:0 0 1rem;font-family:var(--font-display);font-size:1.0625rem;line-height:1.5}
.quote cite{font-style:normal;font-size:var(--small);color:var(--muted)}
.stars{color:var(--accent);letter-spacing:.15em;font-size:.875rem;margin-bottom:.75rem}

/* form */
.form{display:grid;gap:1rem;max-width:560px}
.field label{display:block;font-size:var(--small);color:var(--muted);margin-bottom:.4rem;${t.uppercaseNav ? 'text-transform:uppercase;letter-spacing:.09em;' : ''}}
.field input,.field textarea,.field select{width:100%;padding:.8rem .9rem;border:${t.rules} var(--line);border-radius:var(--radius);
  background:var(--paper);color:var(--ink);font-family:var(--font-body);font-size:.9375rem}
.field input:focus,.field textarea:focus{outline:2px solid var(--accent);outline-offset:1px}

/* contact */
.contact-grid{display:grid;gap:var(--gap);grid-template-columns:repeat(auto-fit,minmax(190px,1fr))}
.contact-item{border-left:${t.rules === '1px dashed' ? '1px dashed' : '2px solid'} var(--accent);padding-left:1rem}
.contact-item .k{font-size:var(--small);color:var(--muted);${t.uppercaseNav ? 'text-transform:uppercase;letter-spacing:.09em;' : ''}}
.contact-item .v{font-size:1.0625rem;margin-top:.2rem}

/* cta band */
.cta-band{background:var(--ink);color:var(--paper);text-align:center}
.cta-band h2{color:var(--paper);font-size:var(--h2);margin-bottom:1rem}
.cta-band p{color:color-mix(in srgb, var(--paper) 72%, transparent);margin:0 0 1.75rem}
.cta-band .btn{background:var(--accent);border-color:var(--accent)}

/* footer */
footer.site{border-top:${t.rules} var(--line);padding:2.5rem 0;font-size:var(--small);color:var(--muted)}
.foot-in{display:flex;flex-wrap:wrap;gap:1rem 2rem;justify-content:space-between;align-items:center}
.foot-links{display:flex;gap:1.25rem;flex-wrap:wrap}
.foot-links a{text-decoration:none;color:var(--muted)}

/* review markers (§22) */
.needs-review{outline:1px dashed var(--accent);outline-offset:6px;position:relative}
.review-flag{display:inline-flex;align-items:center;gap:.4rem;background:#fff7e6;color:#8a5a00;border:1px solid #f0d9a8;
  border-radius:var(--radius);padding:.3rem .7rem;font-size:.75rem;margin-bottom:.9rem;font-family:var(--font-body)}
.concept-banner{position:sticky;bottom:0;z-index:30;background:var(--ink);color:var(--paper);font-size:.8125rem;
  padding:.6rem 0;text-align:center;font-family:var(--font-body)}
.concept-banner a{color:var(--accent);font-weight:600}
</style>
</head>
<body>
${nav(model)}
${body}
${opts.showReviewMarkers === false ? '' : conceptBanner(model, reviewCount)}
${trackingScript(opts)}
</body>
</html>`;
}

function heroColumns(direction: string): string {
  switch (direction) {
    case 'minimal':
      return '1.35fr .65fr';
    case 'bold':
      return '1fr 1fr';
    case 'luxe':
      return '1.1fr .9fr';
    case 'technical':
      return '1.25fr .75fr';
    case 'editorial':
      return '1.15fr .85fr';
    default:
      return '1.1fr .9fr';
  }
}

function fontLink(display: string, body: string): string {
  const names = Array.from(new Set([display, body].filter(Boolean))).map((n) => n.replace(/ /g, '+'));
  if (!names.length) return '';
  const family = names.map((n) => `family=${n}:wght@400;500;600;700;800`).join('&');
  return `<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link rel="stylesheet" href="https://fonts.googleapis.com/css2?${family}&display=swap"/>`;
}

function nav(model: SiteModel): string {
  const links = model.sections
    .filter((s) => ['services', 'about', 'testimonials', 'booking', 'contact'].includes(s.type))
    .map((s) => `<a href="#${s.id}">${esc(navLabel(s))}</a>`)
    .join('');
  return `<header class="nav"><div class="wrap nav-in">
  <a class="brand" href="#hero" style="text-decoration:none"><img src="${model.logo}" alt=""/>${esc(model.businessName)}</a>
  <nav class="nav-links">${links}</nav>
  <a class="btn btn-sm" href="#contact">${esc(primaryLabel(model))}</a>
</div></header>`;
}

function navLabel(s: Section): string {
  const map: Record<string, string> = { services: 'Services', about: 'About', testimonials: 'Reviews', booking: 'Booking', contact: 'Contact' };
  return map[s.type] ?? (s.title ?? s.type);
}

function primaryLabel(model: SiteModel): string {
  return model.sections.find((s) => s.type === 'hero')?.cta?.label ?? 'Get in touch';
}

function renderSection(s: Section, model: SiteModel, opts: RenderOptions, showMarkers: boolean): string {
  const marker = s.needsReview && showMarkers ? `<span class="review-flag">Needs your input — placeholder content</span>` : '';
  const cls = s.needsReview && showMarkers ? ' class="needs-review"' : '';

  switch (s.type) {
    case 'hero':
      return `<section class="hero" id="${s.id}"><div class="wrap hero-grid">
  <div>
    ${s.body ? `<p class="kicker">${esc(model.businessName)}</p>` : ''}
    <h1>${esc(s.title ?? model.businessName)}</h1>
    ${s.subtitle ? `<p class="lede">${esc(s.subtitle)}</p>` : ''}
    <div class="hero-cta">
      <a class="btn" href="${esc(s.cta?.href ?? '#contact')}" data-cta="1">${esc(s.cta?.label ?? 'Get in touch')}</a>
      ${model.contact.phone ? `<a class="btn btn-ghost" href="tel:${esc(model.contact.phone.replace(/\s/g, ''))}">Call ${esc(model.contact.phone)}</a>` : ''}
    </div>
  </div>
  <div class="hero-art"><img src="${inlineArtwork(model.seed, [model.theme.palette.accent, model.theme.palette.ink, model.theme.palette.surface])}" alt="Abstract brand artwork for ${esc(model.businessName)}"/></div>
</div></section>`;

    case 'trustbar':
      return `<div class="trust"><div class="wrap trust-in">${(s.items ?? []).map((i) => `<span>${esc(i.title)}</span>`).join('')}</div></div>`;

    case 'services':
      return `<section id="${s.id}"${cls}><div class="wrap">${marker}
  <h2 class="sec">${esc(s.title ?? 'Services')}</h2>
  ${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}
  <div class="grid">${(s.items ?? []).map((i, n) => `<article class="card"><span class="num">${String(n + 1).padStart(2, '0')}</span><h3>${esc(i.title)}</h3>${i.body ? `<p>${esc(i.body)}</p>` : ''}</article>`).join('')}</div>
</div></section>`;

    case 'about':
      return `<section id="${s.id}"${cls} style="background:var(--surface)"><div class="wrap about-grid">${marker}
  <div><h2 class="sec">${esc(s.title ?? 'About us')}</h2>${s.body ? `<p>${esc(s.body)}</p>` : ''}</div>
  <div>${(s.items ?? []).length ? `<div class="pills">${s.items!.map((i) => `<span class="pill">${esc(i.title)}</span>`).join('')}</div>` : ''}</div>
</div></section>`;

    case 'process':
      return `<section id="${s.id}"><div class="wrap">
  <h2 class="sec">${esc(s.title ?? 'How it works')}</h2>
  <div class="steps">${(s.items ?? []).map((i, n) => `<div class="step"><span class="n">STEP ${n + 1}</span><h3>${esc(i.title)}</h3>${i.body ? `<p>${esc(i.body)}</p>` : ''}</div>`).join('')}</div>
</div></section>`;

    case 'testimonials':
      return `<section id="${s.id}"${cls}><div class="wrap">${marker}
  <h2 class="sec">${esc(s.title ?? 'Reviews')}</h2>
  ${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}
  ${s.note && showMarkers ? `<p class="sub" style="font-size:.8125rem">${esc(s.note)}</p>` : ''}
  <div class="grid">${(s.items ?? []).map((i) => `<figure class="quote"><div class="stars">${model.rating ? '★'.repeat(Math.round(model.rating.value)) : ''}</div><p>“${esc(i.title)}”</p><cite>${esc(i.meta ?? '')}</cite></figure>`).join('')}</div>
</div></section>`;

    case 'booking':
      return `<section id="${s.id}" style="background:var(--surface)"><div class="wrap">
  <h2 class="sec">${esc(s.title ?? 'Get in touch')}</h2>
  ${s.subtitle ? `<p class="sub">${esc(s.subtitle)}</p>` : ''}
  <form class="form" data-form="1" onsubmit="return false">
    <div class="field"><label for="f-name">Your name</label><input id="f-name" name="name" type="text" required/></div>
    <div class="field"><label for="f-contact">Phone or email</label><input id="f-contact" name="contact" type="text" required/></div>
    <div class="field"><label for="f-msg">What do you need?</label><textarea id="f-msg" name="message" rows="4"></textarea></div>
    <button class="btn" type="submit" data-cta="1">${esc(s.cta?.label ?? 'Send enquiry')}</button>
  </form>
</div></section>`;

    case 'contact':
      return `<section id="${s.id}"${cls}><div class="wrap">${marker}
  <h2 class="sec">${esc(s.title ?? 'Contact')}</h2>
  <div class="contact-grid">${(s.items ?? []).map((i) => `<div class="contact-item"><div class="k">${esc(i.title)}</div><div class="v">${esc(i.body ?? '')}</div></div>`).join('')}</div>
  ${Object.keys(model.social).length ? `<div class="pills" style="margin-top:2rem">${Object.entries(model.social).map(([k, v]) => `<a class="pill" href="${esc(v)}" rel="noopener">${esc(k)}</a>`).join('')}</div>` : ''}
</div></section>`;

    case 'cta':
      return `<section class="cta-band" id="${s.id}"><div class="narrow">
  <h2>${esc(s.title ?? "Let's talk")}</h2>
  ${s.body ? `<p>${esc(s.body)}</p>` : ''}
  <a class="btn" href="${esc(s.cta?.href ?? '#contact')}" data-cta="1">${esc(s.cta?.label ?? 'Get in touch')}</a>
</div></section>`;

    case 'footer':
      return `<footer class="site"><div class="wrap foot-in">
  <div>© ${new Date().getFullYear()} ${esc(model.businessName)}</div>
  <div class="foot-links">
    ${model.contact.phone ? `<a href="tel:${esc(model.contact.phone.replace(/\s/g, ''))}">${esc(model.contact.phone)}</a>` : ''}
    ${model.contact.email ? `<a href="mailto:${esc(model.contact.email)}">${esc(model.contact.email)}</a>` : ''}
    ${Object.entries(model.social).map(([k, v]) => `<a href="${esc(v)}" rel="noopener">${esc(k)}</a>`).join('')}
  </div>
</div></footer>`;

    default:
      return '';
  }
}

function conceptBanner(model: SiteModel, reviewCount: number): string {
  return `<div class="concept-banner">Concept website for <strong>${esc(model.businessName)}</strong> — ${model.theme.label.toLowerCase()} direction${reviewCount ? ` · ${reviewCount} section(s) awaiting your content` : ''}. Placeholder artwork is abstract, not photography.</div>`;
}

/**
 * Engagement beacon (§23). Reports first paint, dwell time, scroll depth,
 * CTA clicks and form interaction. Degrades silently when the endpoint is not
 * reachable so a shared preview never errors in front of a prospect.
 */
function trackingScript(opts: RenderOptions): string {
  if (!opts.trackingToken) return '';
  return `<script>
(function(){
  var token=${JSON.stringify(opts.trackingToken)};
  var started=Date.now(), maxScroll=0, cta=0, form=0, sections=[];
  function send(extra){
    try{
      var payload=Object.assign({token:token,durationMs:Date.now()-started,scrolledPct:maxScroll,
        ctaClicked:cta,formInteracted:form,sectionsSeen:sections,
        device:window.innerWidth<760?'mobile':window.innerWidth<1100?'tablet':'desktop',
        viewport:window.innerWidth+'x'+window.innerHeight},extra||{});
      if(navigator.sendBeacon){navigator.sendBeacon('/api/track',new Blob([JSON.stringify(payload)],{type:'application/json'}));}
      else{fetch('/api/track',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:true});}
    }catch(e){}
  }
  addEventListener('scroll',function(){
    var h=document.documentElement;
    var pct=Math.round((h.scrollTop/(h.scrollHeight-h.clientHeight||1))*100);
    if(pct>maxScroll)maxScroll=pct;
    document.querySelectorAll('section[id]').forEach(function(s){
      var r=s.getBoundingClientRect();
      if(r.top<window.innerHeight*0.75&&sections.indexOf(s.id)<0)sections.push(s.id);
    });
  },{passive:true});
  document.addEventListener('click',function(e){
    if(e.target.closest&&e.target.closest('[data-cta]'))cta=1;
  });
  document.addEventListener('focusin',function(e){
    if(e.target.closest&&e.target.closest('[data-form]'))form=1;
  });
  addEventListener('pagehide',function(){send({});});
  setTimeout(function(){send({heartbeat:true});},4000);
})();
</script>`;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal word/section diff used by the version compare view (§21). */
export function diffModels(a: SiteModel, b: SiteModel): { added: string[]; removed: string[]; changed: string[]; themeChanged: boolean } {
  const key = (s: Section) => `${s.type}:${s.id}`;
  const aKeys = new Set(a.sections.map(key));
  const bKeys = new Set(b.sections.map(key));
  const added = [...bKeys].filter((k) => !aKeys.has(k));
  const removed = [...aKeys].filter((k) => !bKeys.has(k));
  const changed: string[] = [];
  for (const s of b.sections) {
    const prev = a.sections.find((x) => key(x) === key(s));
    if (!prev) continue;
    if (prev.title !== s.title) changed.push(`${s.id}: title`);
    if (prev.subtitle !== s.subtitle) changed.push(`${s.id}: subtitle`);
    if (prev.body !== s.body) changed.push(`${s.id}: body`);
    if (JSON.stringify(prev.items) !== JSON.stringify(s.items)) changed.push(`${s.id}: items`);
    if (prev.cta?.label !== s.cta?.label) changed.push(`${s.id}: CTA`);
  }
  return { added, removed, changed, themeChanged: a.theme.direction !== b.theme.direction || a.theme.palette.accent !== b.theme.palette.accent };
}
