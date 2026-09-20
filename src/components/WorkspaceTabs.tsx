'use client';

import { useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';

export interface Panel {
  key: string;
  label: string;
  content: React.ReactNode;
}

/**
 * Business Workspace tabs (§60). The tab is held in the URL so a workspace
 * section is directly linkable from the Action Queue and notifications.
 */
export function WorkspaceTabs({ panels }: { panels: Panel[] }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initial = params.get('tab');
  const [active, setActive] = useState(panels.some((p) => p.key === initial) ? (initial as string) : panels[0].key);

  const select = (key: string) => {
    setActive(key);
    const next = new URLSearchParams(params.toString());
    next.set('tab', key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const current = panels.find((p) => p.key === active) ?? panels[0];

  return (
    <div>
      <div className="tabs">
        {panels.map((p) => (
          <button key={p.key} className={`tab${p.key === current.key ? ' active' : ''}`} onClick={() => select(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="mt-2">{current.content}</div>
    </div>
  );
}
