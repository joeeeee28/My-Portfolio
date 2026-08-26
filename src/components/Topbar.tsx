'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Sparkles, Moon, Sun, Search } from 'lucide-react';
import { useEffect, useState } from 'react';

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Dashboard', sub: 'What needs your attention right now' },
  '/discover': { title: 'Business Discovery', sub: 'Find businesses with a real digital-service opportunity' },
  '/prospects': { title: 'Prospect Hub', sub: 'Every business ClientForge knows about' },
  '/research': { title: 'Business Intelligence', sub: 'Deep research on any prospect' },
  '/audits': { title: 'Digital Audits', sub: 'Measured website and social findings' },
  '/outreach': { title: 'Outreach', sub: 'Personalized messages grounded in real findings' },
  '/sequences': { title: 'Outreach Sequences', sub: 'Multichannel follow-up that stops itself' },
  '/mockups': { title: 'Website Concepts', sub: 'Sales assets built from the prospect’s real record' },
  '/pipeline': { title: 'Client Pipeline', sub: 'Discovery through to growth' },
  '/calls': { title: 'Calls', sub: 'Scheduling, notes and briefings' },
  '/proposals': { title: 'Proposals', sub: 'Scope, pricing and signature-ready documents' },
  '/clients': { title: 'Clients', sub: 'Active relationships and growth opportunities' },
  '/projects': { title: 'Projects', sub: 'Delivery from onboarding to handover' },
  '/social': { title: 'Social Workspace', sub: 'Content, calendar and approvals' },
  '/websites': { title: 'Websites', sub: 'Hosting, domains and deployments' },
  '/automation': { title: 'Forge Automation', sub: 'Scheduled discovery and job health' },
  '/analytics': { title: 'Analytics', sub: 'Acquisition, revenue and unit economics' },
  '/forge-ai': { title: 'Forge AI', sub: 'Ask anything across the whole lifecycle' },
  '/settings': { title: 'Settings', sub: 'Scoring, ICP, integrations, models and compliance' },
  '/action-queue': { title: 'Action Queue', sub: 'Everything waiting on a decision' },
};

export function Topbar({ user }: { user: { name: string; role: string; initials: string; orgId: string } }) {
  const pathname = usePathname();
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem('cf_theme') : null;
    const initial = stored === 'dark' || (!stored && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    setDark(!!initial);
    document.documentElement.dataset.theme = initial ? 'dark' : 'light';
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try {
      window.localStorage.setItem('cf_theme', next ? 'dark' : 'light');
    } catch {
      /* storage unavailable */
    }
  };

  const meta = TITLES[pathname] ?? TITLES[pathname.split('/').slice(0, 2).join('/')] ?? null;

  return (
    <header className="topbar">
      <div style={{ minWidth: 0 }}>
        <div className="topbar-title truncate">{meta?.title ?? 'ClientForge AI'}</div>
        {meta?.sub && <div className="topbar-sub truncate">{meta.sub}</div>}
      </div>
      <div className="topbar-actions">
        <Link href="/prospects" className="btn btn-sm" title="Search prospects">
          <Search size={14} />
          <span className="hide-sm">Search</span>
        </Link>
        <Link href="/forge-ai" className="btn btn-sm btn-primary" title="Forge AI">
          <Sparkles size={14} />
          <span className="hide-sm">Forge AI</span>
        </Link>
        <button className="btn btn-ghost btn-sm" onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {dark ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <div
          title={`${user.name} · ${user.role}`}
          style={{
            width: 26, height: 26, borderRadius: '50%', background: 'var(--ink-100)',
            display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
          }}
        >
          {user.initials}
        </div>
      </div>
    </header>
  );
}
