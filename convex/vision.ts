import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("visionItems")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    category: v.string(),
    type: v.string(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("visionItems", {
      userId,
      title: args.title,
      description: args.description,
      imageUrl: args.imageUrl,
      category: args.category as any,
      type: args.type as any,
      link: args.link,
      order: Date.now(),
    });
  },
});

export const remove = mutation({
  args: { id: v.id("visionItems") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
