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
import { Plus, Target, Trash2 } from "lucide-react";
import { GOAL_CATEGORIES } from "@/lib/utils";

export default function Goals() {
  const [showModal, setShowModal] = useState(false);
  const goals = useQuery(api.goals.list);
  const createGoal = useMutation(api.goals.create);
  const updateGoal = useMutation(api.goals.update);
  const removeGoal = useMutation(api.goals.remove);

  const [form, setForm] = useState({
    title: "",
    description: "",
    category: "personal",
    targetDate: "",
    notes: "",
  });

  const handleSubmit = async () => {
    if (!form.title.trim()) return;
    await createGoal({
      title: form.title,
      description: form.description || undefined,
      category: form.category,
      startDate: Date.now(),
      targetDate: form.targetDate
        ? new Date(form.targetDate).getTime()
        : undefined,
      notes: form.notes || undefined,
    });
    setForm({
      title: "",
      description: "",
      category: "personal",
      targetDate: "",
      notes: "",
    });
    setShowModal(false);
  };

  const activeGoals = goals?.filter((g) => g.status === "active") || [];
  const completedGoals = goals?.filter((g) => g.status === "completed") || [];

  const categoryColors: Record<string, string> = {
    career: "bg-blue-500",
    finance: "bg-emerald-500",
    health: "bg-red-500",
    learning: "bg-purple-500",
    business: "bg-amber-500",
    personal: "bg-pink-500",
    relationships: "bg-cyan-500",
    other: "bg-slate-500",
  };

  return (
    <div>
      <TopBar
        title="Goals"
        subtitle={`${activeGoals.length} active goals`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            <Plus size={14} />
            New Goal
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl space-y-6">
        {activeGoals.length === 0 && completedGoals.length === 0 ? (
          <EmptyState
            icon={<Target size={24} />}
            title="No goals yet"
            description="Set your first goal to start tracking progress"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Create Goal
              </Button>
            }
          />
        ) : (
          <>
            {/* Active Goals */}
            {activeGoals.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-900 mb-3">
                  Active Goals
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {activeGoals.map((goal) => (
                    <Card key={goal._id}>
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <div
                            className={`w-3 h-3 rounded-full ${
                              categoryColors[goal.category] || "bg-slate-400"
                            }`}
                          />
                          <span className="text-xs font-medium text-slate-500 capitalize">
                            {goal.category}
                          </span>
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() =>
                              updateGoal({
                                id: goal._id,
                                status: "completed",
                                progress: 100,
                              })
                            }
                            className="p-1 rounded hover:bg-emerald-50 text-slate-400 hover:text-emerald-500"
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                            >
                              <path
                                d="M3 7l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </button>
                          <button
                            onClick={() => removeGoal({ id: goal._id })}
                            className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <h4 className="text-sm font-semibold text-slate-900 mb-1">
                        {goal.title}
                      </h4>
                      {goal.description && (
                        <p className="text-xs text-slate-500 mb-3 line-clamp-2">
                          {goal.description}
                        </p>
                      )}
                      <ProgressBar
                        value={goal.progress}
                        color={categoryColors[goal.category] || "bg-brand-500"}
                      />
                      <div className="flex items-center justify-between mt-2">
                        <span className="text-xs text-slate-500">
                          {goal.progress}% complete
                        </span>
                        {goal.targetDate && (
                          <span className="text-xs text-slate-400">
                            Target:{" "}
                            {new Date(goal.targetDate).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                      {goal.milestones && goal.milestones.length > 0 && (
                        <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                          {goal.milestones.map((m, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-2 text-xs"
                            >
                              <div
                                className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                                  m.completed
                                    ? "bg-emerald-500 border-emerald-500"
                                    : "border-slate-300"
                                }`}
                              >
                                {m.completed && (
                                  <svg
                                    width="8"
                                    height="8"
                                    viewBox="0 0 8 8"
                                    fill="none"
                                  >
                                    <path
                                      d="M2 4l1.5 1.5 3-3"
                                      stroke="white"
                                      strokeWidth="1.5"
                                      strokeLinecap="round"
                                    />
                                  </svg>
                                )}
                              </div>
                              <span
                                className={
                                  m.completed
                                    ? "text-slate-400 line-through"
                                    : "text-slate-700"
                                }
                              >
                                {m.title}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Completed Goals */}
            {completedGoals.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-slate-500 mb-3">
                  Completed
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {completedGoals.map((goal) => (
                    <Card key={goal._id} className="opacity-70">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center">
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 10 10"
                            fill="none"
                          >
                            <path
                              d="M2.5 5l2 2 3.5-3.5"
                              stroke="white"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                            />
                          </svg>
                        </div>
                        <h4 className="text-sm font-medium text-slate-700 line-through">
                          {goal.title}
                        </h4>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title="New Goal"
        >
          <div className="space-y-3">
            <Input
              label="Goal Title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="What do you want to achieve?"
            />
            <Textarea
              label="Description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Describe your goal..."
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
                options={GOAL_CATEGORIES.map((c) => ({
                  value: c,
                  label: c.charAt(0).toUpperCase() + c.slice(1),
                }))}
              />
              <Input
                label="Target Date"
                type="date"
                value={form.targetDate}
                onChange={(e) =>
                  setForm({ ...form, targetDate: e.target.value })
                }
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              Create Goal
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
