import { Search, Bell, Plus } from "lucide-react";
import { getGreeting } from "@/lib/utils";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useState } from "react";

interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function TopBar({ title, subtitle, actions }: TopBarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const profile = useQuery(api.profiles.get);
  const name = profile?.name?.split(" ")[0] || "there";

  return (
    <div className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3">
      <div className="flex items-center justify-between">
        <div className="pl-10 lg:pl-0">
          <h1 className="text-lg font-bold text-slate-900">{title}</h1>
          {subtitle && (
            <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {actions}
          <button
            onClick={() => setSearchOpen(!searchOpen)}
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors"
          >
            <Search size={18} />
          </button>
          <button className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors relative">
            <Bell size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
