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
import { Plus, GraduationCap, Trash2, Clock } from "lucide-react";
import { formatDate } from "@/lib/utils";

export default function Learning() {
  const [showModal, setShowModal] = useState(false);
  const items = useQuery(api.learning.list, {});
  const createItem = useMutation(api.learning.create);
  const updateItem = useMutation(api.learning.update);
  const removeItem = useMutation(api.learning.remove);

  const [form, setForm] = useState({
    topic: "",
    course: "",
    resource: "",
    category: "",
    notes: "",
  });

  const handleSubmit = async () => {
    if (!form.topic.trim()) return;
    await createItem({
      topic: form.topic,
      course: form.course || undefined,
      resource: form.resource || undefined,
      category: form.category || undefined,
      notes: form.notes || undefined,
    });
    setForm({ topic: "", course: "", resource: "", category: "", notes: "" });
    setShowModal(false);
  };

  const statusColors: Record<string, string> = {
    not_started: "bg-slate-100 text-slate-600",
    in_progress: "bg-blue-50 text-blue-600",
    completed: "bg-emerald-50 text-emerald-600",
    paused: "bg-amber-50 text-amber-600",
  };

  const totalHours =
    items?.reduce((sum, item) => sum + item.hoursStudied, 0) || 0;
  const completedCount =
    items?.filter((i) => i.status === "completed").length || 0;

  return (
    <div>
      <TopBar
        title="Learning"
        subtitle={`${items?.length || 0} items · ${totalHours}h studied`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            <Plus size={14} />
            New Item
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card className="text-center py-4">
            <p className="text-2xl font-bold text-slate-900">
              {items?.length || 0}
            </p>
            <p className="text-xs text-slate-500">Total Items</p>
          </Card>
          <Card className="text-center py-4">
            <p className="text-2xl font-bold text-blue-600">{totalHours}h</p>
            <p className="text-xs text-slate-500">Hours Studied</p>
          </Card>
          <Card className="text-center py-4">
            <p className="text-2xl font-bold text-emerald-600">{completedCount}</p>
            <p className="text-xs text-slate-500">Completed</p>
          </Card>
        </div>

        {items?.length === 0 ? (
          <EmptyState
            icon={<GraduationCap size={24} />}
            title="No learning items yet"
            description="Track your courses, topics, and study progress"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Add Item
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {items?.map((item) => (
              <Card key={item._id}>
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="text-sm font-semibold text-slate-900">
                        {item.topic}
                      </h4>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium capitalize ${
                          statusColors[item.status] || ""
                        }`}
                      >
                        {item.status.replace("_", " ")}
                      </span>
                    </div>
                    {item.course && (
                      <p className="text-xs text-slate-500">{item.course}</p>
                    )}
                    <div className="mt-2">
                      <ProgressBar value={item.progress} />
                    </div>
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                      <span>{item.progress}% complete</span>
                      <span className="flex items-center gap-1">
                        <Clock size={12} />
                        {item.hoursStudied}h studied
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    {item.status !== "completed" && (
                      <button
                        onClick={() =>
                          updateItem({
                            id: item._id,
                            status:
                              item.status === "in_progress"
                                ? "completed"
                                : "in_progress",
                            progress:
                              item.status === "in_progress" ? 100 : undefined,
                          })
                        }
                        className="text-[10px] px-2 py-1 rounded bg-emerald-50 text-emerald-600 font-medium hover:bg-emerald-100"
                      >
                        {item.status === "in_progress"
                          ? "Complete"
                          : "Start"}
                      </button>
                    )}
                    <button
                      onClick={() => removeItem({ id: item._id })}
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
          title="New Learning Item"
        >
          <div className="space-y-3">
            <Input
              label="Topic"
              value={form.topic}
              onChange={(e) => setForm({ ...form, topic: e.target.value })}
              placeholder="What are you learning?"
            />
            <Input
              label="Course / Resource"
              value={form.course}
              onChange={(e) => setForm({ ...form, course: e.target.value })}
              placeholder="e.g., Frontend Masters course"
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
                placeholder="e.g., programming"
              />
              <Input
                label="URL"
                value={form.resource}
                onChange={(e) =>
                  setForm({ ...form, resource: e.target.value })
                }
                placeholder="https://..."
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              Add Item
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
