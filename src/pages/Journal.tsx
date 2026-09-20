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
  Badge,
  EmptyState,
} from "@/components/ui";
import { Plus, BookOpen, Trash2, Edit3 } from "lucide-react";
import { formatDate, MOOD_EMOJIS } from "@/lib/utils";

export default function Journal() {
  const [showModal, setShowModal] = useState(false);
  const [editEntry, setEditEntry] = useState<any>(null);
  const entries = useQuery(api.journal.list, {});
  const createEntry = useMutation(api.journal.create);
  const updateEntry = useMutation(api.journal.update);
  const removeEntry = useMutation(api.journal.remove);

  const [form, setForm] = useState({
    title: "",
    content: "",
    mood: "neutral",
    tags: "",
    gratitude: "",
    wins: "",
    challenges: "",
  });

  const handleSubmit = async () => {
    if (!form.title.trim() || !form.content.trim()) return;
    const tags = form.tags
      ? form.tags.split(",").map((t) => t.trim())
      : undefined;
    if (editEntry) {
      await updateEntry({
        id: editEntry._id,
        title: form.title,
        content: form.content,
        mood: form.mood,
        tags,
        gratitude: form.gratitude || undefined,
        wins: form.wins || undefined,
        challenges: form.challenges || undefined,
      });
    } else {
      await createEntry({
        title: form.title,
        content: form.content,
        mood: form.mood,
        tags,
        gratitude: form.gratitude || undefined,
        wins: form.wins || undefined,
        challenges: form.challenges || undefined,
        date: Date.now(),
      });
    }
    setForm({
      title: "",
      content: "",
      mood: "neutral",
      tags: "",
      gratitude: "",
      wins: "",
      challenges: "",
    });
    setEditEntry(null);
    setShowModal(false);
  };

  const openEdit = (entry: any) => {
    setEditEntry(entry);
    setForm({
      title: entry.title,
      content: entry.content,
      mood: entry.mood,
      tags: entry.tags?.join(", ") || "",
      gratitude: entry.gratitude || "",
      wins: entry.wins || "",
      challenges: entry.challenges || "",
    });
    setShowModal(true);
  };

  const sortedEntries = [...(entries || [])].sort((a, b) => b.date - a.date);

  return (
    <div>
      <TopBar
        title="Journal"
        subtitle={`${entries?.length || 0} entries`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditEntry(null);
              setForm({
                title: "",
                content: "",
                mood: "neutral",
                tags: "",
                gratitude: "",
                wins: "",
                challenges: "",
              });
              setShowModal(true);
            }}
          >
            <Plus size={14} />
            New Entry
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-4xl">
        {sortedEntries.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={24} />}
            title="No journal entries yet"
            description="Start writing to capture your thoughts and reflections"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <Plus size={14} />
                Write Entry
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            {sortedEntries.map((entry) => (
              <Card key={entry._id}>
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">
                      {MOOD_EMOJIS[entry.mood] || "😐"}
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">
                        {entry.title}
                      </h3>
                      <p className="text-xs text-slate-500">
                        {formatDate(entry.date)}
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEdit(entry)}
                      className="p-1 rounded hover:bg-slate-100 text-slate-400"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      onClick={() => removeEntry({ id: entry._id })}
                      className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed mb-3">
                  {entry.content}
                </p>
                {entry.tags && entry.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {entry.tags.map((tag) => (
                      <Badge key={tag} variant="info">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-100">
                  {entry.gratitude && (
                    <div>
                      <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide mb-1">
                        Gratitude
                      </p>
                      <p className="text-xs text-slate-600">{entry.gratitude}</p>
                    </div>
                  )}
                  {entry.wins && (
                    <div>
                      <p className="text-[10px] font-semibold text-blue-600 uppercase tracking-wide mb-1">
                        Wins
                      </p>
                      <p className="text-xs text-slate-600">{entry.wins}</p>
                    </div>
                  )}
                  {entry.challenges && (
                    <div>
                      <p className="text-[10px] font-semibold text-amber-600 uppercase tracking-wide mb-1">
                        Challenges
                      </p>
                      <p className="text-xs text-slate-600">
                        {entry.challenges}
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title={editEntry ? "Edit Entry" : "New Journal Entry"}
        >
          <div className="space-y-3">
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="How was your day?"
            />
            <Textarea
              label="Content"
              value={form.content}
              onChange={(e) =>
                setForm({ ...form, content: e.target.value })
              }
              placeholder="Write your thoughts..."
            />
            <Select
              label="Mood"
              value={form.mood}
              onChange={(e) => setForm({ ...form, mood: e.target.value })}
              options={Object.entries(MOOD_EMOJIS).map(([value, emoji]) => ({
                value,
                label: `${emoji} ${value.charAt(0).toUpperCase() + value.slice(1)}`,
              }))}
            />
            <Input
              label="Tags (comma-separated)"
              value={form.tags}
              onChange={(e) => setForm({ ...form, tags: e.target.value })}
              placeholder="e.g., reflection, gratitude"
            />
            <Textarea
              label="Gratitude"
              value={form.gratitude}
              onChange={(e) =>
                setForm({ ...form, gratitude: e.target.value })
              }
              placeholder="What are you grateful for today?"
            />
            <div className="grid grid-cols-2 gap-3">
              <Textarea
                label="Wins"
                value={form.wins}
                onChange={(e) => setForm({ ...form, wins: e.target.value })}
                placeholder="What went well?"
              />
              <Textarea
                label="Challenges"
                value={form.challenges}
                onChange={(e) =>
                  setForm({ ...form, challenges: e.target.value })
                }
                placeholder="What was difficult?"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              {editEntry ? "Update" : "Save"} Entry
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
