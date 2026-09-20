import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  profiles: defineTable({
    userId: v.string(),
    name: v.string(),
    email: v.string(),
    avatarUrl: v.optional(v.string()),
    timezone: v.optional(v.string()),
    currency: v.optional(v.string()),
    theme: v.optional(v.string()),
    weekStartsOn: v.optional(v.number()),
  }).index("by_userId", ["userId"]),

  tasks: defineTable({
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("inbox"),
      v.literal("todo"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("archived")
    ),
    priority: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("urgent")
    ),
    dueDate: v.optional(v.number()),
    dueTime: v.optional(v.string()),
    category: v.optional(v.string()),
    projectId: v.optional(v.string()),
    goalId: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    notes: v.optional(v.string()),
    recurring: v.optional(v.string()),
    order: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["userId", "status"])
    .index("by_dueDate", ["userId", "dueDate"]),

  goals: defineTable({
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    category: v.union(
      v.literal("career"),
      v.literal("finance"),
      v.literal("health"),
      v.literal("learning"),
      v.literal("business"),
      v.literal("personal"),
      v.literal("relationships"),
      v.literal("other")
    ),
    startDate: v.number(),
    targetDate: v.optional(v.number()),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("paused"),
      v.literal("abandoned")
    ),
    progress: v.number(),
    milestones: v.optional(
      v.array(
        v.object({
          title: v.string(),
          completed: v.boolean(),
        })
      )
    ),
    notes: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["userId", "status"]),

  habits: defineTable({
    userId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    frequency: v.union(
      v.literal("daily"),
      v.literal("weekly"),
      v.literal("specific")
    ),
    weekdays: v.optional(v.array(v.number())),
    target: v.number(),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    category: v.optional(v.string()),
    startDate: v.number(),
  })
    .index("by_userId", ["userId"]),

  habitCompletions: defineTable({
    userId: v.string(),
    habitId: v.string(),
    date: v.number(),
    completed: v.boolean(),
  })
    .index("by_userId", ["userId"])
    .index("by_habitId", ["habitId", "date"])
    .index("by_date", ["userId", "date"]),

  calendarEvents: defineTable({
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    startTime: v.number(),
    endTime: v.optional(v.number()),
    allDay: v.boolean(),
    color: v.optional(v.string()),
    type: v.union(
      v.literal("event"),
      v.literal("timeblock"),
      v.literal("reminder")
    ),
    taskId: v.optional(v.string()),
    goalId: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_date", ["userId", "startTime"]),

  income: defineTable({
    userId: v.string(),
    amount: v.number(),
    source: v.string(),
    category: v.optional(v.string()),
    date: v.number(),
    notes: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_date", ["userId", "date"]),

  expenses: defineTable({
    userId: v.string(),
    amount: v.number(),
    category: v.string(),
    description: v.optional(v.string()),
    date: v.number(),
    paymentMethod: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_date", ["userId", "date"]),

  budgets: defineTable({
    userId: v.string(),
    category: v.string(),
    amount: v.number(),
    month: v.string(),
  })
    .index("by_userId", ["userId"])
    .index("by_month", ["userId", "month"]),

  savingsGoals: defineTable({
    userId: v.string(),
    name: v.string(),
    target: v.number(),
    saved: v.number(),
    deadline: v.optional(v.number()),
    notes: v.optional(v.string()),
  })
    .index("by_userId", ["userId"]),

  journalEntries: defineTable({
    userId: v.string(),
    title: v.string(),
    content: v.string(),
    mood: v.union(
      v.literal("excellent"),
      v.literal("good"),
      v.literal("neutral"),
      v.literal("low"),
      v.literal("difficult")
    ),
    tags: v.optional(v.array(v.string())),
    gratitude: v.optional(v.string()),
    wins: v.optional(v.string()),
    challenges: v.optional(v.string()),
    date: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_date", ["userId", "date"]),

  projects: defineTable({
    userId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("planning"),
      v.literal("active"),
      v.literal("on_hold"),
      v.literal("completed"),
      v.literal("archived")
    ),
    priority: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high")
    ),
    startDate: v.optional(v.number()),
    deadline: v.optional(v.number()),
    progress: v.number(),
    category: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["userId", "status"]),

  learningItems: defineTable({
    userId: v.string(),
    topic: v.string(),
    course: v.optional(v.string()),
    resource: v.optional(v.string()),
    category: v.optional(v.string()),
    startDate: v.optional(v.number()),
    targetDate: v.optional(v.number()),
    progress: v.number(),
    hoursStudied: v.number(),
    status: v.union(
      v.literal("not_started"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("paused")
    ),
    notes: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["userId", "status"]),

  learningSessions: defineTable({
    userId: v.string(),
    learningItemId: v.string(),
    date: v.number(),
    duration: v.number(),
    notes: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_itemId", ["learningItemId"]),

  visionItems: defineTable({
    userId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    category: v.union(
      v.literal("career"),
      v.literal("finance"),
      v.literal("business"),
      v.literal("lifestyle"),
      v.literal("travel"),
      v.literal("learning"),
      v.literal("personal")
    ),
    type: v.union(
      v.literal("image"),
      v.literal("text"),
      v.literal("quote"),
      v.literal("goal"),
      v.literal("link")
    ),
    link: v.optional(v.string()),
    order: v.optional(v.number()),
  }).index("by_userId", ["userId"]),

  notifications: defineTable({
    userId: v.string(),
    title: v.string(),
    message: v.optional(v.string()),
    type: v.string(),
    read: v.boolean(),
    scheduledAt: v.number(),
    relatedId: v.optional(v.string()),
  })
    .index("by_userId", ["userId"])
    .index("by_unread", ["userId", "read"]),

  settings: defineTable({
    userId: v.string(),
    key: v.string(),
    value: v.string(),
  })
    .index("by_userId", ["userId"])
    .index("by_key", ["userId", "key"]),
});
