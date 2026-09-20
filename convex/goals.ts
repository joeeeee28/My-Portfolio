import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("goals")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    category: v.string(),
    startDate: v.number(),
    targetDate: v.optional(v.number()),
    milestones: v.optional(
      v.array(v.object({ title: v.string(), completed: v.boolean() }))
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("goals", {
      userId,
      title: args.title,
      description: args.description,
      category: args.category as any,
      startDate: args.startDate,
      targetDate: args.targetDate,
      status: "active",
      progress: 0,
      milestones: args.milestones,
      notes: args.notes,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("goals"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    progress: v.optional(v.number()),
    milestones: v.optional(
      v.array(v.object({ title: v.string(), completed: v.boolean() }))
    ),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, updates as any);
  },
});

export const remove = mutation({
  args: { id: v.id("goals") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return { active: 0, completed: 0, avgProgress: 0 };
    const goals = await ctx.db
      .query("goals")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const active = goals.filter((g) => g.status === "active");
    const completed = goals.filter((g) => g.status === "completed");
    const avgProgress =
      active.length > 0
        ? active.reduce((sum, g) => sum + g.progress, 0) / active.length
        : 0;
    return { active: active.length, completed: completed.length, avgProgress };
  },
});
