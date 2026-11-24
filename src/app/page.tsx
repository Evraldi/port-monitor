"use client";

import {
  memo,
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getServerSnapshot,
  getSnapshot,
  killPortProcess,
  refresh,
  setAutoRefresh,
  subscribe,
} from "../lib/port-store";

type SortKey =
  | "port"
  | "protocol"
  | "status"
  | "pid"
  | "process_name"
  | "exe_path"
  | "cwd";

type SortDirection = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "port", label: "Port" },
  { key: "protocol", label: "Protocol" },
  { key: "status", label: "Status" },
  { key: "pid", label: "PID" },
  { key: "process_name", label: "Process Name" },
  { key: "exe_path", label: "Executable Path" },
  { key: "cwd", label: "Working Dir" },
];

// State `netstat -ano` Windows. UDP tidak punya state, jadi dibiarkan kosong
// dan ditampilkan sebagai "—".
const STATUS_COLORS: Record<string, string> = {
  LISTENING: "text-emerald-400",
  ESTABLISHED: "text-sky-400",
  SYN_SENT: "text-rose-400",
  SYN_RECEIVED: "text-amber-400",
  TIME_WAIT: "text-amber-400",
  CLOSE_WAIT: "text-orange-400",
  FIN_WAIT_1: "text-zinc-400",
  FIN_WAIT_2: "text-zinc-400",
  LAST_ACK: "text-orange-400",
  CLOSING: "text-orange-400",
  CLOSED: "text-zinc-500",
  DELETE: "text-zinc-500",
  UDP: "text-violet-400",
};

const REFRESH_INTERVAL_MS = 3_000;

interface ControlsProps {
  autoRefresh: boolean;
  search: string;
  showPaths: boolean;
  onAutoRefresh: (value: boolean) => void;
  onSearch: (value: string) => void;
  onShowPaths: (value: boolean) => void;
  onRefresh: () => void;
}

// Kontrol sengaja tidak menerima `refreshing`: perubahan data/loading tidak
// boleh meng-render ulang input search dan toggle. Indikator refresh ada di
// komponen terpisah di bawah.
const Controls = memo(function Controls({
  autoRefresh,
  search,
  showPaths,
  onAutoRefresh,
  onSearch,
  onShowPaths,
  onRefresh,
}: ControlsProps) {
  return (
    <>
      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(event) => onAutoRefresh(event.target.checked)}
          className="h-3.5 w-3.5 accent-emerald-500"
        />
        Auto-refresh
      </label>
      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={showPaths}
          onChange={(event) => onShowPaths(event.target.checked)}
          className="h-3.5 w-3.5 accent-emerald-500"
        />
        Show paths
      </label>
      <input
        type="search"
        aria-label="Cari port, PID, proses, atau path"
        placeholder="Search port, PID, process, path…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        className="w-56 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-500"
      />
      <button
        onClick={onRefresh}
        title="Refresh sekarang"
        className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"
      >
        Refresh
      </button>
    </>
  );
});

function RefreshIndicator({ refreshing }: { refreshing: boolean }) {
  return (
    <span className="w-4 text-xs text-zinc-500" aria-hidden="true">
      {refreshing ? "↻" : ""}
    </span>
  );
}

export default function Home() {
  const data = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("port");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [showPaths, setShowPaths] = useState(false);

  // Callback stabil supaya memo(Controls) benar-benar melewati render
  // ketika hanya data tabel yang berubah.
  const handleSearch = useCallback((value: string) => setSearch(value), []);
  const handleShowPaths = useCallback(
    (value: boolean) => setShowPaths(value),
    []
  );
  const handleAutoRefresh = useCallback(
    (value: boolean) => setAutoRefresh(value),
    []
  );
  const handleRefresh = useCallback(() => {
    void refresh();
  }, []);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? data.ports.filter(
          (p) =>
            p.process_name.toLowerCase().includes(q) ||
            String(p.port).includes(q) ||
            String(p.pid).includes(q) ||
            p.status.toLowerCase().includes(q) ||
            p.protocol.toLowerCase().includes(q) ||
            (showPaths &&
              (p.exe_path.toLowerCase().includes(q) ||
                p.cwd.toLowerCase().includes(q)))
        )
      : data.ports;

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [data.ports, search, sortKey, sortDir, showPaths]);

  const statusColor = (status: string) =>
    STATUS_COLORS[status.toUpperCase()] ?? "text-zinc-300";

  return (
    <div className="flex flex-1 flex-col h-full min-h-0 bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b border-zinc-800 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Port Monitor</h1>
          <p className="text-xs text-zinc-500" aria-live="polite">
            {data.loading
              ? "Loading active ports…"
              : `${filtered.length} of ${data.ports.length} connections · refresh every ${REFRESH_INTERVAL_MS / 1000}s`}
            {data.lastUpdated &&
              ` · last updated ${data.lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Controls
            autoRefresh={data.autoRefresh}
            search={search}
            showPaths={showPaths}
            onAutoRefresh={handleAutoRefresh}
            onSearch={handleSearch}
            onShowPaths={handleShowPaths}
            onRefresh={handleRefresh}
          />
          <RefreshIndicator refreshing={data.refreshing} />
        </div>
      </header>

      {/* Error / kill messages */}
      {(data.error || data.killMessage) && (
        <div className="px-6 py-2 text-sm" aria-live="polite">
          {data.error && <p className="text-rose-400">Error: {data.error}</p>}
          {data.killMessage && (
            <p
              className={
                data.killMessage.startsWith("Failed")
                  ? "text-rose-400"
                  : "text-emerald-400"
              }
            >
              {data.killMessage}
            </p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-zinc-900">
            <tr className="border-b border-zinc-800">
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  aria-sort={
                    sortKey === col.key
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  className="text-left"
                >
                  <button
                    onClick={() => toggleSort(col.key)}
                    className="flex w-full items-center gap-1 px-4 py-2 font-medium text-zinc-400 transition-colors hover:text-zinc-100"
                  >
                    {col.label}
                    <span className="text-xs" aria-hidden="true">
                      {sortKey === col.key
                        ? sortDir === "asc"
                          ? "▲"
                          : "▼"
                        : ""}
                    </span>
                  </button>
                </th>
              ))}
              <th className="px-4 py-2 text-left font-medium text-zinc-400">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={`${p.protocol}-${p.local}-${p.status}-${p.pid}`}
                className="border-b border-zinc-800/60 transition-colors hover:bg-zinc-900/60"
              >
                <td className="px-4 py-1.5 font-mono text-emerald-400">
                  {p.port}
                </td>
                <td className="px-4 py-1.5 font-mono text-zinc-400">
                  {p.protocol}
                </td>
                <td className={`px-4 py-1.5 font-mono ${statusColor(p.status)}`}>
                  {p.status || "—"}
                </td>
                <td className="px-4 py-1.5 font-mono text-zinc-300">{p.pid}</td>
                <td className="px-4 py-1.5 text-zinc-200">{p.process_name}</td>
                <td
                  className="max-w-xs truncate px-4 py-1.5 font-mono text-xs text-zinc-500"
                  title={showPaths ? p.exe_path : undefined}
                >
                  {showPaths ? p.exe_path || "—" : "Tersembunyi"}
                </td>
                <td
                  className="max-w-xs truncate px-4 py-1.5 font-mono text-xs text-zinc-500"
                  title={showPaths ? p.cwd : undefined}
                >
                  {showPaths ? p.cwd || "—" : "Tersembunyi"}
                </td>
                <td className="px-4 py-1.5">
                  <button
                    onClick={() => void killPortProcess(p)}
                    disabled={data.refreshing || data.killing !== null}
                    aria-label={`Kill ${p.process_name || "unknown"} PID ${p.pid}`}
                    className="rounded border border-rose-800/60 bg-rose-950/40 px-2 py-0.5 text-xs font-medium text-rose-400 transition-colors hover:bg-rose-900/60 disabled:opacity-40"
                  >
                    {data.killing === p.pid ? "Killing…" : "Kill"}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !data.loading && (
              <tr>
                <td
                  colSpan={COLUMNS.length + 1}
                  className="px-4 py-8 text-center text-zinc-500"
                >
                  No connections found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
