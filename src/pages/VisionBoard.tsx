import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import {
  Card,
  Button,
  Modal,
  Input,
  Select,
  Textarea,
  EmptyState,
  Badge,
} from "@/components/ui";
import { Plus, Image, Trash2, Quote, Link, Target } from "lucide-react";
import { VISION_CATEGORIES } from "@/lib/utils";

export default function VisionBoard() {
  const [showModal, setShowModal] = useState(false);
  const items = useQuery(api.vision.list, {});
  const createItem = useMutation(api.vision.create);
  const removeItem = useMutation(api.vision.remove);

  const [form, setForm] = useState({
    title: "",
    description: "",
    category: "personal",
    type: "text",
    link: "",
  });

  const handleSubmit = async () => {
    if (!form.title.trim()) return;
    await createItem({
      title: form.title,
      description: form.description || undefined,
      category: form.category,
      type: form.type,
      link: form.link || undefined,
    });
    setForm({
      title: "",
      description: "",
      category: "personal",
      type: "text",
      link: "",
    });
    setShowModal(false);
  };

  const typeIcons: Record<string, any> = {
    image: Image,
    text: Target,
    quote: Quote,
    goal: Target,
    link: Link,
  };

  const categoryColors: Record<string, string> = {
    career: "from-blue-400 to-blue-600",
    finance: "from-emerald-400 to-emerald-600",
    business: "from-amber-400 to-amber-600",
    lifestyle: "from-pink-400 to-pink-600",
    travel: "from-cyan-400 to-cyan-600",
    learning: "from-purple-400 to-purple-600",
    personal: "from-rose-400 to-rose-600",
  };

  return (
    <div>
      <TopBar
        title="Vision Board"
        subtitle="Visualize your dreams and aspirations"
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            <Plus size={14} />
            Add Vision
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl">
        {items?.length === 0 ? (
          <EmptyState
            icon={<Image size={24} />}
            title="Your vision board is empty"
            description="Add images, quotes, goals, and dreams to visualize your future"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Add Vision
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {items?.map((item) => {
              const Icon = typeIcons[item.type] || Target;
              const gradient =
                categoryColors[item.category] || "from-slate-400 to-slate-600";
              return (
                <div
                  key={item._id}
                  className="group relative rounded-2xl overflow-hidden bg-white border border-slate-200 shadow-card hover:shadow-elevated transition-all"
                >
                  {/* Gradient header */}
                  <div
                    className={`h-32 bg-gradient-to-br ${gradient} flex items-center justify-center`}
                  >
                    <Icon size={40} className="text-white/80" />
                  </div>
                  <div className="p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="neutral" className="capitalize">
                        {item.category}
                      </Badge>
                      <Badge variant="info" className="capitalize">
                        {item.type}
                      </Badge>
                    </div>
                    <h4 className="text-sm font-semibold text-slate-900 mb-1">
                      {item.title}
                    </h4>
                    {item.description && (
                      <p className="text-xs text-slate-500 line-clamp-2">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => removeItem({ id: item._id })}
                    className="absolute top-2 right-2 p-1.5 rounded-full bg-black/30 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/50"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title="Add Vision"
        >
          <div className="space-y-3">
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Your dream, goal, or vision"
            />
            <Textarea
              label="Description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              placeholder="Describe your vision..."
            />
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Category"
                value={form.category}
                onChange={(e) =>
                  setForm({ ...form, category: e.target.value })
                }
                options={VISION_CATEGORIES.map((c) => ({
                  value: c,
                  label: c.charAt(0).toUpperCase() + c.slice(1),
                }))}
              />
              <Select
                label="Type"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
                options={[
                  { value: "text", label: "Text" },
                  { value: "quote", label: "Quote" },
                  { value: "goal", label: "Goal" },
                  { value: "link", label: "Link" },
                  { value: "image", label: "Image URL" },
                ]}
              />
            </div>
            {form.type === "image" && (
              <Input
                label="Image URL"
                value={form.link}
                onChange={(e) => setForm({ ...form, link: e.target.value })}
                placeholder="https://example.com/image.jpg"
              />
            )}
            {form.type === "link" && (
              <Input
                label="Link URL"
                value={form.link}
                onChange={(e) => setForm({ ...form, link: e.target.value })}
                placeholder="https://..."
              />
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              Add Vision
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
