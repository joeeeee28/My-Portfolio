'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  LayoutDashboard, Radar, Users, Search, ClipboardList, Send, ListOrdered, LayoutTemplate,
  GitBranch, Phone, FileText, UserCheck, FolderKanban, Share2, Globe, Cpu, BarChart3, Sparkles, Settings,
  ChevronDown, ChevronUp, Flame,
} from 'lucide-react';

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  LayoutDashboard, Radar, Users, Search, ClipboardList, Send, ListOrdered, LayoutTemplate,
  GitBranch, Phone, FileText, UserCheck, FolderKanban, Share2, Globe, Cpu, BarChart3, Sparkles, Settings, Flame,
};

const NAV: { group: string; items: { href: string; label: string; icon: keyof typeof ICONS }[] }[] = [
  {
    group: 'Acquire',
    items: [
      { href: '/', label: 'Dashboard', icon: 'LayoutDashboard' },
      { href: '/discover', label: 'Discover', icon: 'Radar' },
      { href: '/prospects', label: 'Prospects', icon: 'Users' },
      { href: '/research', label: 'Intelligence', icon: 'Search' },
      { href: '/audits', label: 'Audits', icon: 'ClipboardList' },
    ],
  },
  {
    group: 'Engage',
    items: [
      { href: '/outreach', label: 'Outreach', icon: 'Send' },
      { href: '/sequences', label: 'Sequences', icon: 'ListOrdered' },
      { href: '/mockups', label: 'Concepts', icon: 'LayoutTemplate' },
    ],
  },
  {
    group: 'Convert',
    items: [
      { href: '/pipeline', label: 'Client Pipeline', icon: 'GitBranch' },
      { href: '/calls', label: 'Calls', icon: 'Phone' },
      { href: '/proposals', label: 'Proposals', icon: 'FileText' },
    ],
  },
  {
    group: 'Deliver & Grow',
    items: [
      { href: '/clients', label: 'Clients', icon: 'UserCheck' },
      { href: '/projects', label: 'Projects', icon: 'FolderKanban' },
      { href: '/social', label: 'Social', icon: 'Share2' },
      { href: '/websites', label: 'Websites', icon: 'Globe' },
    ],
  },
  {
    group: 'System',
    items: [
      { href: '/automation', label: 'Forge Automation', icon: 'Cpu' },
      { href: '/analytics', label: 'Analytics', icon: 'BarChart3' },
      { href: '/forge-ai', label: 'Forge AI', icon: 'Sparkles' },
      { href: '/settings', label: 'Settings', icon: 'Settings' },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <>
      <aside className={`sidebar${open ? ' open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            {/* Abstract forge motif — spark over an anvil line, not literal smithing */}
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 3 L15.5 9 L12 15 L8.5 9 Z" fill="#fff" opacity="0.95" />
              <path d="M4 18.5 H20" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
              <circle cx="12" cy="20.5" r="1" fill="#fff" opacity="0.6" />
            </svg>
          </div>
          <div>
            <div className="brand-name">
              ClientForge<span className="ai">AI</span>
            </div>
            <div className="brand-tag">Discover. Personalize. Convert. Deliver.</div>
          </div>
        </div>

        <nav style={{ flex: 1, paddingBottom: 8 }}>
          {NAV.map((group) => (
            <div className="nav-group" key={group.group}>
              <div className="nav-group-label">{group.group}</div>
              {group.items.map((item) => {
                const Icon = ICONS[item.icon];
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`nav-link${isActive(item.href) ? ' active' : ''}`}
                    onClick={() => setOpen(false)}
                  >
                    <Icon size={15} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <Link href="/action-queue" className="nav-link" style={{ border: '1px solid var(--border)' }}>
            <Flame size={15} />
            <span>Action Queue</span>
          </Link>
        </div>
      </aside>
      {open && <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 35 }} className="mobile-only" />}
      <MobileNavToggle open={open} onToggle={() => setOpen((v) => !v)} />
    </>
  );
}

function MobileNavToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className="btn btn-ghost mobile-only"
      onClick={onToggle}
      aria-label={open ? 'Close navigation' : 'Open navigation'}
      style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 50, boxShadow: 'var(--shadow-lg)', background: 'var(--surface)' }}
    >
      {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
    </button>
  );
}
