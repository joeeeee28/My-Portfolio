import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listWebsites } from '@/engine/crm';
import { getHostingProvider } from '@/lib/providers/registry';
import { providers } from '@/lib/providers/registry';
import { relativeFromNow } from '@/lib/time';
import { Card, Badge, EmptyState, SectionHead, Stats, Table } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { Globe, AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Websites' };
export const dynamic = 'force-dynamic';

export default async function WebsitesPage() {
  const orgId = boot();
  await getSession();
  const websites = listWebsites(orgId);
  const hostingOptions = providers.hosting;
  const configured = hostingOptions.filter((h) => !h.requiresCredentials || h.supportsCustomDomains);

  return (
    <>
      <div className="mb-2">
        <h1>Websites</h1>
        <p className="small muted">
          Hosting, domains and deployments. Without an external host configured, sites are served in-app and marked as such — ClientForge never
          reports a production deployment that did not happen.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Sites', value: websites.length },
          { label: 'Live', value: websites.filter((w) => w.status === 'live').length, tone: 'success' },
          { label: 'Preview only', value: websites.filter((w) => w.status === 'preview').length, tone: 'warning' },
          { label: 'Domains attached', value: websites.reduce((a, w) => a + (w.domains as unknown[]).length, 0) },
        ]}
      />

      {websites.filter((w) => (w.latest_deployment as { simulated?: number } | null)?.simulated === 1).length > 0 && (
        <div className="mt-2">
          <div className="banner warning">
            <span className="banner-icon">
              <AlertTriangle size={15} />
            </span>
            <div>
              Some sites are served by the built-in preview host. That is a real, viewable URL, but it is not a production CDN. Connect Vercel,
              Netlify or GitHub Pages in Settings → Integrations for public hosting with automatic SSL.
            </div>
          </div>
        </div>
      )}

      {websites.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<Globe size={17} />}
            title="No published websites yet"
            body="Publish a Website Concept from the Concepts screen. The concept becomes a versioned website record with deployment history and rollback."
            action={
              <Link href="/mockups" className="btn btn-primary">
                Go to Concepts
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Sites" />
          <Card tight>
            <Table
              head={[
                { label: 'Site' },
                { label: 'Status' },
                { label: 'Version', align: 'right' },
                { label: 'Host' },
                { label: 'URL' },
                { label: 'Domains' },
                { label: 'Last deployment' },
                { label: '' },
              ]}
            >
              {websites.map((w) => {
                const dep = w.latest_deployment as { status: string; simulated: number; url: string | null; error: string | null; created_at: string } | null;
                const domains = w.domains as { hostname: string; status: string; ssl: string }[];
                return (
                  <tr key={w.id}>
                    <td>
                      <div className="strong small">{w.name}</div>
                      <div className="xsmall muted">{w.business_name}</div>
                    </td>
                    <td>
                      <Badge tone={w.status === 'live' ? 'success' : w.status === 'preview' ? 'warning' : ''} dot>
                        {w.status}
                      </Badge>
                    </td>
                    <td className="num small mono">v{w.current_version}</td>
                    <td className="small">{w.hosting_provider ?? '—'}</td>
                    <td className="small">
                      {w.live_url ? (
                        <a href={w.live_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                          {w.live_url}
                        </a>
                      ) : w.preview_url ? (
                        <Link href={w.preview_url} target="_blank" style={{ color: 'var(--accent)' }}>
                          {w.preview_url} (in-app)
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {domains.length === 0 ? (
                        <span className="xsmall muted">none</span>
                      ) : (
                        <div className="row-wrap" style={{ gap: 4 }}>
                          {domains.map((d) => (
                            <Badge key={d.hostname} tone={d.status === 'active' ? 'success' : 'warning'}>
                              {d.hostname} · {d.status}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="xsmall muted">
                      {dep ? (
                        <>
                          <Badge tone={dep.status === 'deployed' ? 'success' : dep.status === 'failed' ? 'critical' : 'warning'}>{dep.status}</Badge>
                          {dep.simulated === 1 && <Badge tone="warning">simulated</Badge>}
                          <div>{relativeFromNow(dep.created_at)}</div>
                          {dep.error && <div style={{ color: 'var(--critical)' }}>{dep.error}</div>}
                        </>
                      ) : (
                        'never'
                      )}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <ActionButton action={A.deployWebsiteAction} args={[w.id]} label="Deploy" />
                        <ActionButton action={A.deployWebsiteAction} args={[w.id, 'example.com']} label="Attach domain" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </>
      )}

      <SectionHead title="Hosting providers" hint="Integration-ready — configure credentials in Settings" />
      <Card tight>
        <Table head={[{ label: 'Provider' }, { label: 'Custom domains' }, { label: 'SSL' }, { label: 'Credentials' }, { label: 'State' }]}>
          {hostingOptions.map((h) => {
            const ready = !h.requiresCredentials || !!process.env[`HOST_${h.key.toUpperCase().replace(/[^A-Z]/g, '_')}`];
            return (
              <tr key={h.key}>
                <td>
                  <div className="strong small">{h.label}</div>
                  <div className="xsmall muted" style={{ maxWidth: 420 }}>
                    {h.description}
                  </div>
                </td>
                <td>{h.supportsCustomDomains ? <Badge tone="success">yes</Badge> : <span className="xsmall muted">no</span>}</td>
                <td>{h.supportsSsl ? <Badge tone="success">automatic</Badge> : <span className="xsmall muted">—</span>}</td>
                <td className="small">{h.requiresCredentials ? (h.credentialLabel ?? 'token required') : 'none needed'}</td>
                <td>
                  <Badge tone={h.requiresCredentials ? 'warning' : 'success'} dot>
                    {h.requiresCredentials ? 'needs key' : 'ready'}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
