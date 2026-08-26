import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { getSettings, listUsers } from '@/lib/settings';
import { getActiveProfile } from '@/engine/scoring';
import { integrationInventory, listSources } from '@/lib/providers/registry';
import { listSecrets, masterKeySource } from '@/lib/secrets';
import { listModels, listTaskRoutes, modelComparison } from '@/lib/ai/router';
import { listJobs } from '@/engine/scheduler';
import { complianceSummary, listSuppression } from '@/engine/compliance';
import { get, json, all } from '@/db';
import { SCORING_FACTORS, AI_TASK_LABELS, ROLE_LABELS, type Role } from '@/lib/domain';
import { AI_TASKS } from '@/lib/domain';
import { SERVICE_CATALOGUE } from '@/lib/brand';
import { Card, Badge, SectionHead, Stats, Table, Banner, KeyValue } from '@/components/ui';
import { ActionButton, InlineForm, CsvImporter } from '@/components/actions-client';
import * as A from '@/app/actions';
import * as F from '@/app/form-actions';
import { ShieldCheck, KeyRound } from 'lucide-react';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const orgId = boot();
  const session = await getSession();
  const settings = getSettings(orgId);
  const profile = getActiveProfile(orgId);
  const sources = listSources(orgId);
  const integrations = integrationInventory(orgId);
  const secrets = listSecrets(orgId);
  const models = listModels(orgId);
  const routes = listTaskRoutes(orgId);
  const jobs = listJobs(orgId);
  const users = listUsers(orgId);
  const compliance = complianceSummary(orgId);
  const suppression = listSuppression(orgId, 50);
  const icp = get<{ id: string; preferred_industries: string; min_opportunity_score: number; services: string; digital_problems: string }>(
    'SELECT * FROM icp_profiles WHERE org_id = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1',
    [orgId]
  );

  return (
    <>
      <div className="mb-2">
        <h1>Settings</h1>
        <p className="small muted">Scoring, Ideal Customer Profile, sources, integrations, AI models, automation and compliance.</p>
      </div>

      {/* ── Scoring ─────────────────────────────────────────── */}
      <SectionHead title="Opportunity Score model" hint="Weights are normalised to 100%" />
      <Card>
        <InlineForm action={F.formSaveScoring} submitLabel="Save & re-score all prospects">
          <input type="hidden" name="factors" value={SCORING_FACTORS.map((f) => f.key).join(',')} />
          <div className="grid grid-3">
            {SCORING_FACTORS.map((f) => (
              <div className="field" key={f.key}>
                <label className="label" htmlFor={f.key}>
                  {f.label} — {Math.round((profile.weights[f.key] ?? f.defaultWeight) * 100)}%
                </label>
                <input
                  className="input"
                  id={f.key}
                  name={f.key}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  defaultValue={Math.round((profile.weights[f.key] ?? f.defaultWeight) * 100)}
                />
              </div>
            ))}
          </div>
          <p className="hint">Enter percentages. They are normalised so the total is always 100%.</p>
        </InlineForm>

        {profile.rules.length > 0 && (
          <div className="mt-3">
            <div className="xsmall muted mb-1">Custom scoring rules</div>
            <ul className="col" style={{ gap: 6 }}>
              {profile.rules.map((r) => (
                <li key={r.id} className="row" style={{ gap: 8 }}>
                  <Badge tone={r.enabled ? 'accent' : ''}>{r.bonus > 0 ? `+${r.bonus}` : r.bonus}</Badge>
                  <span className="small">{r.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {/* ── ICP ─────────────────────────────────────────────── */}
      <SectionHead title="Ideal Customer Profile" hint="Learned from realised outcomes as well as your settings" />
      <Card>
        <InlineForm action={F.formSaveIcp} submitLabel="Save ICP">
          <div className="grid grid-3">
            <div className="field">
              <label className="label" htmlFor="industries">
                Preferred industries (comma-separated)
              </label>
              <input className="input" id="industries" name="industries" defaultValue={json<string[]>(icp?.preferred_industries ?? '[]', []).join(', ')} />
            </div>
            <div className="field">
              <label className="label" htmlFor="minScore">
                Minimum Opportunity Score
              </label>
              <input className="input" id="minScore" name="minScore" type="number" min={0} max={100} defaultValue={icp?.min_opportunity_score ?? 55} />
            </div>
            <div className="field">
              <label className="label" htmlFor="services">
                Services offered
              </label>
              <input className="input" id="services" name="services" defaultValue={json<string[]>(icp?.services ?? '[]', []).join(', ')} />
            </div>
          </div>
        </InlineForm>
        <p className="hint mt-1">
          The platform is service-agnostic. Website Development and Social Media Management are the current focus, but any service can be added here
          and in the package engine.
        </p>
      </Card>

      {/* ── Discovery settings ──────────────────────────────── */}
      <SectionHead title="Forge Automation" hint="Schedule and thresholds" />
      <Card>
        <InlineForm action={F.formSaveDiscovery} submitLabel="Save">
          <div className="grid grid-3">
            <div className="field">
              <label className="label" htmlFor="schedule">
                Schedule
              </label>
              <select className="select" id="schedule" name="schedule" defaultValue={settings.discovery.schedule}>
                {['daily', 'weekly', 'manual', 'custom'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="cron">
                Cron (default 0 2 * * * — daily at 02:00)
              </label>
              <input className="input mono" id="cron" name="cron" defaultValue={settings.discovery.cron} />
            </div>
            <div className="field">
              <label className="label" htmlFor="ttl">
                Audit cache TTL (hours)
              </label>
              <input className="input" id="ttl" name="ttl" type="number" min={1} defaultValue={settings.discovery.cacheTtlHours} />
            </div>
            <div className="field">
              <label className="label" htmlFor="minQualify">
                Min score to qualify
              </label>
              <input className="input" id="minQualify" name="minQualify" type="number" min={0} max={100} defaultValue={settings.discovery.minScoreToQualify} />
            </div>
            <div className="field">
              <label className="label" htmlFor="minMockup">
                Min score to generate a concept
              </label>
              <input className="input" id="minMockup" name="minMockup" type="number" min={0} max={100} defaultValue={settings.discovery.minScoreToMockup} />
            </div>
          </div>
          <div className="row-wrap mt-1">
            <label className="switch">
              <input type="checkbox" name="autoQualify" defaultChecked={settings.discovery.autoQualify} /> Auto-qualify
            </label>
            <label className="switch">
              <input type="checkbox" name="autoMockup" defaultChecked={settings.discovery.autoMockup} /> Auto-generate concepts
            </label>
            <label className="switch">
              <input type="checkbox" name="autoDrafts" defaultChecked={settings.discovery.autoOutreachDrafts} /> Auto-draft outreach
            </label>
          </div>
        </InlineForm>

        <div className="mt-3">
          <Table compact head={[{ label: 'Job' }, { label: 'Cron' }, { label: 'Enabled' }, { label: 'Last' }, { label: '' }]}>
            {jobs.map((j) => (
              <tr key={j.key}>
                <td className="small">{j.label}</td>
                <td className="mono xsmall">{j.cron}</td>
                <td>
                  <Badge tone={j.enabled === 1 ? 'success' : ''}>{j.enabled === 1 ? 'on' : 'off'}</Badge>
                </td>
                <td className="xsmall muted">{j.last_run_at ? new Date(j.last_run_at).toLocaleString() : 'never'}</td>
                <td>
                  <ActionButton action={A.updateJobAction} args={[j.key, { enabled: j.enabled !== 1 }]} label={j.enabled === 1 ? 'Pause' : 'Enable'} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      </Card>

      {/* ── Outreach & compliance ───────────────────────────── */}
      <SectionHead title="Outreach controls" hint="Rate limits, quiet hours and approval mode" />
      <Card>
        <InlineForm action={F.formSaveOutreach} submitLabel="Save">
          <div className="grid grid-3">
            <div className="field">
              <label className="label" htmlFor="approvalMode">
                Approval mode
              </label>
              <select className="select" id="approvalMode" name="approvalMode" defaultValue={settings.outreach.approvalMode}>
                <option value="manual">Manual — drafts only, never sends</option>
                <option value="assisted">Assisted — drafts, you approve each send</option>
                <option value="autonomous">Autonomous — sends within limits</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="dailyLimit">
                Daily send limit
              </label>
              <input className="input" id="dailyLimit" name="dailyLimit" type="number" min={1} defaultValue={settings.outreach.dailySendLimit} />
            </div>
            <div className="field">
              <label className="label" htmlFor="domainLimit">
                Per-domain daily limit
              </label>
              <input className="input" id="domainLimit" name="domainLimit" type="number" min={1} defaultValue={settings.outreach.domainDailyLimit} />
            </div>
            <div className="field">
              <label className="label" htmlFor="quietStart">
                Quiet hours start
              </label>
              <input className="input mono" id="quietStart" name="quietStart" defaultValue={settings.outreach.quietHoursStart} />
            </div>
            <div className="field">
              <label className="label" htmlFor="quietEnd">
                Quiet hours end
              </label>
              <input className="input mono" id="quietEnd" name="quietEnd" defaultValue={settings.outreach.quietHoursEnd} />
            </div>
            <div className="field">
              <label className="label" htmlFor="retention">
                Data retention (days)
              </label>
              <input className="input" id="retention" name="retention" type="number" min={30} defaultValue={settings.compliance.retentionDays} />
            </div>
          </div>
          <div className="row-wrap mt-1">
            <label className="switch">
              <input type="checkbox" name="requireConsent" defaultChecked={settings.outreach.requireConsent} /> Require recorded consent
            </label>
            <label className="switch">
              <input type="checkbox" name="dupeProtect" defaultChecked={settings.outreach.duplicateProtection} /> Duplicate protection
            </label>
            <label className="switch">
              <input type="checkbox" name="includeUnsub" defaultChecked={settings.compliance.includeUnsubscribe} /> Include unsubscribe link
            </label>
            <label className="switch">
              <input type="checkbox" name="honourDnc" defaultChecked={settings.compliance.honourDoNotContact} /> Honour do-not-contact
            </label>
          </div>
        </InlineForm>

        <div className="mt-3">
          <Stats
            items={[
              { label: 'Suppression list', value: compliance.suppressionCount },
              { label: 'Opted out / DNC', value: compliance.optedOut, tone: compliance.optedOut > 0 ? 'warning' : undefined },
              { label: 'Consent unknown', value: compliance.consentUnknown },
              { label: 'Opted in', value: compliance.optedIn, tone: 'success' },
            ]}
          />
        </div>

        {suppression.length > 0 && (
          <div className="mt-2">
            <Table compact head={[{ label: 'Type' }, { label: 'Value' }, { label: 'Reason' }, { label: 'Source' }]}>
              {suppression.map((s) => (
                <tr key={s.id}>
                  <td className="small">{String(s.kind)}</td>
                  <td className="small mono">{String(s.value)}</td>
                  <td className="small">{String(s.reason)}</td>
                  <td className="xsmall muted">{String(s.source)}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      {/* ── Sources & integrations ──────────────────────────── */}
      <SectionHead title="Discovery sources" hint="Enable the ones you have credentials for" />
      <Card tight>
        <Table head={[{ label: 'Source' }, { label: 'Category' }, { label: 'Credentials' }, { label: 'State' }, { label: '' }]}>
          {sources.map((s) => (
            <tr key={s.provider_key}>
              <td>
                <div className="small strong">{s.label}</div>
                <div className="xsmall muted">{s.provider_key}</div>
              </td>
              <td>
                <Badge tone="outline">{s.category}</Badge>
              </td>
              <td className="small">
                {s.requires_credentials === 0 ? <Badge tone="success">none needed</Badge> : s.credentials_ready === 1 ? <Badge tone="success">stored</Badge> : <Badge tone="warning">required</Badge>}
              </td>
              <td>
                <Badge tone={s.usable ? 'success' : s.enabled === 1 ? 'critical' : ''} dot>
                  {s.usable ? 'ready' : s.enabled === 1 ? 'blocked' : 'disabled'}
                </Badge>
              </td>
              <td>
                <ActionButton action={A.setSourceEnabledAction} args={[s.provider_key, s.enabled !== 1]} label={s.enabled === 1 ? 'Disable' : 'Enable'} />
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <SectionHead title="Integrations" hint="Credentials are encrypted at rest and never returned to the browser" />
      {masterKeySource() === 'file' && (
        <div className="mb-2">
          <Banner tone="warning" icon={<KeyRound size={15} />}>
            Using a locally generated master key at <code>.data/master.key</code>. For production set <code>OS_MASTER_KEY</code> so credentials can be
            decrypted across deployments.
          </Banner>
        </div>
      )}
      <Card tight>
        <Table head={[{ label: 'Provider' }, { label: 'Kind' }, { label: 'Credentials' }, { label: 'State' }, { label: 'Store credential' }]}>
          {integrations.map((i) => (
            <tr key={`${i.kind}:${i.key}`}>
              <td>
                <div className="small strong">{i.label}</div>
                <div className="xsmall muted" style={{ maxWidth: 380 }}>
                  {i.description}
                </div>
              </td>
              <td>
                <Badge tone="outline">{i.kind}</Badge>
              </td>
              <td className="xsmall">{i.requiresCredentials ? 'required' : 'none needed'}</td>
              <td>
                <Badge tone={i.configured ? 'success' : i.requiresCredentials ? 'warning' : 'success'} dot>
                  {i.configured ? 'configured' : i.requiresCredentials ? 'not configured' : 'ready'}
                </Badge>
              </td>
              <td>
                {i.requiresCredentials && (
                  <InlineForm action={F.formSetSecret} submitLabel="Store">
                    <input type="hidden" name="providerKey" value={i.key} />
                    <input type="hidden" name="label" value={i.label} />
                    <input className="input" name="value" type="password" placeholder="API key / token" required />
                  </InlineForm>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      {secrets.length > 0 && (
        <div className="mt-2">
          <Card title="Stored credentials" sub="Masked — the plaintext never leaves the server" tight>
            <Table compact head={[{ label: 'Provider' }, { label: 'Last 4' }, { label: 'Verified' }, { label: '' }]}>
              {secrets.map((s) => (
                <tr key={String(s.id)}>
                  <td className="small">{s.label}</td>
                  <td className="mono small">••••{s.last4}</td>
                  <td className="xsmall muted">{s.verified_at ? new Date(s.verified_at).toLocaleDateString() : 'not verified'}</td>
                  <td>
                    <ActionButton action={A.deleteSecretAction} args={[s.provider_key]} label="Remove" variant="danger" confirm="Remove this credential?" />
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </div>
      )}

      {/* ── AI models ───────────────────────────────────────── */}
      <SectionHead
        title="AI model routing"
        hint="No task is hard-coded to a model — each is routed by quality, cost, latency and reliability"
        right={<ActionButton action={A.runEvaluationAction} args={[]} label="Run benchmark" />}
      />
      <Card tight>
        <Table head={[{ label: 'Task' }, { label: 'Priority' }, { label: 'Selected model' }, { label: 'Why' }, { label: 'Route' }]}>
          {routes.map((r) => (
            <tr key={r.id}>
              <td className="small strong">{r.label}</td>
              <td>
                <Badge tone="outline">{r.priority}</Badge>
              </td>
              <td className="small">
                {r.selected.modelLabel}
                {r.selected.live ? <Badge tone="success">live</Badge> : <Badge tone="warning">local</Badge>}
              </td>
              <td className="xsmall muted" style={{ maxWidth: 340 }}>
                {r.selected.reason}
              </td>
              <td>
                <InlineForm action={F.formSetTaskRoute} submitLabel="Set">
                  <input type="hidden" name="task" value={r.task} />
                  <input type="hidden" name="priority" value={r.priority} />
                  <select className="select" name="model" defaultValue="">
                    <option value="">Auto (best match)</option>
                    {models.filter((m) => m.usable).map((m) => (
                      <option key={m.id} value={m.model_id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </InlineForm>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="mt-2">
        <Card title="Available models" tight>
          <Table compact head={[{ label: 'Model' }, { label: 'Provider' }, { label: 'Tier' }, { label: 'Quality', align: 'right' }, { label: 'Latency', align: 'right' }, { label: 'Cost /1k', align: 'right' }, { label: 'State' }]}>
            {models.map((m) => (
              <tr key={m.id}>
                <td className="small">{m.label}</td>
                <td className="xsmall muted">{m.provider_key}</td>
                <td>
                  <Badge tone="outline">{m.tier}</Badge>
                </td>
                <td className="num small">{Math.round(m.quality_score * 100)}</td>
                <td className="num small">{m.speed_ms}ms</td>
                <td className="num small">${(m.cost_per_1k_in + m.cost_per_1k_out).toFixed(5)}</td>
                <td>
                  <Badge tone={m.usable ? 'success' : ''} dot>
                    {m.usable ? 'usable' : m.enabled === 0 ? 'disabled' : 'needs key'}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      {/* ── Team & security ─────────────────────────────────── */}
      <SectionHead title="Team & access" hint="Role-based permissions" />
      <Card tight>
        <Table head={[{ label: 'User' }, { label: 'Role' }, { label: 'Last login' }]}>
          {users.map((u) => (
            <tr key={u.id}>
              <td>
                <div className="small strong">{u.name}</div>
                <div className="xsmall muted">{u.email}</div>
              </td>
              <td>
                <Badge tone={u.role === 'owner' ? 'accent' : ''}>{ROLE_LABELS[u.role as Role] ?? u.role}</Badge>
              </td>
              <td className="xsmall muted">{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <SectionHead title="Data" />
      <Card>
        <KeyValue
          items={[
            { label: 'Workspace', value: orgId },
            { label: 'Signed in as', value: `${session.name} (${session.role})` },
            { label: 'Master key source', value: masterKeySource() === 'env' ? 'OS_MASTER_KEY (recommended)' : 'local file' },
          ]}
        />
        <div className="row-wrap mt-2">
          <ActionButton action={A.seedDemoAction} args={[]} label="Seed demo data" confirm="Create demo businesses? They are clearly marked as demo data and never presented as real discoveries." />
          <Link href="/prospects" className="btn btn-sm">
            Export from Prospect Hub
          </Link>
        </div>
      </Card>
    </>
  );
}
