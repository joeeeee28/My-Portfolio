import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import {
  Card,
  Button,
  Modal,
  Input,
  Select,
  Textarea,
  Badge,
  ProgressBar,
  EmptyState,
} from "@/components/ui";
import { Plus, FolderKanban, Trash2 } from "lucide-react";

export default function Projects() {
  const [showModal, setShowModal] = useState(false);
  const projects = useQuery(api.projects.list, {});
  const createProject = useMutation(api.projects.create);
  const updateProject = useMutation(api.projects.update);
  const removeProject = useMutation(api.projects.remove);

  const [form, setForm] = useState({
    name: "",
    description: "",
    status: "planning",
    priority: "medium",
    deadline: "",
    category: "",
  });

  const handleSubmit = async () => {
    if (!form.name.trim()) return;
    await createProject({
      name: form.name,
      description: form.description || undefined,
      status: form.status,
      priority: form.priority,
      deadline: form.deadline
        ? new Date(form.deadline).getTime()
        : undefined,
      category: form.category || undefined,
    });
    setForm({
      name: "",
      description: "",
      status: "planning",
      priority: "medium",
      deadline: "",
      category: "",
    });
    setShowModal(false);
  };

  const statusColors: Record<string, string> = {
    planning: "bg-slate-100 text-slate-600",
    active: "bg-blue-50 text-blue-600",
    on_hold: "bg-amber-50 text-amber-600",
    completed: "bg-emerald-50 text-emerald-600",
    archived: "bg-slate-100 text-slate-400",
  };

  const statusOrder = ["active", "planning", "on_hold", "completed", "archived"];
  const sortedProjects = [...(projects || [])].sort(
    (a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
  );

  return (
    <div>
      <TopBar
        title="Projects"
        subtitle={`${projects?.length || 0} projects`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            <Plus size={14} />
            New Project
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl">
        {sortedProjects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban size={24} />}
            title="No projects yet"
            description="Create your first project to start tracking progress"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Create Project
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedProjects.map((project) => (
              <Card key={project._id}>
                <div className="flex items-start justify-between mb-3">
                  <Badge
                    variant={
                      project.status === "active"
                        ? "info"
                        : project.status === "completed"
                        ? "success"
                        : project.status === "on_hold"
                        ? "warning"
                        : "neutral"
                    }
                  >
                    {project.status.replace("_", " ")}
                  </Badge>
                  <button
                    onClick={() => removeProject({ id: project._id })}
                    className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <h4 className="text-sm font-semibold text-slate-900 mb-1">
                  {project.name}
                </h4>
                {project.description && (
                  <p className="text-xs text-slate-500 mb-3 line-clamp-2">
                    {project.description}
                  </p>
                )}
                <ProgressBar value={project.progress} />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-xs text-slate-500">
                    {project.progress}%
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      project.priority === "high"
                        ? "text-orange-500"
                        : project.priority === "low"
                        ? "text-slate-400"
                        : "text-slate-600"
                    }`}
                  >
                    {project.priority}
                  </span>
                </div>
                {project.deadline && (
                  <p className="text-[11px] text-slate-400 mt-2">
                    Due:{" "}
                    {new Date(project.deadline).toLocaleDateString()}
                  </p>
                )}
                <div className="flex gap-1 mt-3">
                  {statusOrder
                    .filter((s) => s !== project.status)
                    .slice(0, 3)
                    .map((s) => (
                      <button
                        key={s}
                        onClick={() =>
                          updateProject({ id: project._id, status: s })
                        }
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium transition-colors ${
                          statusColors[s]
                        } hover:opacity-80`}
                      >
                        {s.replace("_", " ")}
                      </button>
                    ))}
                </div>
              </Card>
            ))}
          </div>
        )}

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title="New Project"
        >
          <div className="space-y-3">
            <Input
              label="Project Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Project name"
            />
            <Textarea
              label="Description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Describe the project..."
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Status"
                value={form.status}
                onChange={(e) =>
                  setForm({ ...form, status: e.target.value })
                }
                options={[
                  { value: "planning", label: "Planning" },
                  { value: "active", label: "Active" },
                  { value: "on_hold", label: "On Hold" },
                ]}
              />
              <Select
                label="Priority"
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: e.target.value })
                }
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ]}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Deadline"
                type="date"
                value={form.deadline}
                onChange={(e) =>
                  setForm({ ...form, deadline: e.target.value })
                }
              />
              <Input
                label="Category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
                placeholder="e.g., career, personal"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              Create Project
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
