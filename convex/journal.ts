import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("journalEntries")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    content: v.string(),
    mood: v.string(),
    tags: v.optional(v.array(v.string())),
    gratitude: v.optional(v.string()),
    wins: v.optional(v.string()),
    challenges: v.optional(v.string()),
    date: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("journalEntries", {
      userId,
      title: args.title,
      content: args.content,
      mood: args.mood as any,
      tags: args.tags,
      gratitude: args.gratitude,
      wins: args.wins,
      challenges: args.challenges,
      date: args.date,
    });
  },
});

export const update = mutation({
  args: {
    id: v.id("journalEntries"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    mood: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    gratitude: v.optional(v.string()),
    wins: v.optional(v.string()),
    challenges: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    await ctx.db.patch(id, updates as any);
  },
});

export const remove = mutation({
  args: { id: v.id("journalEntries") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
