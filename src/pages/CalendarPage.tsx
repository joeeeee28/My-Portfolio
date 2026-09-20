import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { TopBar } from "@/components/layout/TopBar";
import { Card, Button, Modal, Input, Select, Textarea } from "@/components/ui";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import {
  getDaysInMonth,
  getFirstDayOfMonth,
  formatDate,
} from "@/lib/utils";

export default function CalendarPage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showModal, setShowModal] = useState(false);
  const events = useQuery(api.calendar.list, {
    startDate: new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      1
    ).getTime(),
    endDate: new Date(
      currentDate.getFullYear(),
      currentDate.getMonth() + 1,
      0
    ).getTime(),
  });
  const createEvent = useMutation(api.calendar.create);

  const [form, setForm] = useState({
    title: "",
    description: "",
    startTime: "",
    endTime: "",
    type: "event",
  });

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);

  const days: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) days.push(null);
  for (let i = 1; i <= daysInMonth; i++) days.push(i);

  const today = new Date();
  const isToday = (day: number) =>
    day === today.getDate() &&
    month === today.getMonth() &&
    year === today.getFullYear();

  const getEventsForDay = (day: number) => {
    const dayStart = new Date(year, month, day).getTime();
    const dayEnd = dayStart + 86400000;
    return (
      events?.filter(
        (e) => e.startTime >= dayStart && e.startTime < dayEnd
      ) || []
    );
  };

  const prevMonth = () =>
    setCurrentDate(new Date(year, month - 1, 1));
  const nextMonth = () =>
    setCurrentDate(new Date(year, month + 1, 1));

  const handleSubmit = async () => {
    if (!form.title.trim() || !form.startTime) return;
    await createEvent({
      title: form.title,
      description: form.description || undefined,
      startTime: new Date(form.startTime).getTime(),
      endTime: form.endTime
        ? new Date(form.endTime).getTime()
        : undefined,
      allDay: false,
      type: form.type,
    });
    setForm({ title: "", description: "", startTime: "", endTime: "", type: "event" });
    setShowModal(false);
  };

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  return (
    <div>
      <TopBar
        title="Calendar"
        subtitle={`${monthNames[month]} ${year}`}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowModal(true)}
          >
            <Plus size={14} />
            New Event
          </Button>
        }
      />

      <div className="p-4 lg:p-6 max-w-7xl">
        <Card padding={false}>
          {/* Month navigation */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded-lg hover:bg-slate-100"
            >
              <ChevronLeft size={18} />
            </button>
            <h3 className="text-sm font-semibold text-slate-900">
              {monthNames[month]} {year}
            </h3>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded-lg hover:bg-slate-100"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 border-b border-slate-100">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
              <div
                key={d}
                className="text-center text-xs font-medium text-slate-500 py-2"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Calendar grid */}
          <div className="grid grid-cols-7">
            {days.map((day, i) => (
              <div
                key={i}
                className={`min-h-[80px] p-1.5 border-b border-r border-slate-100 last:border-r-0 ${
                  day === null ? "bg-slate-50" : ""
                }`}
              >
                {day !== null && (
                  <>
                    <div
                      className={`text-xs font-medium mb-1 w-6 h-6 flex items-center justify-center rounded-full ${
                        isToday(day)
                          ? "bg-brand-500 text-white"
                          : "text-slate-700"
                      }`}
                    >
                      {day}
                    </div>
                    <div className="space-y-0.5">
                      {getEventsForDay(day).slice(0, 3).map((event) => (
                        <div
                          key={event._id}
                          className="text-[10px] px-1 py-0.5 rounded bg-brand-50 text-brand-700 truncate font-medium"
                        >
                          {event.title}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Modal
          open={showModal}
          onClose={() => setShowModal(false)}
          title="New Event"
        >
          <div className="space-y-3">
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Event name"
            />
            <Textarea
              label="Description"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Start Time"
                type="datetime-local"
                value={form.startTime}
                onChange={(e) =>
                  setForm({ ...form, startTime: e.target.value })
                }
              />
              <Input
                label="End Time"
                type="datetime-local"
                value={form.endTime}
                onChange={(e) =>
                  setForm({ ...form, endTime: e.target.value })
                }
              />
            </div>
            <Select
              label="Type"
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              options={[
                { value: "event", label: "Event" },
                { value: "timeblock", label: "Time Block" },
                { value: "reminder", label: "Reminder" },
              ]}
            />
          </div>
          <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-slate-100">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSubmit}>
              Create Event
            </Button>
          </div>
        </Modal>
      </div>
    </div>
  );
}
