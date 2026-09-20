import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import {
  Card,
  CardHeader,
  Button,
  Modal,
  Input,
  Select,
  Textarea,
  StatCard,
  Tabs,
  EmptyState,
} from "@/components/ui";
import {
  Plus,
  Wallet,
  TrendingUp,
  TrendingDown,
  PiggyBank,
  Trash2,
} from "lucide-react";
import { formatCurrency, formatDate, EXPENSE_CATEGORIES } from "@/lib/utils";

export default function Finance() {
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState<"income" | "expense">("expense");
  const [activeTab, setActiveTab] = useState("overview");
  const income = useQuery(api.finance.getIncome, {});
  const expenses = useQuery(api.finance.getExpenses, {});
  const stats = useQuery(api.finance.stats, {});
  const addIncome = useMutation(api.finance.addIncome);
  const addExpense = useMutation(api.finance.addExpense);
  const removeExpense = useMutation(api.finance.remove);
  const removeIncome = useMutation(api.finance.removeIncome);

  const [incomeForm, setIncomeForm] = useState({
    amount: "",
    source: "",
    category: "",
    notes: "",
  });

  const [expenseForm, setExpenseForm] = useState({
    amount: "",
    category: "food",
    description: "",
    paymentMethod: "",
    notes: "",
  });

  const handleAddIncome = async () => {
    if (!incomeForm.amount || !incomeForm.source) return;
    await addIncome({
      amount: Number(incomeForm.amount),
      source: incomeForm.source,
      category: incomeForm.category || undefined,
      date: Date.now(),
      notes: incomeForm.notes || undefined,
    });
    setIncomeForm({ amount: "", source: "", category: "", notes: "" });
    setShowModal(false);
  };

  const handleAddExpense = async () => {
    if (!expenseForm.amount || !expenseForm.category) return;
    await addExpense({
      amount: Number(expenseForm.amount),
      category: expenseForm.category,
      description: expenseForm.description || undefined,
      date: Date.now(),
      paymentMethod: expenseForm.paymentMethod || undefined,
      notes: expenseForm.notes || undefined,
    });
    setExpenseForm({
      amount: "",
      category: "food",
      description: "",
      paymentMethod: "",
      notes: "",
    });
    setShowModal(false);
  };

  // Category breakdown
  const categoryTotals =
    expenses?.reduce((acc: Record<string, number>, e: any) => {
      acc[e.category] = (acc[e.category] || 0) + e.amount;
      return acc;
    }, {} as Record<string, number>) || {};

  const sortedCategories = Object.entries(categoryTotals as Record<string, number>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const maxCategoryAmount = sortedCategories[0]?.[1] || 1;

  return (
    <div>
      <TopBar
        title="Finance"
        subtitle="Track your income, expenses, and savings"
        actions={
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setModalType("income");
                setShowModal(true);
              }}
            >
              <Plus size={14} />
              Income
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setModalType("expense");
                setShowModal(true);
              }}
            >
              <Plus size={14} />
              Expense
            </Button>
          </div>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl space-y-6">
        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Monthly Income"
            value={formatCurrency(stats?.totalIncome || 0)}
            icon={<TrendingUp size={20} />}
            className="border-l-4 border-l-emerald-400"
          />
          <StatCard
            label="Monthly Expenses"
            value={formatCurrency(stats?.totalExpenses || 0)}
            icon={<TrendingDown size={20} />}
            className="border-l-4 border-l-red-400"
          />
          <StatCard
            label="Net Savings"
            value={formatCurrency(stats?.savings || 0)}
            icon={<PiggyBank size={20} />}
            className="border-l-4 border-l-brand-400"
          />
          <StatCard
            label="Savings Rate"
            value={`${stats?.savingsRate || 0}%`}
            icon={<Wallet size={20} />}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Category Breakdown */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Expense Breakdown
              </h3>
            </CardHeader>
            {sortedCategories.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-6">
                No expenses recorded yet
              </p>
            ) : (
              <div className="space-y-3">
                {sortedCategories.map(([category, amount]: [string, number]) => (
                  <div key={category}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-700 capitalize">
                        {category}
                      </span>
                      <span className="text-xs font-semibold text-slate-900">
                        {formatCurrency(amount)}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-brand-500 transition-all"
                        style={{
                          width: `${(amount / maxCategoryAmount) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Recent Transactions */}
          <Card>
            <CardHeader>
              <h3 className="text-sm font-semibold text-slate-900">
                Recent Transactions
              </h3>
            </CardHeader>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {[
                ...(income || []).map((i) => ({
                  ...i,
                  type: "income" as const,
                })),
                ...(expenses || []).map((e) => ({
                  ...e,
                  type: "expense" as const,
                })),
              ]
                .sort((a, b) => b.date - a.date)
                .slice(0, 10)
                .map((item: any) => (
                  <div
                    key={item._id}
                    className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50"
                  >
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        item.type === "income"
                          ? "bg-emerald-50 text-emerald-600"
                          : "bg-red-50 text-red-600"
                      }`}
                    >
                      {item.type === "income" ? (
                        <TrendingUp size={14} />
                      ) : (
                        <TrendingDown size={14} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {item.type === "income"
                          ? (item as any).source
                          : (item as any).description || (item as any).category}
                      </p>
                      <p className="text-xs text-slate-500">
                        {formatDate(item.date)}
                      </p>
                    </div>
                    <span
                      className={`text-sm font-semibold ${
                        item.type === "income"
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    >
                      {item.type === "income" ? "+" : "-"}
                      {formatCurrency(item.amount)}
                    </span>
                    <button
                      onClick={() =>
                        item.type === "income"
                          ? removeIncome({ id: item._id })
                          : removeExpense({ id: item._id })
                      }
                      className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              {(!income || income.length === 0) &&
                (!expenses || expenses.length === 0) && (
                  <p className="text-sm text-slate-500 text-center py-6">
                    No transactions yet
                  </p>
                )}
            </div>
          </Card>
        </div>

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title={
            modalType === "income" ? "Add Income" : "Add Expense"
          }
        >
          {modalType === "income" ? (
            <div className="space-y-3">
              <Input
                label="Amount (₹)"
                type="number"
                value={incomeForm.amount}
                onChange={(e) =>
                  setIncomeForm({ ...incomeForm, amount: e.target.value })
                }
                placeholder="0"
              />
              <Input
                label="Source"
                value={incomeForm.source}
                onChange={(e) =>
                  setIncomeForm({ ...incomeForm, source: e.target.value })
                }
                placeholder="e.g., Salary, Freelance"
              />
              <Input
                label="Category"
                value={incomeForm.category}
                onChange={(e) =>
                  setIncomeForm({ ...incomeForm, category: e.target.value })
                }
                placeholder="e.g., employment, freelance"
              />
              <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
                <Button variant="ghost" onClick={() => setShowModal(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleAddIncome}>
                  Add Income
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                label="Amount (₹)"
                type="number"
                value={expenseForm.amount}
                onChange={(e) =>
                  setExpenseForm({ ...expenseForm, amount: e.target.value })
                }
                placeholder="0"
              />
              <Select
                label="Category"
                value={expenseForm.category}
                onChange={(e) =>
                  setExpenseForm({ ...expenseForm, category: e.target.value })
                }
                options={EXPENSE_CATEGORIES.map((c) => ({
                  value: c,
                  label: c.charAt(0).toUpperCase() + c.slice(1),
                }))}
              />
              <Input
                label="Description"
                value={expenseForm.description}
                onChange={(e) =>
                  setExpenseForm({
                    ...expenseForm,
                    description: e.target.value,
                  })
                }
                placeholder="What was this expense for?"
              />
              <Input
                label="Payment Method"
                value={expenseForm.paymentMethod}
                onChange={(e) =>
                  setExpenseForm({
                    ...expenseForm,
                    paymentMethod: e.target.value,
                  })
                }
                placeholder="e.g., UPI, Cash, Card"
              />
              <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
                <Button variant="ghost" onClick={() => setShowModal(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleAddExpense}>
                  Add Expense
                </Button>
              </div>
            </div>
          )}
        </Modal>
      </div>
    </div>
  );
}
