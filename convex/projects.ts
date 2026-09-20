import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("projects")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    status: v.string(),
    priority: v.string(),
    startDate: v.optional(v.number()),
    deadline: v.optional(v.number()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("projects", {
      userId,
      name: args.name,
      description: args.description,
      status: args.status as any,
      priority: args.priority as any,
      startDate: args.startDate,
      deadline: args.deadline,
      progress: 0,
      category: args.category,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
    progress: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, updates as any);
  },
});

export const remove = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
