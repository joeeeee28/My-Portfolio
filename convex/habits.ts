import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("habits")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    frequency: v.string(),
    weekdays: v.optional(v.array(v.number())),
    target: v.number(),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("habits", {
      userId,
      name: args.name,
      description: args.description,
      frequency: args.frequency as any,
      weekdays: args.weekdays,
      target: args.target,
      color: args.color,
      icon: args.icon,
      category: args.category,
      startDate: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("habits") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const toggleCompletion = mutation({
  args: {
    habitId: v.id("habits"),
    date: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("habitCompletions")
      .withIndex("by_habitId", (q) =>
        q.eq("habitId", args.habitId).eq("date", args.date)
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { completed: !existing.completed });
    } else {
      await ctx.db.insert("habitCompletions", {
        userId,
        habitId: args.habitId,
        date: args.date,
        completed: true,
      });
    }
  },
});

export const getCompletions = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("habitCompletions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return { total: 0, todayCompleted: 0, streak: 0 };
    const habits = await ctx.db
      .query("habits")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    const completions = await ctx.db
      .query("habitCompletions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const todayCompletions = completions.filter(
      (c) => c.date === todayStart && c.completed
    );
    return {
      total: habits.length,
      todayCompleted: todayCompletions.length,
      streak: 0,
    };
  },
});
