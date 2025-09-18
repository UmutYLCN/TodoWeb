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
  startedAt?: number | null;
  accumulatedMs?: number;
  paused?: boolean;
  subtasks?: SubTask[];
};

type DailyItem = {
  id: string;
  title: string;
};

type SubTask = {
  id: string;
  title: string;
  done: boolean;
};

const STATUSES: { key: Status; label: string }[] = [
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'completed', label: 'Completed' },
];

const STORAGE_KEY = 'todo-kanban:tasks';
const DAILY_KEY = 'todo-kanban:daily-items';
const LAST_SEED_KEY = 'todo-kanban:last-seed-date';

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hh = h.toString().padStart(2, '0');
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function transitionTask(t: Task, status: Status, at: number): Task {
  if (t.status === status) {
    if (status === 'in_progress') {
      return { ...t, startedAt: t.startedAt ?? at, accumulatedMs: t.accumulatedMs ?? 0 };
    }
    return t;
  }
  if (t.status === 'in_progress' && status !== 'in_progress') {
    const acc = (t.accumulatedMs ?? 0) + (t.startedAt ? at - t.startedAt : 0);
    return { ...t, status, accumulatedMs: acc, startedAt: null };
  }
  if (t.status !== 'in_progress' && status === 'in_progress') {
    return { ...t, status, startedAt: at, accumulatedMs: t.accumulatedMs ?? 0 };
  }
  return { ...t, status };
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dailyTitle, setDailyTitle] = useState('');
  const [dailyItems, setDailyItems] = useState<DailyItem[]>([]);
  const [panelTitle, setPanelTitle] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<'board' | 'stats'>('board');

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

  // Tick timers every second
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Ensure only the topmost non-paused in-progress task runs (others paused or below are stopped)
  useEffect(() => {
    const firstInProgress = tasks.find((t) => t.status === 'in_progress' && !t.paused);
    if (!firstInProgress) return; // none running
    const runnerId = firstInProgress.id;
    const at = Date.now();
    let changed = false;
    const next = tasks.map((t) => {
      if (t.status !== 'in_progress') return t;
      if (t.id === runnerId) {
        if (t.paused) return t; // don't auto start paused
        if (!t.startedAt) {
          changed = true;
          return { ...t, startedAt: at, accumulatedMs: t.accumulatedMs ?? 0 };
        }
        return t;
      }
      if (t.startedAt) {
        const acc = (t.accumulatedMs ?? 0) + (t.startedAt ? at - t.startedAt : 0);
        changed = true;
        return { ...t, startedAt: null, accumulatedMs: acc };
      }
      return t;
    });
    if (changed) setTasks(next);
  }, [tasks]);

  // Tick each second to update timers
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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
            startedAt: null,
            accumulatedMs: 0,
            paused: false,
            subtasks: [],
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
      { id, title: trimmed, status: 'todo', origin: 'manual', startedAt: null, accumulatedMs: 0, paused: false, subtasks: [] },
      ...prev,
    ]);
    setTitle('');
  }

  function addTaskFromPanel() {
    const trimmed = panelTitle.trim();
    if (!trimmed) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setTasks((prev) => [
      { id, title: trimmed, status: 'todo', origin: 'manual', startedAt: null, accumulatedMs: 0, paused: false, subtasks: [] },
      ...prev,
    ]);
    setPanelTitle('');
  }

  function updateStatus(id: string, status: Status) {
    const at = Date.now();
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...transitionTask(t, status, at), paused: status === 'in_progress' ? false : t.paused } : t)));
  }

  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function updateTitle(id: string, next: string) {
    const title = next.trim();
    if (!title) return;
    const current = tasks.find((t) => t.id === id);
    if (!current) return;
    // Günlükten türeyen bir kart düzenleniyorsa: hem şablonu hem de aynı şablondan gelen
    // tüm mevcut kartların başlığını güncelle.
    if (current.origin === 'daily' && current.originId) {
      setDailyItems((prev) => prev.map((d) => (d.id === current.originId ? { ...d, title } : d)));
      setTasks((prev) =>
        prev.map((t) =>
          t.origin === 'daily' && t.originId === current.originId ? { ...t, title } : t.id === id ? { ...t, title } : t
        )
      );
    } else {
      // Normal kart: sadece kendisini güncelle
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    }
  }

  // Subtasks
  function addSubtask(taskId: string, title: string) {
    const t = title.trim();
    if (!t) return;
    const sid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, subtasks: [...(x.subtasks ?? []), { id: sid, title: t, done: false }] } : x)));
  }

  function toggleSubtask(taskId: string, subId: string) {
    setTasks((prev) =>
      prev.map((x) =>
        x.id === taskId
          ? { ...x, subtasks: (x.subtasks ?? []).map((s) => (s.id === subId ? { ...s, done: !s.done } : s)) }
          : x
      )
    );
  }

  function removeSubtask(taskId: string, subId: string) {
    setTasks((prev) => prev.map((x) => (x.id === taskId ? { ...x, subtasks: (x.subtasks ?? []).filter((s) => s.id !== subId) } : x)));
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
            startedAt: null,
            accumulatedMs: 0,
            paused: false,
            subtasks: [],
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
    // Dropped on a column: just change status
    if (target === 'todo' || target === 'in_progress' || target === 'completed') {
      const id = String(active.id);
      const moved = tasks.find((t) => t.id === id);
      if (moved && moved.status !== target) {
        updateStatus(id, target);
      }
    } else {
      // Dropped on another card: reorder and possibly move to that card's column
      const activeId = String(active.id);
      const overTask = tasks.find((t) => t.id === String(target));
      if (!overTask) return;
      setTasks((prev) => {
        const fromIndex = prev.findIndex((t) => t.id === activeId);
        if (fromIndex === -1) return prev;
        const item = { ...transitionTask(prev[fromIndex], overTask.status as Status, Date.now()), paused: overTask.status === 'in_progress' ? false : prev[fromIndex].paused };
        const arr = prev.slice();
        arr.splice(fromIndex, 1);
        let toIndex = arr.findIndex((t) => t.id === overTask.id);
        if (toIndex < 0) toIndex = 0;
        arr.splice(toIndex, 0, item);
        return arr;
      });
    }
    setActiveId(null);
  }

  const activeTask = useMemo(() => tasks.find((t) => t.id === activeId) || null, [tasks, activeId]);

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white/70 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-screen-2xl px-4 py-4 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Todo</h1>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setView('board')}
              className={`rounded-md px-3 py-2 text-sm font-medium ${view === 'board' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-700'}`}
            >
              Board
            </button>
            <button
              onClick={() => setView('stats')}
              className={`rounded-md px-3 py-2 text-sm font-medium ${view === 'stats' ? 'bg-slate-900 text-white' : 'bg-white border border-slate-300 text-slate-700'}`}
            >
              İstatistikler
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-screen-2xl px-4 py-6">
        {view === 'board' ? (
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
              totalMs={tasks.reduce((sum, t) => sum + (t.accumulatedMs ?? 0) + (t.status === 'in_progress' && t.startedAt ? now - t.startedAt : 0), 0)}
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
                    onUpdateTitle={(next) => updateTitle(t.id, next)}
                    activeId={activeId}
                    now={now}
                    topInProgressId={tasks.find((x) => x.status === 'in_progress')?.id || null}
                    onToggleRun={() => {
                      setTasks((prev) => prev.map((x) => {
                        if (x.id !== t.id) return x;
                        if (x.status !== 'in_progress') return x;
                        const at = Date.now();
                        if (x.paused || !x.startedAt) {
                          // resume
                          return { ...x, paused: false, startedAt: at };
                        } else {
                          // pause
                          const acc = (x.accumulatedMs ?? 0) + (x.startedAt ? at - x.startedAt : 0);
                          return { ...x, startedAt: null, accumulatedMs: acc, paused: true };
                        }
                      }));
                    }}
                    onAddSubtask={(title) => addSubtask(t.id, title)}
                    onToggleSubtask={(subId) => toggleSubtask(t.id, subId)}
                    onRemoveSubtask={(subId) => removeSubtask(t.id, subId)}
                  />
                ))}
                {grouped[s.key].length === 0 && (
                  <p className="select-none rounded-md border border-dashed border-slate-300 p-6 text-center text-xs text-slate-400">
                    {s.key === 'in_progress'
                      ? 'Henüz devam eden görev yok. To Do’dan buraya taşıyarak başlat.'
                      : s.key === 'completed'
                      ? 'Henüz tamamlanan görev yok. Görevleri tamamladığında burada görünecek.'
                      : 'Sürükleyip bırak veya yeni görev ekle'}
                  </p>
                )}
              </KanbanColumn>
            ))}
          </div>
          <DragOverlay dropAnimation={null}>
            {activeTask ? <CardGhost task={activeTask} /> : null}
          </DragOverlay>
        </DndContext>
        ) : (
          <StatsView tasks={tasks} now={now} />
        )}
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

function StatsView({ tasks, now }: { tasks: Task[]; now: number }) {
  const totalMs = tasks.reduce((sum, t) => sum + (t.accumulatedMs ?? 0) + (t.status === 'in_progress' && t.startedAt ? now - t.startedAt : 0), 0);
  const counts = {
    todo: tasks.filter(t => t.status === 'todo').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
  };
  const byStatusMs = {
    todo: tasks.filter(t=>t.status==='todo').reduce((s,t)=>s+(t.accumulatedMs??0),0),
    in_progress: tasks.filter(t=>t.status==='in_progress').reduce((s,t)=>s+(t.accumulatedMs??0)+(t.startedAt? now - t.startedAt:0),0),
    completed: tasks.filter(t=>t.status==='completed').reduce((s,t)=>s+(t.accumulatedMs??0),0),
  };
  const top = [...tasks]
    .map(t=>({
      id:t.id,title:t.title,
      ms:(t.accumulatedMs??0)+(t.status==='in_progress'&&t.startedAt? now-t.startedAt:0)
    }))
    .sort((a,b)=>b.ms-a.ms)
    .slice(0,5);
  return (
    <section className="grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="rounded-xl border bg-white p-4">
          <div className="text-xs text-slate-500">Toplam Süre</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{formatDuration(totalMs)}</div>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <div className="text-xs text-slate-500">To Do</div>
          <div className="mt-1 text-2xl font-semibold">{counts.todo}</div>
          <div className="mt-1 text-[11px] text-slate-500">Süre: {formatDuration(byStatusMs.todo)}</div>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <div className="text-xs text-slate-500">In Progress</div>
          <div className="mt-1 text-2xl font-semibold">{counts.in_progress}</div>
          <div className="mt-1 text-[11px] text-slate-500">Süre: {formatDuration(byStatusMs.in_progress)}</div>
        </div>
        <div className="rounded-xl border bg-white p-4">
          <div className="text-xs text-slate-500">Completed</div>
          <div className="mt-1 text-2xl font-semibold">{counts.completed}</div>
          <div className="mt-1 text-[11px] text-slate-500">Süre: {formatDuration(byStatusMs.completed)}</div>
        </div>
      </div>

      <div className="rounded-xl border bg-white p-4">
        <div className="text-sm font-semibold">En Uzun Süre Alan 5 Görev</div>
        <ul className="mt-2 space-y-2">
          {top.length === 0 && <li className="text-xs text-slate-500">Henüz görev yok</li>}
          {top.map(item => (
            <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="truncate">{item.title}</span>
              <span className="tabular-nums text-slate-600 text-xs">{formatDuration(item.ms)}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function AddPanel({
  title,
  setTitle,
  addTask,
  dailyTitle,
  setDailyTitle,
  addDaily,
  dailyItems,
  removeDaily,
  totalMs,
}: {
  title: string;
  setTitle: (v: string) => void;
  addTask: () => void;
  dailyTitle: string;
  setDailyTitle: (v: string) => void;
  addDaily: () => void;
  dailyItems: DailyItem[];
  removeDaily: (id: string) => void;
  totalMs: number;
}) {
  return (
    <section className="flex flex-col rounded-xl border bg-white">
      <header className="border-b px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600">Yeni Görev</h2>
      </header>
      <div className="flex items-center justify-center py-4">
        <div className="flex h-40 w-40 items-center justify-center rounded-full bg-white shadow-md ring-4 ring-sky-200">
          <span className="text-2xl leading-none font-semibold text-slate-700 tabular-nums">
            {formatDuration(totalMs)}
          </span>
        </div>
      </div>
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
  const base = 'pointer-events-none select-none rounded-xl p-4 shadow-lg border ';
  const tone =
    task.status === 'completed'
      ? 'bg-emerald-50 border-emerald-300'
      : task.origin === 'daily'
      ? 'bg-amber-50 border-amber-300'
      : 'bg-white border-slate-200';
  return (
    <article className={base + tone}>
      <div className="flex items-center gap-2">
        {task.status === 'completed' && (
          <span className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs border border-emerald-300">✓</span>
        )}
        <h3 className={'text-sm font-medium ' + (task.status === 'completed' ? 'text-slate-500 line-through' : '')}>
          {task.title}
        </h3>
      </div>
      <div className="mt-2 text-[11px] text-slate-400">Taşınıyor…</div>
    </article>
  );
}

const TaskCard = memo(function TaskCard({
  task,
  onRemove,
  onUpdateTitle,
  activeId,
  now,
  topInProgressId,
  onToggleRun,
  onAddSubtask,
  onToggleSubtask,
  onRemoveSubtask,
}: {
  task: Task;
  onRemove: () => void;
  onUpdateTitle: (next: string) => void;
  activeId: string | null;
  now: number;
  topInProgressId: string | null;
  onToggleRun: () => void;
  onAddSubtask: (title: string) => void;
  onToggleSubtask: (subId: string) => void;
  onRemoveSubtask: (subId: string) => void;
}) {
  const { attributes, listeners, setNodeRef: setDragRef, transform, isDragging } = useDraggable({ id: task.id });
  const { setNodeRef: setDropRef } = useDroppable({ id: task.id });
  const isActive = activeId === task.id;
  const style = transform && !isActive
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, willChange: 'transform' as const }
    : { willChange: 'auto' as const };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const [editing, setEditing] = useState(false);
  const [temp, setTemp] = useState(task.title);
  useEffect(() => {
    if (!editing) setTemp(task.title);
  }, [task.title, editing]);
  const commit = () => {
    const v = temp.trim();
    if (v && v !== task.title) onUpdateTitle(v);
    setEditing(false);
  };
  const cancel = () => {
    setTemp(task.title);
    setEditing(false);
  };
  const [openSubs, setOpenSubs] = useState(false);
  const [subTitle, setSubTitle] = useState('');

  return (
    <div ref={setDropRef}>
      <article
        ref={setDragRef}
        style={style}
        className={
          'group select-none rounded-xl p-4 shadow-sm transition ' +
          'hover:shadow-md ' +
          (task.status === 'completed'
            ? 'bg-emerald-50 border border-emerald-300 '
            : task.origin === 'daily'
            ? 'bg-amber-50 border border-amber-300 '
            : 'bg-white border border-slate-200 ') +
          (isActive ? 'opacity-0' : isDragging ? 'opacity-70 shadow-lg' : '')
        }
      >
        {/* In Progress indicator handled near title */}
        <div className="flex items-center gap-2">
          {task.status === 'completed' && (
            <span className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xs border border-emerald-300" title="Tamamlandı">✓</span>
          )}
          {task.status === 'in_progress' && task.id === topInProgressId && (
            <button
              className={
                'shrink-0 inline-flex h-5 w-5 items-center justify-center ' +
                (task.origin === 'daily' ? 'text-amber-300' : 'text-sky-400')
              }
              title={task.paused || !task.startedAt ? 'Başlat' : 'Durdur'}
              aria-label={task.paused || !task.startedAt ? 'Başlat' : 'Durdur'}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleRun();
              }}
            >
              {task.paused || !task.startedAt ? (
                <span className="block leading-none text-[12px]">▶</span>
              ) : (
                <span className="relative inline-flex h-5 w-5 items-center justify-center">
                  <span className="pointer-events-none absolute inset-0 rounded-full border border-current opacity-40" />
                  <span className="relative block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                </span>
              )}
            </button>
          )}
          {task.status === 'in_progress' && task.id !== topInProgressId && (
            <span
              className="shrink-0 inline-flex h-5 w-5 items-center justify-center text-slate-300"
              title="Sırada"
            >
              <span className="block h-4 w-4 rounded-full border-2 border-current" />
            </span>
          )}
          <div className="flex-1 flex items-center gap-2 min-w-0">
            {editing ? (
              <input
                className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-sky-500"
                value={temp}
                onChange={(e) => setTemp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') cancel();
                }}
                onBlur={commit}
                autoFocus
                onPointerDown={stop}
                onMouseDown={stop}
                onTouchStart={stop}
              />
            ) : (
              <h3
                className={
                  'flex-1 truncate text-sm font-medium ' +
                  (task.status === 'completed' ? 'text-slate-500 line-through' : 'text-slate-900')
                }
                onDoubleClick={() => setEditing(true)}
                title={task.title}
              >
                {task.title}
              </h3>
            )}
            {/* Timer moved next to subtasks toggle */}
          </div>
          {task.status === 'todo' && task.origin !== 'daily' && (
            <button
              onPointerDown={stop}
              onMouseDown={stop}
              onTouchStart={stop}
              onClick={onRemove}
              className="rounded inline-flex h-6 w-6 items-center justify-center text-slate-400 hover:text-red-600 hover:bg-red-50"
              aria-label="Sil"
              title="Sil"
            >
              ✕
            </button>
          )}
          <button
            className="shrink-0 rounded inline-flex h-6 w-6 items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-grab active:cursor-grabbing"
            title="Taşı"
            aria-label="Taşı"
            {...listeners}
            {...attributes}
          >
            ⋮⋮
          </button>
        </div>
        {/* Subtasks */}
        <div className="mt-3">
          <div className="flex items-center justify-between">
            <button
              className="text-xs text-slate-500 hover:text-slate-700"
              onPointerDown={stop}
              onMouseDown={stop}
              onTouchStart={stop}
              onClick={(e) => { e.stopPropagation(); setOpenSubs((v) => !v); }}
            >
              {openSubs ? 'Alt görevleri gizle' : `Alt görevler (${(task.subtasks?.filter(s=>s.done).length||0)}/${task.subtasks?.length||0})`}
            </button>
            {task.status === 'in_progress' && task.id === topInProgressId && (
              <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                {formatDuration((task.accumulatedMs ?? 0) + (task.startedAt ? now - task.startedAt : 0))}
              </span>
            )}
          </div>
          {openSubs && (
            <div className="mt-2 space-y-2">
              {(task.subtasks ?? []).length === 0 && (
                <p className="text-[11px] text-slate-400">Henüz alt görev yok</p>
              )}
              <ul className="space-y-1">
                {(task.subtasks ?? []).map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <button
                      onPointerDown={stop}
                      onMouseDown={stop}
                      onTouchStart={stop}
                      onClick={(e) => { e.stopPropagation(); onToggleSubtask(s.id); }}
                      className={
                        'inline-flex h-4 w-4 items-center justify-center rounded border ' +
                        (s.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 text-transparent')
                      }
                      aria-label={s.done ? 'Alt görev tamamlandı' : 'Alt görevi tamamla'}
                    >
                      ✓
                    </button>
                    <span className={"flex-1 truncate " + (s.done ? 'line-through text-slate-400' : '')}>{s.title}</span>
                    <button
                      onPointerDown={stop}
                      onMouseDown={stop}
                      onTouchStart={stop}
                      onClick={(e) => { e.stopPropagation(); onRemoveSubtask(s.id); }}
                      className="rounded p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"
                      aria-label="Alt görevi sil"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2">
                <input
                  value={subTitle}
                  onChange={(e) => setSubTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { onAddSubtask(subTitle); setSubTitle(''); }
                  }}
                  onPointerDown={stop}
                  onMouseDown={stop}
                  onTouchStart={stop}
                  placeholder="Alt görev ekle"
                  className="w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-sky-500"
                />
                <button
                  onPointerDown={stop}
                  onMouseDown={stop}
                  onTouchStart={stop}
                  onClick={(e) => { e.stopPropagation(); onAddSubtask(subTitle); setSubTitle(''); }}
                  className="rounded-md bg-sky-600 px-2 py-1 text-xs font-medium text-white hover:bg-sky-700"
                >
                  Ekle
                </button>
              </div>
            </div>
          )}
        </div>
      </article>
    </div>
  );
});
