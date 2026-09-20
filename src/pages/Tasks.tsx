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
  EmptyState,
  Tabs,
} from "@/components/ui";
import { Plus, CheckSquare, Trash2, Edit3, Calendar } from "lucide-react";
import { formatDate, TASK_STATUSES, PRIORITIES } from "@/lib/utils";

export default function Tasks() {
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [editTask, setEditTask] = useState<any>(null);
  const tasks = useQuery(api.tasks.list, {});
  const createTask = useMutation(api.tasks.create);
  const updateTask = useMutation(api.tasks.update);
  const removeTask = useMutation(api.tasks.remove);
  const completeTask = useMutation(api.tasks.complete);

  const [form, setForm] = useState({
    title: "",
    description: "",
    status: "todo",
    priority: "medium",
    dueDate: "",
    category: "",
    notes: "",
  });

  const handleSubmit = async () => {
    if (!form.title.trim()) return;
    if (editTask) {
      await updateTask({
        id: editTask._id,
        title: form.title,
        description: form.description || undefined,
        status: form.status,
        priority: form.priority,
        dueDate: form.dueDate
          ? new Date(form.dueDate).getTime()
          : undefined,
        category: form.category || undefined,
        notes: form.notes || undefined,
      });
    } else {
      await createTask({
        title: form.title,
        description: form.description || undefined,
        status: form.status,
        priority: form.priority,
        dueDate: form.dueDate
          ? new Date(form.dueDate).getTime()
          : undefined,
        category: form.category || undefined,
        notes: form.notes || undefined,
      });
    }
    setForm({
      title: "",
      description: "",
      status: "todo",
      priority: "medium",
      dueDate: "",
      category: "",
      notes: "",
    });
    setEditTask(null);
    setShowModal(false);
  };

  const openEdit = (task: any) => {
    setEditTask(task);
    setForm({
      title: task.title,
      description: task.description || "",
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate
        ? new Date(task.dueDate).toISOString().split("T")[0]
        : "",
      category: task.category || "",
      notes: task.notes || "",
    });
    setShowModal(true);
  };

  const filteredTasks =
    tasks?.filter((t: any) => {
      if (activeTab === "all") return true;
      return t.status === activeTab;
    }) || [];

  const sortedTasks = [...filteredTasks].sort((a, b) => {
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    return (
      (priorityOrder[a.priority as keyof typeof priorityOrder] || 2) -
      (priorityOrder[b.priority as keyof typeof priorityOrder] || 2)
    );
  });

  return (
    <div>
      <TopBar
        title="Tasks"
        subtitle={`${tasks?.length || 0} tasks total`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditTask(null);
              setForm({
                title: "",
                description: "",
                status: "todo",
                priority: "medium",
                dueDate: "",
                category: "",
                notes: "",
              });
              setShowModal(true);
            }}
          >
            <Plus size={14} />
            New Task
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl">
        <Tabs
          tabs={[
            { value: "all", label: "All" },
            { value: "inbox", label: "Inbox" },
            { value: "todo", label: "To Do" },
            { value: "in_progress", label: "In Progress" },
            { value: "completed", label: "Completed" },
          ]}
          active={activeTab}
          onChange={setActiveTab}
          className="mb-4"
        />

        {sortedTasks.length === 0 ? (
          <EmptyState
            icon={<CheckSquare size={24} />}
            title="No tasks found"
            description="Create your first task to get started"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Add Task
              </Button>
            }
          />
        ) : (
          <div className="space-y-2">
            {sortedTasks.map((task) => (
              <Card key={task._id} padding={false}>
                <div className="flex items-center gap-3 p-3">
                  <button
                    onClick={() => completeTask({ id: task._id })}
                    className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
                      task.status === "completed"
                        ? "bg-emerald-500 border-emerald-500"
                        : "border-slate-300 hover:border-brand-400"
                    }`}
                  >
                    {task.status === "completed" && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path
                          d="M3 6l2 2 4-4"
                          stroke="white"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p
                      className={`text-sm font-medium ${
                        task.status === "completed"
                          ? "text-slate-400 line-through"
                          : "text-slate-900"
                      }`}
                    >
                      {task.title}
                    </p>
                    {task.description && (
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {task.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {task.dueDate && (
                      <span className="text-xs text-slate-500 flex items-center gap-1">
                        <Calendar size={12} />
                        {formatDate(task.dueDate)}
                      </span>
                    )}
                    <Badge
                      variant={
                        task.priority === "urgent"
                          ? "danger"
                          : task.priority === "high"
                          ? "warning"
                          : task.priority === "medium"
                          ? "info"
                          : "neutral"
                      }
                    >
                      {task.priority}
                    </Badge>
                    {task.category && (
                      <Badge variant="neutral">{task.category}</Badge>
                    )}
                    <button
                      onClick={() => openEdit(task)}
                      className="p-1 rounded hover:bg-slate-100 text-slate-400"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      onClick={() => removeTask({ id: task._id })}
                      className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title={editTask ? "Edit Task" : "New Task"}
        >
          <div className="space-y-3">
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="What needs to be done?"
            />
            <Textarea
              label="Description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Add details..."
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Status"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                options={TASK_STATUSES.map((s) => ({
                  value: s.value,
                  label: s.label,
                }))}
              />
              <Select
                label="Priority"
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: e.target.value })
                }
                options={PRIORITIES.map((p) => ({
                  value: p.value,
                  label: p.label,
                }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Due Date"
                type="date"
                value={form.dueDate}
                onChange={(e) =>
                  setForm({ ...form, dueDate: e.target.value })
                }
              />
              <Input
                label="Category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
                placeholder="e.g., work, personal"
              />
            </div>
            <Textarea
              label="Notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Additional notes..."
            />
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              {editTask ? "Update" : "Create"} Task
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
