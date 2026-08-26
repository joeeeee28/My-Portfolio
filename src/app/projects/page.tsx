import Link from 'next/link';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listProjects, listTasks, assessDeliveryHealth } from '@/engine/crm';
import { relativeFromNow } from '@/lib/time';
import { PROJECT_STAGE_LABELS, type ProjectStage } from '@/lib/domain';
import { Card, Badge, EmptyState, SectionHead, Stats, Bar, Table } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';
import { FolderKanban } from 'lucide-react';

export const metadata = { title: 'Projects' };
export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const orgId = boot();
  await getSession();
  assessDeliveryHealth(orgId);
  const projects = listProjects(orgId, { limit: 100 });
  const tasks = listTasks(orgId, { limit: 300 });

  const active = projects.filter((p) => p.status === 'active');
  const delayed = projects.filter((p) => p.health === 'delayed');
  const atRisk = projects.filter((p) => p.health === 'at_risk');
  const overdueTasks = tasks.filter((t) => t.status !== 'done' && t.due_at && new Date(t.due_at).getTime() < Date.now());
  const clientBlocked = tasks.filter((t) => t.needs_client_input === 1 && t.status !== 'done');

  return (
    <>
      <div className="mb-2">
        <h1>Projects</h1>
        <p className="small muted">
          Delivery from onboarding to handover. Health is computed from real task state — overdue counts, blockers and client-waiting items — not
          declared.
        </p>
      </div>

      <Stats
        items={[
          { label: 'Active projects', value: active.length },
          { label: 'Delayed', value: delayed.length, tone: delayed.length > 0 ? 'critical' : undefined },
          { label: 'At risk', value: atRisk.length, tone: atRisk.length > 0 ? 'warning' : undefined },
          { label: 'Overdue tasks', value: overdueTasks.length, tone: overdueTasks.length > 0 ? 'critical' : undefined },
          { label: 'Waiting on client', value: clientBlocked.length, tone: clientBlocked.length > 0 ? 'warning' : undefined },
        ]}
      />

      {projects.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            icon={<FolderKanban size={17} />}
            title="No delivery projects"
            body="Projects are created automatically when a prospect converts to a client — with the full task breakdown, owners, due dates and dependencies already laid out."
            action={
              <Link href="/pipeline" className="btn btn-primary">
                Go to Client Pipeline
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <SectionHead title="Projects" />
          <div className="col">
            {projects.map((p) => {
              const projectTasks = tasks.filter((t) => t.project_id === p.id);
              const done = projectTasks.filter((t) => t.status === 'done').length;
              return (
                <Card
                  key={p.id}
                  title={
                    <Link href={`/projects/${p.id}`} style={{ color: 'var(--accent)' }}>
                      {p.name}
                    </Link>
                  }
                  sub={`${PROJECT_STAGE_LABELS[p.stage as ProjectStage] ?? p.stage} · ${p.kind} · due ${p.due_at ? relativeFromNow(p.due_at) : '—'}`}
                  actions={
                    <Badge tone={p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : p.status === 'complete' ? 'success' : ''} dot>
                      {p.health.replace(/_/g, ' ')}
                    </Badge>
                  }
                >
                  <div className="row" style={{ gap: 10 }}>
                    <div style={{ flex: 1 }}>
                      <Bar value={p.progress} tone={p.health === 'delayed' ? 'critical' : p.health === 'at_risk' ? 'warning' : undefined} />
                    </div>
                    <span className="small mono">{p.progress}%</span>
                    <span className="xsmall muted">
                      {done}/{projectTasks.length} tasks
                    </span>
                  </div>
                  {p.health_reason && <p className="xsmall mt-1" style={{ color: 'var(--critical)' }}>{p.health_reason}</p>}

                  <div className="row-wrap mt-2">
                    <Badge tone="outline">{p.open_tasks} open</Badge>
                    {p.overdue_tasks > 0 && <Badge tone="critical">{p.overdue_tasks} overdue</Badge>}
                    <span className="spacer" />
                    <ActionButton action={A.advanceProjectAction} args={[p.id, nextStage(p.stage as ProjectStage)]} label={`Advance to ${PROJECT_STAGE_LABELS[nextStage(p.stage as ProjectStage)] ?? 'next'}`} />
                  </div>
                </Card>
              );
            })}
          </div>

          {overdueTasks.length > 0 && (
            <>
              <SectionHead title="Overdue tasks" hint="Across all projects" />
              <Card tight>
                <Table compact head={[{ label: 'Task' }, { label: 'Project' }, { label: 'Stage' }, { label: 'Due' }, { label: 'Priority' }]}>
                  {overdueTasks.slice(0, 30).map((t) => (
                    <tr key={t.id as string}>
                      <td className="small">
                        {String(t.title)}
                        {t.needs_client_input === 1 && <Badge tone="warning">needs client</Badge>}
                      </td>
                      <td className="small muted">{String(t.project_name ?? '')}</td>
                      <td className="small">{String(t.stage ?? '')}</td>
                      <td className="xsmall" style={{ color: 'var(--critical)' }}>
                        {relativeFromNow(t.due_at as string)}
                      </td>
                      <td>
                        <Badge tone={t.priority === 'critical' ? 'critical' : t.priority === 'high' ? 'warning' : ''}>{String(t.priority)}</Badge>
                      </td>
                    </tr>
                  ))}
                </Table>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}

const STAGE_ORDER: ProjectStage[] = [
  'onboarding', 'requirements', 'design', 'development', 'content', 'testing',
  'client_review', 'revisions', 'approval', 'deployment', 'handover', 'complete',
];

function nextStage(current: ProjectStage): ProjectStage {
  const i = STAGE_ORDER.indexOf(current);
  return STAGE_ORDER[Math.min(STAGE_ORDER.length - 1, i + 1)] ?? 'onboarding';
}
