import { useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui";
import { Sparkles, ArrowRight } from "lucide-react";

export function AuthPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [mode, setMode] = useState<"login" | "signup">("signup");

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50">
        <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (isAuthenticated) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 via-blue-50/30 to-slate-50 px-4">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center mx-auto mb-4">
            <Sparkles size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Self Planner</h1>
          <p className="text-sm text-slate-500 mt-1">
            Plan your days. Build your future.
          </p>
        </div>

        {/* Auth Card */}
        <div className="card p-6">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">
            {mode === "signup" ? "Create your account" : "Welcome back"}
          </h2>

          <div className="space-y-3">
            {mode === "signup" && (
              <div>
                <label className="text-xs font-medium text-slate-600 block mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  placeholder="Enter your name"
                  className="input"
                />
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">
                Email
              </label>
              <input
                type="email"
                placeholder="you@example.com"
                className="input"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 block mb-1">
                Password
              </label>
              <input
                type="password"
                placeholder="••••••••"
                className="input"
              />
            </div>
          </div>

          <Button variant="primary" className="w-full mt-4">
            {mode === "signup" ? "Get Started" : "Sign In"}
            <ArrowRight size={16} />
          </Button>

          <p className="text-center text-xs text-slate-500 mt-4">
            {mode === "signup" ? "Already have an account?" : "New here?"}{" "}
            <button
              onClick={() =>
                setMode(mode === "signup" ? "login" : "signup")
              }
              className="text-brand-600 font-medium hover:underline"
            >
              {mode === "signup" ? "Sign in" : "Create account"}
            </button>
          </p>
        </div>

        <p className="text-center text-[11px] text-slate-400 mt-4">
          Your data stays private and secure
        </p>
      </div>
    </div>
  );
}
