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
  EmptyState,
  Badge,
} from "@/components/ui";
import { Plus, Repeat, Check, Trash2 } from "lucide-react";
import { getStartOfDay } from "@/lib/utils";

export default function Habits() {
  const [showModal, setShowModal] = useState(false);
  const habits = useQuery(api.habits.list, {});
  const completions = useQuery(api.habits.getCompletions, {
    startDate: Date.now() - 7 * 86400000,
    endDate: Date.now(),
  });
  const createHabit = useMutation(api.habits.create);
  const removeHabit = useMutation(api.habits.remove);
  const toggleCompletion = useMutation(api.habits.toggleCompletion);

  const [form, setForm] = useState({
    name: "",
    description: "",
    frequency: "daily",
    target: 1,
    category: "",
    color: "#3b82f6",
  });

  const todayStart = getStartOfDay();
  const todayCompletions =
    completions?.filter(
      (c: any) => c.date === todayStart && c.completed
    ) || [];

  const isCompletedToday = (habitId: string) =>
    todayCompletions.some((c) => c.habitId === habitId);

  const handleSubmit = async () => {
    if (!form.name.trim()) return;
    await createHabit({
      name: form.name,
      description: form.description || undefined,
      frequency: form.frequency,
      target: form.target,
      category: form.category || undefined,
      color: form.color,
    });
    setForm({
      name: "",
      description: "",
      frequency: "daily",
      target: 1,
      category: "",
      color: "#3b82f6",
    });
    setShowModal(false);
  };

  const streak = (habitId: string) => {
    let count = 0;
    const today = getStartOfDay();
    for (let i = 0; i < 30; i++) {
      const day = today - i * 86400000;
      const completed = completions?.some(
        (c) => c.habitId === habitId && c.date === day && c.completed
      );
      if (completed) count++;
      else break;
    }
    return count;
  };

  const totalCompleted = todayCompletions.length;
  const totalHabits = habits?.length || 0;
  const completionRate =
    totalHabits > 0 ? Math.round((totalCompleted / totalHabits) * 100) : 0;

  return (
    <div>
      <TopBar
        title="Habits"
        subtitle={`${totalCompleted}/${totalHabits} completed today (${completionRate}%)`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            <Plus size={14} />
            New Habit
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl">
        {habits?.length === 0 ? (
          <EmptyState
            icon={<Repeat size={24} />}
            title="No habits yet"
            description="Start building good habits by creating your first one"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Create Habit
              </Button>
            }
          />
        ) : (
          <div className="space-y-3">
            {habits?.map((habit: any) => {
              const completed = isCompletedToday(habit._id);
              const streakCount = streak(habit._id);
              return (
                <Card key={habit._id}>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() =>
                        toggleCompletion({
                          habitId: habit._id,
                          date: todayStart,
                        })
                      }
                      className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
                        completed
                          ? "bg-emerald-500 text-white scale-105"
                          : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                      }`}
                    >
                      {completed ? <Check size={20} /> : <Repeat size={18} />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <h4
                        className={`text-sm font-semibold ${
                          completed ? "text-slate-400" : "text-slate-900"
                        }`}
                      >
                        {habit.name}
                      </h4>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-slate-500 capitalize">
                          {habit.frequency}
                        </span>
                        {habit.category && (
                          <Badge variant="neutral">{habit.category}</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-lg font-bold text-slate-900">
                        {streakCount}
                      </p>
                      <p className="text-[10px] text-slate-500 uppercase tracking-wide">
                        day streak
                      </p>
                    </div>
                    {/* Weekly view */}
                    <div className="hidden sm:flex items-center gap-1">
                      {[...Array(7)].map((_, i) => {
                        const day = getStartOfDay() - (6 - i) * 86400000;
                        const dayDone = completions?.some(
                          (c) =>
                            c.habitId === habit._id &&
                            c.date === day &&
                            c.completed
                        );
                        return (
                          <div
                            key={i}
                            className={`w-6 h-6 rounded-md text-[9px] flex items-center justify-center font-medium ${
                              dayDone
                                ? "bg-emerald-500 text-white"
                                : "bg-slate-100 text-slate-400"
                            }`}
                          >
                            {new Date(day).toLocaleDateString("en", {
                              weekday: "narrow",
                            })}
                          </div>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => removeHabit({ id: habit._id })}
                      className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title="New Habit"
        >
          <div className="space-y-3">
            <Input
              label="Habit Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g., Exercise, Read, Meditate"
            />
            <Input
              label="Description (optional)"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Frequency"
                value={form.frequency}
                onChange={(e) =>
                  setForm({ ...form, frequency: e.target.value })
                }
                options={[
                  { value: "daily", label: "Daily" },
                  { value: "weekly", label: "Weekly" },
                  { value: "specific", label: "Specific Days" },
                ]}
              />
              <Input
                label="Category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
                placeholder="e.g., wellness"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">
                Color
              </label>
              <div className="flex gap-2">
                {[
                  "#22c55e",
                  "#3b82f6",
                  "#8b5cf6",
                  "#f59e0b",
                  "#ef4444",
                  "#06b6d4",
                  "#ec4899",
                ].map((c) => (
                  <button
                    key={c}
                    onClick={() => setForm({ ...form, color: c })}
                    className={`w-7 h-7 rounded-full transition-transform ${
                      form.color === c ? "scale-125 ring-2 ring-offset-2 ring-brand-500" : ""
                    }`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              Create Habit
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
