import { mutation } from "./_generated/server";

export const seedDemoData = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = (await ctx.auth.getUserIdentity())?.subject;
    if (!userId) throw new Error("Not authenticated");
    const now = Date.now();
    const day = 86400000;

    // Tasks
    const taskTitles = [
      "Review weekly goals",
      "Exercise for 30 minutes",
      "Read for 20 minutes",
      "Plan tomorrow's schedule",
      "Complete project proposal",
      "Call dentist for appointment",
      "Grocery shopping",
      "Update budget spreadsheet",
    ];
    for (let i = 0; i < taskTitles.length; i++) {
      await ctx.db.insert("tasks", {
        userId,
        title: taskTitles[i],
        status: i < 3 ? "completed" : i < 5 ? "in_progress" : "todo",
        priority: i < 2 ? "high" : i < 4 ? "medium" : "low",
        dueDate: now + (i - 2) * day,
        category: i < 4 ? "personal" : "work",
      });
    }

    // Goals
    await ctx.db.insert("goals", {
      userId,
      title: "Run a half marathon",
      description: "Train and complete a half marathon by December",
      category: "health",
      startDate: now - 30 * day,
      targetDate: now + 90 * day,
      status: "active",
      progress: 35,
      milestones: [
        { title: "Run 5K without stopping", completed: true },
        { title: "Run 10K", completed: true },
        { title: "Run 15K", completed: false },
        { title: "Complete half marathon", completed: false },
      ],
    });
    await ctx.db.insert("goals", {
      userId,
      title: "Save ₹100,000",
      description: "Build emergency fund",
      category: "finance",
      startDate: now - 60 * day,
      targetDate: now + 120 * day,
      status: "active",
      progress: 45,
    });
    await ctx.db.insert("goals", {
      userId,
      title: "Learn TypeScript",
      category: "learning",
      startDate: now - 14 * day,
      status: "active",
      progress: 60,
    });

    // Habits
    const habitNames = [
      { name: "Exercise", color: "#22c55e", icon: "💪" },
      { name: "Read", color: "#3b82f6", icon: "📚" },
      { name: "Meditate", color: "#8b5cf6", icon: "🧘" },
      { name: "Journal", color: "#f59e0b", icon: "✍️" },
      { name: "Drink Water", color: "#06b6d4", icon: "💧" },
    ];
    for (const h of habitNames) {
      await ctx.db.insert("habits", {
        userId,
        name: h.name,
        frequency: "daily",
        target: 1,
        color: h.color,
        icon: h.icon,
        category: "wellness",
        startDate: now - 30 * day,
      });
    }

    // Income
    await ctx.db.insert("income", {
      userId,
      amount: 50000,
      source: "Salary",
      category: "employment",
      date: now - 5 * day,
    });
    await ctx.db.insert("income", {
      userId,
      amount: 5000,
      source: "Freelance Project",
      category: "freelance",
      date: now - 10 * day,
    });

    // Expenses
    const expenseCategories = [
      { amount: 2500, category: "food", description: "Groceries" },
      { amount: 1200, category: "transport", description: "Fuel" },
      { amount: 800, category: "entertainment", description: "Movie tickets" },
      { amount: 3000, category: "bills", description: "Electricity bill" },
      { amount: 1500, category: "shopping", description: "New shoes" },
    ];
    for (const e of expenseCategories) {
      await ctx.db.insert("expenses", {
        userId,
        amount: e.amount,
        category: e.category,
        description: e.description,
        date: now - Math.floor(Math.random() * 15) * day,
      });
    }

    // Journal
    await ctx.db.insert("journalEntries", {
      userId,
      title: "Reflecting on progress",
      content:
        "Today was productive. I managed to complete most of my tasks and felt good about the progress on my goals. Need to focus more on exercise consistency.",
      mood: "good",
      tags: ["reflection", "productivity"],
      gratitude: "Grateful for the quiet morning and productive afternoon.",
      wins: "Finished the project proposal ahead of deadline.",
      challenges: "Struggled with focus in the afternoon.",
      date: now,
    });

    // Projects
    await ctx.db.insert("projects", {
      userId,
      name: "Personal Website",
      description: "Build a portfolio website",
      status: "active",
      priority: "high",
      startDate: now - 10 * day,
      deadline: now + 30 * day,
      progress: 40,
      category: "career",
    });
    await ctx.db.insert("projects", {
      userId,
      name: "Home Office Setup",
      description: "Organize and optimize workspace",
      status: "planning",
      priority: "medium",
      progress: 10,
    });

    // Learning
    await ctx.db.insert("learningItems", {
      userId,
      topic: "TypeScript Advanced Patterns",
      course: "Frontend Masters",
      category: "programming",
      startDate: now - 14 * day,
      progress: 60,
      hoursStudied: 12,
      status: "in_progress",
    });
    await ctx.db.insert("learningItems", {
      userId,
      topic: "Financial Planning",
      category: "finance",
      startDate: now - 7 * day,
      progress: 20,
      hoursStudied: 3,
      status: "in_progress",
    });

    // Calendar events
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const ts = todayStart.getTime();
    await ctx.db.insert("calendarEvents", {
      userId,
      title: "Morning Exercise",
      startTime: ts + 7 * 3600000,
      endTime: ts + 8 * 3600000,
      allDay: false,
      type: "timeblock",
      color: "#22c55e",
    });
    await ctx.db.insert("calendarEvents", {
      userId,
      title: "Deep Work Session",
      startTime: ts + 9 * 3600000,
      endTime: ts + 12 * 3600000,
      allDay: false,
      type: "timeblock",
      color: "#3b82f6",
    });
    await ctx.db.insert("calendarEvents", {
      userId,
      title: "Team Standup",
      startTime: ts + 14 * 3600000,
      endTime: ts + 14.5 * 3600000,
      allDay: false,
      type: "event",
      color: "#8b5cf6",
    });

    // Vision items
    await ctx.db.insert("visionItems", {
      userId,
      title: "Dream Home Office",
      description: "A clean, minimal workspace with natural light",
      category: "lifestyle",
      type: "text",
    });
    await ctx.db.insert("visionItems", {
      title: "Travel to Japan",
      description: "Experience Japanese culture and cuisine",
      category: "travel",
      type: "quote",
      userId,
    });

    return { success: true };
  },
});
