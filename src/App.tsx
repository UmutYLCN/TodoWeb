import { memo, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useDraggable,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  closestCorners,
} from '@dnd-kit/core';

type Status = 'todo' | 'in_progress' | 'completed';

type Task = {
  id: string;
  title: string;
  status: Status;
  origin?: 'manual' | 'daily';
  originId?: string;
};

type DailyItem = {
  id: string;
  title: string;
};

const STATUSES: { key: Status; label: string }[] = [
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
];

const STORAGE_KEY = 'todo-kanban:tasks';
const DAILY_KEY = 'todo-kanban:daily-items';
const LAST_SEED_KEY = 'todo-kanban:last-seed-date';

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dailyTitle, setDailyTitle] = useState('');
  const [dailyItems, setDailyItems] = useState<DailyItem[]>([]);
  const [panelTitle, setPanelTitle] = useState('');

  const sensors = useSensors(
    // Mouse: anında aktivasyon (daha seri his)
    useSensor(MouseSensor),
    // Touch: istemsiz sürüklemeyi azaltmak için hafif gecikme
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } })
  );

  // Load from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setTasks(JSON.parse(raw));
      const dailyRaw = localStorage.getItem(DAILY_KEY);
      if (dailyRaw) setDailyItems(JSON.parse(dailyRaw));
    } catch {}
  }, []);

  // Persist to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {}
  }, [tasks]);

  // Persist daily items
  useEffect(() => {
    try {
      localStorage.setItem(DAILY_KEY, JSON.stringify(dailyItems));
    } catch {}
  }, [dailyItems]);

  // Seed daily items once per day into To Do
  useEffect(() => {
    try {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const todayKey = `${yyyy}-${mm}-${dd}`;
      const last = localStorage.getItem(LAST_SEED_KEY);
      if (last !== todayKey && dailyItems.length > 0) {
        setTasks((prev) => [
          ...dailyItems.map((d) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: d.title,
            status: 'todo' as const,
            origin: 'daily' as const,
            originId: d.id,
          })),
          ...prev,
        ]);
        localStorage.setItem(LAST_SEED_KEY, todayKey);
      }
    } catch {}
    // Bu efekt mount ve dailyItems değiştiğinde çalışır; aynı günde tekrar tohumlamaz.
  }, [dailyItems]);

  const grouped = useMemo(() => {
    const position = new Map<string, number>();
    tasks.forEach((t, idx) => position.set(t.id, idx));
    return STATUSES.reduce<Record<Status, Task[]>>((acc, s) => {
      const list = tasks.filter((t) => t.status === s.key);
      if (s.key === 'todo') {
        list.sort((a, b) => {
          const aDaily = a.origin === 'daily';
          const bDaily = b.origin === 'daily';
          if (aDaily !== bDaily) return aDaily ? -1 : 1; // daily first
          // stable by original position
          return (position.get(a.id)! - position.get(b.id)!);
        });
      }
      acc[s.key] = list;
      return acc;
    }, { todo: [], in_progress: [], completed: [] });
  }, [tasks]);

  function addTask() {
    const trimmed = title.trim();
    if (!trimmed) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setTasks((prev) => [
      { id, title: trimmed, status: 'todo', origin: 'manual' },
      ...prev,
    ]);
    setTitle('');
  }

  function addTaskFromPanel() {
    const trimmed = panelTitle.trim();
    if (!trimmed) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setTasks((prev) => [
      { id, title: trimmed, status: 'todo', origin: 'manual' },
      ...prev,
    ]);
    setPanelTitle('');
  }

  function updateStatus(id: string, status: Status) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  }

  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function addDaily() {
    const trimmed = dailyTitle.trim();
    if (!trimmed) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDailyItems((prev) => [{ id, title: trimmed }, ...prev]);

    // Eğer bugün için tohumlama zaten yapıldıysa, bu günlük öğeyi To Do'ya anında ekle
    try {
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const todayKey = `${yyyy}-${mm}-${dd}`;
      const last = localStorage.getItem(LAST_SEED_KEY);
      if (last === todayKey) {
        setTasks((prev) => [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            title: trimmed,
            status: 'todo' as const,
            origin: 'daily' as const,
            originId: id,
          },
          ...prev,
        ]);
      }
    } catch {}
    setDailyTitle('');
  }

  function removeDaily(id: string) {
    setDailyItems((prev) => prev.filter((d) => d.id !== id));
    // Bu günlük şablondan türeyen mevcut kartları da kaldır
    setTasks((prev) => prev.filter((t) => !(t.origin === 'daily' && t.originId === id)));
  }

  function onDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const target = over.id as Status | string;
    if (target === 'todo' || target === 'in_progress' || target === 'completed') {
      const id = String(active.id);
      const moved = tasks.find((t) => t.id === id);
      if (moved && moved.status !== target) {
        updateStatus(id, target);
      }
    }
    setActiveId(null);
  }

  const activeTask = useMemo(() => tasks.find((t) => t.id === activeId) || null, [tasks, activeId]);

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-screen-2xl px-4 py-4 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Todo Kanban</h1>
          <div className="ml-auto flex gap-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTask()}
              placeholder="Yeni görev başlığı..."
              className="w-64 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
            />
            <button
              onClick={addTask}
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
            >
              Ekle
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        <DndContext
          sensors={sensors}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          collisionDetection={closestCorners}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4 items-start">
            <AddPanel
              title={panelTitle}
              setTitle={setPanelTitle}
              addTask={addTaskFromPanel}
              dailyTitle={dailyTitle}
              setDailyTitle={setDailyTitle}
              addDaily={addDaily}
              dailyItems={dailyItems}
              removeDaily={removeDaily}
            />
            {STATUSES.map((s) => (
              <KanbanColumn
                key={s.key}
                id={s.key}
                title={s.label}
                count={grouped[s.key].length}
              >
                {grouped[s.key].map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    onRemove={() => removeTask(t.id)}
                    activeId={activeId}
                  />
                ))}
                {grouped[s.key].length === 0 && (
                  <p className="select-none rounded-md border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">
                    Sürükleyip bırak veya yeni görev ekle
                  </p>
                )}
              </KanbanColumn>
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {activeTask ? <CardGhost task={activeTask} /> : null}
          </DragOverlay>
        </DndContext>
      </main>
    </div>
  );
}

const KanbanColumn = memo(function KanbanColumn({
  id,
  title,
  count,
  children,
}: {
  id: Status;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      className={
        'rounded-xl border bg-white transition-colors ' +
        (isOver ? 'ring-2 ring-sky-500 ring-offset-2' : '')
      }
    >
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">
          {title}
        </h2>
        <span className="text-xs text-slate-500">{count}</span>
      </header>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </section>
  );
});

function AddPanel({
  title,
  setTitle,
  addTask,
  dailyTitle,
  setDailyTitle,
  addDaily,
  dailyItems,
  removeDaily,
}: {
  title: string;
  setTitle: (v: string) => void;
  addTask: () => void;
  dailyTitle: string;
  setDailyTitle: (v: string) => void;
  addDaily: () => void;
  dailyItems: DailyItem[];
  removeDaily: (id: string) => void;
}) {
  return (
    <section className="flex flex-col rounded-xl border bg-white">
      <header className="border-b px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Yeni Görev</h2>
      </header>
      <div className="p-3 flex flex-col gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          placeholder="Görev başlığı"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
        />
        <button
          onClick={addTask}
          className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          Ekle
        </button>
        <p className="text-[11px] text-slate-400">Oluşturulan görevler To Do sütununa eklenir.</p>
      </div>

      <div className="mt-2 border-t px-4 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Günlük Sabit Görevler</h3>
        <p className="text-[11px] text-slate-400">Her gün otomatik olarak To Do sütununa eklenir.</p>
      </div>
      <div className="p-3 pt-0 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={dailyTitle}
            onChange={(e) => setDailyTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addDaily()}
            placeholder="Günlük görev başlığı"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-sky-500"
          />
          <button
            onClick={addDaily}
            className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            Ekle
          </button>
        </div>
        <ul className="mt-1 space-y-2">
          {dailyItems.length === 0 && (
            <li className="text-[11px] text-slate-400">Henüz günlük görev yok</li>
          )}
          {dailyItems.map((d) => (
            <li key={d.id} className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1">
              <span className="text-sm flex-1 truncate">{d.title}</span>
              <button
                onClick={() => removeDaily(d.id)}
                className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"
                aria-label="Sil"
                title="Sil"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CardGhost({ task }: { task: Task }) {
  const base =
    'pointer-events-none select-none rounded-xl p-4 shadow-lg border ';
  const tone =
    task.origin === 'daily'
      ? 'bg-amber-50 border-amber-300'
      : 'bg-white border-slate-200';
  return (
    <article className={base + tone}>
      <h3 className="text-sm font-medium leading-5">{task.title}</h3>
      <div className="mt-2 text-[11px] text-slate-400">Taşınıyor…</div>
    </article>
  );
}

const TaskCard = memo(function TaskCard({
  task,
  onRemove,
  activeId,
}: {
  task: Task;
  onRemove: () => void;
  activeId: string | null;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });
  const isActive = activeId === task.id;
  const style = transform && !isActive
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, willChange: 'transform' as const }
    : { willChange: 'auto' as const };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={
        'group select-none rounded-xl p-4 shadow-sm transition ' +
        'hover:shadow-md cursor-grab active:cursor-grabbing ' +
        (task.origin === 'daily'
          ? 'bg-amber-50 border border-amber-300 '
          : 'bg-white border border-slate-200 ') +
        (isActive ? 'opacity-0' : isDragging ? 'opacity-70 shadow-lg' : '')
      }
    >
      <div className="flex items-start gap-2">
        <button
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-grab active:cursor-grabbing"
          title="Taşı"
          aria-label="Taşı"
          {...listeners}
          {...attributes}
        >
          ⋮⋮
        </button>
        <h3 className="text-sm font-medium flex-1 leading-5">
          {task.title}
        </h3>
        {task.origin !== 'daily' && (
          <button
            onPointerDown={stop}
            onMouseDown={stop}
            onTouchStart={stop}
            onClick={onRemove}
            className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"
            aria-label="Sil"
            title="Sil"
          >
            ✕
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-slate-400">
        <span>Taşımak için sürükle</span>
      </div>
    </article>
  );
});
