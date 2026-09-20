export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function getStartOfDay(date: Date = new Date()): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function getEndOfDay(date: Date = new Date()): number {
  return getStartOfDay(date) + 86400000;
}

export function getStartOfMonth(date: Date = new Date()): number {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  return d.getTime();
}

export function getEndOfMonth(date: Date = new Date()): number {
  const d = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return d.getTime() + 86400000;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export function isSameDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

export function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export const MOOD_EMOJIS: Record<string, string> = {
  excellent: "😄",
  good: "🙂",
  neutral: "😐",
  low: "😔",
  difficult: "😢",
};

export const TASK_STATUSES = [
  { value: "inbox", label: "Inbox", color: "slate" },
  { value: "todo", label: "To Do", color: "blue" },
  { value: "in_progress", label: "In Progress", color: "amber" },
  { value: "completed", label: "Completed", color: "emerald" },
  { value: "archived", label: "Archived", color: "gray" },
];

export const PRIORITIES = [
  { value: "low", label: "Low", color: "text-slate-500" },
  { value: "medium", label: "Medium", color: "text-amber-500" },
  { value: "high", label: "High", color: "text-orange-500" },
  { value: "urgent", label: "Urgent", color: "text-red-500" },
];

export const EXPENSE_CATEGORIES = [
  "food",
  "transport",
  "shopping",
  "bills",
  "entertainment",
  "education",
  "health",
  "travel",
  "subscriptions",
  "business",
  "other",
];

export const GOAL_CATEGORIES = [
  "career",
  "finance",
  "health",
  "learning",
  "business",
  "personal",
  "relationships",
  "other",
];

export const VISION_CATEGORIES = [
  "career",
  "finance",
  "business",
  "lifestyle",
  "travel",
  "learning",
  "personal",
];
