import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import {
  Card,
  CardHeader,
  StatCard,
  ProgressBar,
  Button,
  EmptyState,
} from "@/components/ui";
import {
  CheckSquare,
  Target,
  Repeat,
  Wallet,
  TrendingUp,
  Clock,
  Plus,
  ArrowRight,
  BookOpen,
  FolderKanban,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getGreeting, formatDate, formatCurrency } from "@/lib/utils";

export default function Dashboard() {
  const taskStats = useQuery(api.tasks.stats, {});
  const goalStats = useQuery(api.goals.stats, {});
  const habitStats = useQuery(api.habits.stats, {});
  const financeStats = useQuery(api.finance.stats, {});
  const tasks = useQuery(api.tasks.list, {});
  const goals = useQuery(api.goals.list, {});
  const projects = useQuery(api.projects.list, {});
  const navigate = useNavigate();

  const today = new Date();
  const greeting = getGreeting();
  const name = "there";

  const todayTasks = tasks?.filter((t) => {
    const d = t.dueDate ? new Date(t.dueDate) : null;
    return (
      d &&
      d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear()
    );
  }) || [];

  const upcomingTasks =
    tasks
      ?.filter(
        (t) =>
          t.dueDate &&
          t.dueDate > Date.now() &&
          t.status !== "completed" &&
          t.status !== "archived"
      )
      .sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0))
      .slice(0, 5) || [];

  const activeGoals =
    goals?.filter((g) => g.status === "active").slice(0, 4) || [];

  const priorityTasks =
    tasks
      ?.filter(
        (t) =>
          (t.priority === "high" || t.priority === "urgent") &&
          t.status !== "completed" &&
          t.status !== "archived"
      )
      .slice(0, 5) || [];

  const completionRate =
    taskStats && taskStats.total > 0
      ? Math.round((taskStats.completed / taskStats.total) * 100)
      : 0;

  return (
    <div>
      <TopBar
        title={`${greeting}, ${name}`}
        subtitle={formatDate(Date.now())}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate("/tasks")}
          >
            <Plus size={14} />
            Quick Add
          </Button>
        }
      />

      <div className="p-4 lg:p-6 space-y-6 max-w-7xl">
        {/* Quick Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Tasks Today"
            value={todayTasks.length}
            icon={<CheckSquare size={20} />}
            trend={`${taskStats?.todayCompleted || 0} completed`}
          />
          <StatCard
            label="Active Goals"
            value={goalStats?.active || 0}
            icon={<Target size={20} />}
            trend={`${Math.round(goalStats?.avgProgress || 0)}% avg progress`}
          />
          <StatCard
            label="Habits Today"
            value={habitStats?.todayCompleted || 0}
            icon={<Repeat size={20} />}
            trend={`of ${habitStats?.total || 0} habits`}
          />
          <StatCard
            label="This Month"
            value={formatCurrency(financeStats?.savings || 0)}
            icon={<Wallet size={20} />}
            trend={`${financeStats?.savingsRate || 0}% savings rate`}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Today's Tasks */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Today's Tasks
                  </h3>
                  <p className="text-xs text-slate-500">
                    {todayTasks.filter((t) => t.status === "completed").length}{" "}
                    of {todayTasks.length} completed
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/tasks")}
                >
                  View All
                  <ArrowRight size={14} />
                </Button>
              </CardHeader>
              {todayTasks.length === 0 ? (
                <EmptyState
                  icon={<CheckSquare size={24} />}
                  title="No tasks for today"
                  description="Add tasks to plan your day"
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => navigate("/tasks")}
                    >
                      <Plus size={14} />
                      Add Task
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-2">
                  {todayTasks.slice(0, 6).map((task: any) => (
                    <div
                      key={task._id}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 transition-colors"
                    >
                      <div
                        className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                          task.status === "completed"
                            ? "bg-emerald-500 border-emerald-500"
                            : "border-slate-300"
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
                      </div>
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
                      </div>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          task.priority === "urgent"
                            ? "bg-red-50 text-red-600"
                            : task.priority === "high"
                            ? "bg-orange-50 text-orange-600"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {task.priority}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {/* Productivity */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <h3 className="text-sm font-semibold text-slate-900">
                  Productivity
                </h3>
              </CardHeader>
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-slate-500">
                      Task Completion
                    </span>
                    <span className="text-xs font-semibold text-slate-900">
                      {completionRate}%
                    </span>
                  </div>
                  <ProgressBar value={completionRate} />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-slate-500">
                      Goal Progress
                    </span>
                    <span className="text-xs font-semibold text-slate-900">
                      {Math.round(goalStats?.avgProgress || 0)}%
                    </span>
                  </div>
                  <ProgressBar
                    value={goalStats?.avgProgress || 0}
                    color="bg-emerald-500"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="text-center p-2 bg-slate-50 rounded-lg">
                    <p className="text-lg font-bold text-slate-900">
                      {taskStats?.completed || 0}
                    </p>
                    <p className="text-[10px] text-slate-500">Completed</p>
                  </div>
                  <div className="text-center p-2 bg-slate-50 rounded-lg">
                    <p className="text-lg font-bold text-slate-900">
                      {taskStats?.inProgress || 0}
                    </p>
                    <p className="text-[10px] text-slate-500">In Progress</p>
                  </div>
                </div>
              </div>
            </Card>

            {/* Finance Snapshot */}
            <Card>
              <CardHeader>
                <h3 className="text-sm font-semibold text-slate-900">
                  Finance Snapshot
                </h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => navigate("/finance")}
                >
                  <ArrowRight size={14} />
                </Button>
              </CardHeader>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Income</span>
                  <span className="text-sm font-semibold text-emerald-600">
                    +{formatCurrency(financeStats?.totalIncome || 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-slate-500">Expenses</span>
                  <span className="text-sm font-semibold text-red-600">
                    -{formatCurrency(financeStats?.totalExpenses || 0)}
                  </span>
                </div>
                <div className="border-t border-slate-100 pt-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-700">
                    Net Savings
                  </span>
                  <span className="text-sm font-bold text-brand-600">
                    {formatCurrency(financeStats?.savings || 0)}
                  </span>
                </div>
              </div>
            </Card>
          </div>
        </div>

        {/* Goals */}
        {activeGoals.length > 0 && (
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Active Goals
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/goals")}
              >
                View All
                <ArrowRight size={14} />
              </Button>
            </CardHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {activeGoals.map((goal: any) => (
                <div
                  key={goal._id}
                  className="p-3 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Target size={14} className="text-brand-500" />
                    <span className="text-xs font-medium text-slate-500 capitalize">
                      {goal.category}
                    </span>
                  </div>
                  <h4 className="text-sm font-semibold text-slate-900 mb-2">
                    {goal.title}
                  </h4>
                  <ProgressBar
                    value={goal.progress}
                    color="bg-brand-500"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    {goal.progress}% complete
                  </p>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold text-slate-900">
              Quick Actions
            </h3>
          </CardHeader>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { label: "+ Task", to: "/tasks", color: "bg-blue-50 text-blue-600" },
              {
                label: "+ Goal",
                to: "/goals",
                color: "bg-purple-50 text-purple-600",
              },
              {
                label: "+ Habit",
                to: "/habits",
                color: "bg-emerald-50 text-emerald-600",
              },
              {
                label: "+ Expense",
                to: "/finance",
                color: "bg-amber-50 text-amber-600",
              },
              {
                label: "+ Journal",
                to: "/journal",
                color: "bg-pink-50 text-pink-600",
              },
              {
                label: "+ Project",
                to: "/projects",
                color: "bg-cyan-50 text-cyan-600",
              },
            ].map((action) => (
              <button
                key={action.to}
                onClick={() => navigate(action.to)}
                className={`p-3 rounded-xl font-medium text-sm transition-all hover:scale-[1.02] ${action.color}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
