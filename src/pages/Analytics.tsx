import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, StatCard, ProgressBar } from "@/components/ui";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";
import {
  CheckSquare,
  Target,
  Repeat,
  Wallet,
  GraduationCap,
  TrendingUp,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

export default function Analytics() {
  const taskStats = useQuery(api.tasks.stats, {});
  const tasks = useQuery(api.tasks.list, {});
  const goalStats = useQuery(api.goals.stats, {});
  const goals = useQuery(api.goals.list, {});
  const habitStats = useQuery(api.habits.stats, {});
  const habits = useQuery(api.habits.list, {});
  const financeStats = useQuery(api.finance.stats, {});
  const expenses = useQuery(api.finance.getExpenses, {});
  const learning = useQuery(api.learning.list, {});

  // Task status distribution
  const taskStatusData = [
    { name: "Todo", value: taskStats?.todo || 0, color: "#3b82f6" },
    { name: "In Progress", value: taskStats?.inProgress || 0, color: "#f59e0b" },
    { name: "Completed", value: taskStats?.completed || 0, color: "#22c55e" },
  ];

  // Expense by category
  const expenseData = expenses
    ? Object.entries(
        expenses.reduce((acc, e) => {
          acc[e.category] = (acc[e.category] || 0) + e.amount;
          return acc;
        }, {} as Record<string, number>)
      ).map(([name, value]) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        value,
      }))
    : [];

  const COLORS = [
    "#3b82f6",
    "#22c55e",
    "#f59e0b",
    "#ef4444",
    "#8b5cf6",
    "#06b6d4",
    "#ec4899",
  ];

  // Goal progress
  const goalData =
    goals
      ?.filter((g) => g.status === "active")
      .map((g) => ({
        name: g.title.slice(0, 15),
        progress: g.progress,
      })) || [];

  // Weekly task trend (mock data for now)
  const weeklyData = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
    (day) => ({
      day,
      completed: Math.floor(Math.random() * 5) + 1,
      created: Math.floor(Math.random() * 4) + 1,
    })
  );

  return (
    <div>
      <TopBar title="Analytics" subtitle="Personal insights and trends" />
      <div className="p-4 lg:p-6 max-w-7xl space-y-6">
        {/* Overview Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard
            label="Tasks"
            value={taskStats?.total || 0}
            icon={<CheckSquare size={20} />}
            trend={`${taskStats?.completed || 0} completed`}
          />
          <StatCard
            label="Goals"
            value={goalStats?.active || 0}
            icon={<Target size={20} />}
            trend={`${Math.round(goalStats?.avgProgress || 0)}% avg`}
          />
          <StatCard
            label="Habits"
            value={habits?.length || 0}
            icon={<Repeat size={20} />}
            trend={`${habitStats?.todayCompleted || 0} today`}
          />
          <StatCard
            label="Savings"
            value={formatCurrency(financeStats?.savings || 0)}
            icon={<Wallet size={20} />}
            trend={`${financeStats?.savingsRate || 0}% rate`}
          />
          <StatCard
            label="Study Hours"
            value={
              learning?.reduce((s, l) => s + l.hoursStudied, 0) || 0
            }
            icon={<GraduationCap size={20} />}
            trend={`${learning?.length || 0} items`}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Task Status */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Task Status Distribution
              </h3>
            </CardHeader>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={taskStatusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {taskStatusData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-center gap-4 mt-2">
              {taskStatusData.map((item) => (
                <div key={item.name} className="flex items-center gap-1.5">
                  <div
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ background: item.color }}
                  />
                  <span className="text-xs text-slate-500">
                    {item.name} ({item.value})
                  </span>
                </div>
              ))}
            </div>
          </Card>

          {/* Weekly Trend */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Weekly Task Trend
              </h3>
            </CardHeader>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Bar
                    dataKey="completed"
                    fill="#22c55e"
                    radius={[4, 4, 0, 0]}
                    name="Completed"
                  />
                  <Bar
                    dataKey="created"
                    fill="#3b82f6"
                    radius={[4, 4, 0, 0]}
                    name="Created"
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>

          {/* Expenses */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Expenses by Category
              </h3>
            </CardHeader>
            {expenseData.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">
                No expense data yet
              </p>
            ) : (
              <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={expenseData} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis
                      dataKey="name"
                      type="category"
                      tick={{ fontSize: 11 }}
                      width={80}
                    />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="value" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Goal Progress */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Goal Progress
              </h3>
            </CardHeader>
            {goalData.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">
                No active goals yet
              </p>
            ) : (
              <div className="space-y-3">
                {goalData.map((goal, i) => (
                  <div key={i}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-700">
                        {goal.name}
                      </span>
                      <span className="text-xs font-semibold text-slate-900">
                        {goal.progress}%
                      </span>
                    </div>
                    <ProgressBar
                      value={goal.progress}
                      color={COLORS[i % COLORS.length]}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
