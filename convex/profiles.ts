import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return null;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    return profile;
  },
});

export const upsert = mutation({
  args: {
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    timezone: v.optional(v.string()),
    currency: v.optional(v.string()),
    theme: v.optional(v.string()),
    weekStartsOn: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      const identity = await ctx.auth.getUserIdentity();
      await ctx.db.insert("profiles", {
        userId,
        name: args.name || identity?.name || "User",
        email: args.email || identity?.email || "",
        ...args,
      });
    }
  },
});
