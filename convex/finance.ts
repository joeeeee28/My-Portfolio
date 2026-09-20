import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getIncome = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("income")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const addIncome = mutation({
  args: {
    amount: v.number(),
    source: v.string(),
    category: v.optional(v.string()),
    date: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("income", {
      userId,
      amount: args.amount,
      source: args.source,
      category: args.category,
      date: args.date,
      notes: args.notes,
    });
  },
});

export const getExpenses = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("expenses")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const addExpense = mutation({
  args: {
    amount: v.number(),
    category: v.string(),
    description: v.optional(v.string()),
    date: v.number(),
    paymentMethod: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("expenses", {
      userId,
      amount: args.amount,
      category: args.category,
      description: args.description,
      date: args.date,
      paymentMethod: args.paymentMethod,
      notes: args.notes,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const removeIncome = mutation({
  args: { id: v.id("income") },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const getSavingsGoals = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) return [];
    return await ctx.db
      .query("savingsGoals")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
  },
});

export const addSavingsGoal = mutation({
  args: {
    name: v.string(),
    target: v.number(),
    saved: v.number(),
    deadline: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    return await ctx.db.insert("savingsGoals", {
      userId,
      name: args.name,
      target: args.target,
      saved: args.saved,
      deadline: args.deadline,
      notes: args.notes,
    });
  },
});

export const stats = query({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId)
      return {
        totalIncome: 0,
        totalExpenses: 0,
        savings: 0,
        savingsRate: 0,
      };
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = monthStart + 30 * 86400000;
    const income = await ctx.db
      .query("income")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();
    const monthIncome = income
      .filter((i) => i.date >= monthStart && i.date < monthEnd)
      .reduce((sum, i) => sum + i.amount, 0);
    const monthExpenses = expenses
      .filter((e) => e.date >= monthStart && e.date < monthEnd)
      .reduce((sum, e) => sum + e.amount, 0);
    return {
      totalIncome: monthIncome,
      totalExpenses: monthExpenses,
      savings: monthIncome - monthExpenses,
      savingsRate:
        monthIncome > 0
          ? Math.round(((monthIncome - monthExpenses) / monthIncome) * 100)
          : 0,
    };
  },
});
