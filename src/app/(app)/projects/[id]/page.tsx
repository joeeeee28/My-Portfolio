import Link from 'next/link';
import { notFound } from 'next/navigation';
import { boot } from '@/lib/boot';
import { getSession } from '@/lib/session';
import { listProjects, listTasks, advanceProject } from '@/engine/crm';
import { get } from '@/db';
import { json } from '@/db';
import { relativeFromNow, formatDate } from '@/lib/time';
import { PROJECT_STAGE_LABELS, PROJECT_STAGES, type ProjectStage } from '@/lib/domain';
import { Card, Badge, Stats, Bar, SectionHead, Table, KeyValue } from '@/components/ui';
import { ActionButton } from '@/components/actions-client';
import * as A from '@/app/actions';

export const dynamic = 'force-dynamic';

export default async function ProjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const orgId = boot();
  await getSession();
  const { id } = await params;

  const project = get<{
    id: string; name: string; kind: string; stage: ProjectStage; status: string; progress: number;
    starts_at: string | null; due_at: string | null; budget: number | null; health: string; health_reason: string | null;
    requirements: string; deliverables: string; client_id: string; business_id: string; portal_token?: string;
  }>(
    `SELECT p.*, c.portal_token FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.id = ? AND p.org_id = ?`,
    [id, orgId]
  );
  if (!project) notFound();

  const tasks = listTasks(orgId, { projectId: id });
  const done = tasks.filter((t) => t.status === 'done').length;
  const overdue = tasks.filter((t) => t.status !== 'done' && t.due_at && new Date(t.due_at).getTime() < Date.now());
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const waitingClient = tasks.filter((t) => t.needs_client_input === 1 && t.status !== 'done');
  const requirements = json<string[]>(project.requirements, []);
  const deliverables = json<string[]>(project.deliverables, []);

  return (
    <>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h1>{project.name}</h1>
          <p className="small muted">
            {PROJECT_STAGE_LABELS[project.stage]} · {project.kind} · due {project.due_at ? formatDate(project.due_at) : '—'}
          </p>
        </div>
        <div className="spacer" />
        <Badge tone={project.health === 'delayed' ? 'critical' : project.health === 'at_risk' ? 'warning' : 'success'} dot>
          {project.health.replace(/_/g, ' ')}
        </Badge>
        <Link href={`/portal/${project.portal_token}`} target="_blank" className="btn btn-sm">
          Client portal
        </Link>
        <Link href={`/prospects/${project.business_id}`} className="btn btn-sm">
          Business Workspace
        </Link>
      </div>

      {project.health_reason && (
        <div className="mb-2">
          <div className="banner critical">
            <span className="banner-icon">⚠</span>
            <div>
              <strong>Delivery risk:</strong> {project.health_reason}
            </div>
          </div>
        </div>
      )}

      <Stats
        items={[
          { label: 'Progress', value: `${project.progress}%` },
          { label: 'Tasks complete', value: `${done}/${tasks.length}` },
          { label: 'Overdue', value: overdue.length, tone: overdue.length > 0 ? 'critical' : undefined },
          { label: 'Blocked', value: blocked.length, tone: blocked.length > 0 ? 'warning' : undefined },
          { label: 'Waiting on client', value: waitingClient.length, tone: waitingClient.length > 0 ? 'warning' : undefined },
          { label: 'Budget', value: project.budget ? `$${Number(project.budget).toLocaleString()}` : '—' },
        ]}
      />

      <SectionHead title="Delivery stages" hint="Click to advance — the client portal updates with it" />
      <Card>
        <div className="row-wrap">
          {PROJECT_STAGES.map((stage) => {
            const isCurrent = stage === project.stage;
            return (
              <ActionButton
                key={stage}
                action={A.advanceProjectAction}
                args={[project.id, stage]}
                label={PROJECT_STAGE_LABELS[stage]}
                variant={isCurrent ? 'primary' : 'ghost'}
              />
            );
          })}
        </div>
        <div className="mt-2">
          <Bar value={project.progress} tone={project.health === 'delayed' ? 'critical' : project.health === 'at_risk' ? 'warning' : undefined} />
        </div>
      </Card>

      <div className="grid grid-main mt-3">
        <div>
          <SectionHead title="Tasks" hint={`${done}/${tasks.length} complete`} />
          <Card tight>
            <Table
              head={[
                { label: 'Task' },
                { label: 'Stage' },
                { label: 'Due' },
                { label: 'Priority' },
                { label: 'Status' },
                { label: '' },
              ]}
            >
              {tasks.map((t) => {
                const isOverdue = t.status !== 'done' && t.due_at && new Date(t.due_at).getTime() < Date.now();
                return (
                  <tr key={t.id as string}>
                    <td>
                      <div className="small strong">{String(t.title)}</div>
                      {t.needs_client_input === 1 && <Badge tone="warning">needs client</Badge>}
                      {t.description && <div className="xsmall muted">{String(t.description)}</div>}
                    </td>
                    <td className="small">{String(t.stage ?? '').replace(/_/g, ' ')}</td>
                    <td className="xsmall" style={isOverdue ? { color: 'var(--critical)' } : undefined}>
                      {t.due_at ? relativeFromNow(t.due_at as string) : '—'}
                    </td>
                    <td>
                      <Badge tone={t.priority === 'critical' ? 'critical' : t.priority === 'high' ? 'warning' : ''}>{String(t.priority)}</Badge>
                    </td>
                    <td>
                      <Badge
                        tone={t.status === 'done' ? 'success' : t.status === 'blocked' ? 'critical' : t.status === 'in_progress' ? 'accent' : ''}
                      >
                        {String(t.status).replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {t.status !== 'done' && <ActionButton action={A.updateTaskAction} args={[t.id as string, { status: 'done' }]} label="Complete" />}
                        {t.status !== 'in_progress' && t.status !== 'done' && (
                          <ActionButton action={A.updateTaskAction} args={[t.id as string, { status: 'in_progress' }]} label="Start" />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </Card>
        </div>

        <aside className="col">
          <Card title="Requirements" sub="Captured from the call">
            {requirements.length === 0 ? (
              <p className="small muted">No requirements recorded yet. Summarise the call notes and they flow in automatically.</p>
            ) : (
              <ul className="col" style={{ gap: 5 }}>
                {requirements.map((r, i) => (
                  <li key={i} className="small">
                    • {r}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Deliverables">
            {deliverables.length === 0 ? (
              <p className="small muted">No deliverables recorded.</p>
            ) : (
              <ul className="col" style={{ gap: 5 }}>
                {deliverables.map((d, i) => (
                  <li key={i} className="small">
                    • {d}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
