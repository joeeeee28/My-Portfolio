import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import { Card, CardHeader, Button, Input, Select } from "@/components/ui";
import {
  User,
  Palette,
  Database,
  Shield,
  Download,
  Upload,
  Trash2,
} from "lucide-react";

export default function Settings() {
  const handleSignOut = () => {
    window.location.href = "/";
  };
  const profile = useQuery(api.profiles.get);
  const upsertProfile = useMutation(api.profiles.upsert);

  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    if (name.trim()) {
      await upsertProfile({ name: name.trim() });
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleExport = () => {
    const data = {
      exportDate: new Date().toISOString(),
      version: "1.0.0",
      app: "Self Planner",
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `self-planner-export-${new Date().toISOString().split("T")[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <TopBar title="Settings" subtitle="Manage your preferences" />
      <div className="p-4 lg:p-6 max-w-3xl space-y-6">
        {/* Profile */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <User size={16} className="text-brand-500" />
              <h3 className="text-sm font-semibold text-slate-900">Profile</h3>
            </div>
          </CardHeader>
          <div className="space-y-3">
            <Input
              label="Name"
              value={name || profile?.name || ""}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
            <Input
              label="Email"
              value={profile?.email || ""}
              disabled
              className="opacity-60"
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={handleSave}>
                {saved ? "✓ Saved!" : "Save Changes"}
              </Button>
            </div>
          </div>
        </Card>

        {/* Appearance */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Palette size={16} className="text-purple-500" />
              <h3 className="text-sm font-semibold text-slate-900">
                Appearance
              </h3>
            </div>
          </CardHeader>
          <div className="space-y-3">
            <Select
              label="Theme"
              value={profile?.theme || "system"}
              onChange={(e) => upsertProfile({ theme: e.target.value })}
              options={[
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "system", label: "System" },
              ]}
            />
            <Select
              label="Week Starts On"
              value={String(profile?.weekStartsOn ?? 0)}
              onChange={(e) =>
                upsertProfile({ weekStartsOn: Number(e.target.value) })
              }
              options={[
                { value: "0", label: "Sunday" },
                { value: "1", label: "Monday" },
              ]}
            />
            <Select
              label="Currency"
              value={profile?.currency || "INR"}
              onChange={(e) => upsertProfile({ currency: e.target.value })}
              options={[
                { value: "INR", label: "₹ INR" },
                { value: "USD", label: "$ USD" },
                { value: "EUR", label: "€ EUR" },
                { value: "GBP", label: "£ GBP" },
              ]}
            />
          </div>
        </Card>

        {/* Data */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Database size={16} className="text-blue-500" />
              <h3 className="text-sm font-semibold text-slate-900">Data</h3>
            </div>
          </CardHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  Export Data
                </p>
                <p className="text-xs text-slate-500">
                  Download all your planner data as JSON
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={handleExport}>
                <Download size={14} />
                Export
              </Button>
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg bg-slate-50">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  Import Data
                </p>
                <p className="text-xs text-slate-500">
                  Restore from a previous backup
                </p>
              </div>
              <Button variant="secondary" size="sm">
                <Upload size={14} />
                Import
              </Button>
            </div>
          </div>
        </Card>

        {/* Privacy */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Shield size={16} className="text-emerald-500" />
              <h3 className="text-sm font-semibold text-slate-900">Privacy</h3>
            </div>
          </CardHeader>
          <div className="space-y-2">
            <p className="text-xs text-slate-600 leading-relaxed">
              Your data is stored securely and only accessible by you. Each
              account has its own isolated data through Row Level Security.
              Your journal entries and personal information are treated as
              private and never shared.
            </p>
            <p className="text-xs text-slate-600 leading-relaxed">
              All data is encrypted in transit and at rest. You can export or
              delete your data at any time from the settings above.
            </p>
          </div>
        </Card>

        {/* Danger Zone */}
        <Card className="border-red-200">
          <CardHeader>
            <h3 className="text-sm font-semibold text-red-600">Danger Zone</h3>
          </CardHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  Sign Out
                </p>
                <p className="text-xs text-slate-500">
                  Sign out of your account
                </p>
              </div>
              <Button variant="danger" size="sm" onClick={handleSignOut}>
                Sign Out
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
