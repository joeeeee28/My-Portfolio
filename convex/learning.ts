import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("learningItems")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    topic: v.string(),
    course: v.optional(v.string()),
    resource: v.optional(v.string()),
    category: v.optional(v.string()),
    startDate: v.optional(v.number()),
    targetDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("learningItems", {
      userId,
      topic: args.topic,
      course: args.course,
      resource: args.resource,
      category: args.category,
      startDate: args.startDate,
      targetDate: args.targetDate,
      progress: 0,
      hoursStudied: 0,
      status: "not_started",
      notes: args.notes,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("learningItems"),
    topic: v.optional(v.string()),
    status: v.optional(v.string()),
    progress: v.optional(v.number()),
    hoursStudied: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, updates as any);
  },
});

export const remove = mutation({
  args: { id: v.id("learningItems") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const addSession = mutation({
  args: {
    learningItemId: v.string(),
    date: v.number(),
    duration: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("learningSessions", {
      userId,
      learningItemId: args.learningItemId,
      date: args.date,
      duration: args.duration,
      notes: args.notes,
    });
  },
});
