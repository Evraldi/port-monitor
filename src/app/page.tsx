"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type SortKey =
  | "port"
  | "protocol"
  | "status"
  | "pid"
  | "process_name"
  | "exe_path"
  | "cwd";

type SortDirection = "asc" | "desc";

interface PortInfo {
  port: number;
  protocol: string;
  status: string;
  pid: number;
  process_name: string;
  exe_path: string;
  cwd: string;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "port", label: "Port" },
  { key: "protocol", label: "Protocol" },
  { key: "status", label: "Status" },
  { key: "pid", label: "PID" },
  { key: "process_name", label: "Process Name" },
  { key: "exe_path", label: "Executable Path" },
  { key: "cwd", label: "Working Dir" },
];

const STATUS_COLORS: Record<string, string> = {
  LISTENING: "text-emerald-400",
  ESTABLISHED: "text-sky-400",
  TIME_WAIT: "text-amber-400",
  CLOSE_WAIT: "text-orange-400",
  SYN_SENT: "text-rose-400",
  FIN_WAIT_1: "text-zinc-400",
  FIN_WAIT_2: "text-zinc-400",
  CLOSED: "text-zinc-500",
  UDP: "text-violet-400",
};

export default function Home() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("port");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [killing, setKilling] = useState<number | null>(null);
  const [killMessage, setKillMessage] = useState<string | null>(null);

  const loadPorts = useCallback(async () => {
    try {
      const data = await invoke<PortInfo[]>("get_active_ports");
      setPorts(data);
      setError(null);
      setLastUpdated(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch once on mount; the user refreshes manually via the button.
    // This avoids spawning `netstat` on a timer, which flashes a console
    // window each time. Defer so setState happens in a callback, not
    // synchronously in the effect body (avoids cascading renders).
    const initial = window.setTimeout(loadPorts, 0);
    return () => window.clearTimeout(initial);
  }, [loadPorts]);

  const handleKill = async (pid: number) => {
    if (!window.confirm(`Kill process ${pid}?`)) return;
    setKilling(pid);
    setKillMessage(null);
    try {
      await invoke("kill_process", { pid });
      setKillMessage(`Process ${pid} killed.`);
      await loadPorts();
    } catch (e) {
      setKillMessage(`Failed to kill ${pid}: ${String(e)}`);
    } finally {
      setKilling(null);
    }
  };

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
      ? ports.filter(
          (p) =>
            p.process_name.toLowerCase().includes(q) ||
            p.exe_path.toLowerCase().includes(q) ||
            p.cwd.toLowerCase().includes(q) ||
            String(p.port).includes(q) ||
            String(p.pid).includes(q) ||
            p.status.toLowerCase().includes(q) ||
            p.protocol.toLowerCase().includes(q)
        )
      : ports;

    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [ports, search, sortKey, sortDir]);

  const statusColor = (status: string) =>
    STATUS_COLORS[status.toUpperCase()] ?? "text-zinc-300";

  return (
    <div className="flex flex-1 flex-col h-full bg-zinc-950 text-zinc-200">
      {/* Header */}
      <header className="flex flex-col gap-4 border-b border-zinc-800 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">
            Port Monitor
          </h1>
          <p className="text-xs text-zinc-500">
            {loading && ports.length === 0
              ? "Loading active ports…"
              : `${filtered.length} of ${ports.length} connections`}
            {lastUpdated &&
              ` · last updated ${lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="search"
            placeholder="Search port, PID, process, path…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-500 outline-none focus:border-zinc-500"
          />
          <button
            onClick={loadPorts}
            disabled={loading}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* Error / kill messages */}
      {(error || killMessage) && (
        <div className="px-6 py-2 text-sm">
          {error && <p className="text-rose-400">Error: {error}</p>}
          {killMessage && (
            <p
              className={
                killMessage.startsWith("Failed") ? "text-rose-400" : "text-emerald-400"
              }
            >
              {killMessage}
            </p>
          )}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-zinc-900">
            <tr className="border-b border-zinc-800">
              {COLUMNS.map((col) => (
                <th key={col.key} className="text-left">
                  <button
                    onClick={() => toggleSort(col.key)}
                    className="flex w-full items-center gap-1 px-4 py-2 font-medium text-zinc-400 transition-colors hover:text-zinc-100"
                  >
                    {col.label}
                    <span className="text-xs">
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
            {filtered.map((p, i) => (
              <tr
                key={`${p.port}-${p.protocol}-${p.pid}-${i}`}
                className="border-b border-zinc-800/60 transition-colors hover:bg-zinc-900/60"
              >
                <td className="px-4 py-1.5 font-mono text-emerald-400">
                  {p.port}
                </td>
                <td className="px-4 py-1.5 font-mono text-zinc-400">
                  {p.protocol}
                </td>
                <td
                  className={`px-4 py-1.5 font-mono ${statusColor(p.status)}`}
                >
                  {p.status || "—"}
                </td>
                <td className="px-4 py-1.5 font-mono text-zinc-300">
                  {p.pid}
                </td>
                <td className="px-4 py-1.5 text-zinc-200">
                  {p.process_name}
                </td>
                <td className="max-w-xs truncate px-4 py-1.5 font-mono text-xs text-zinc-500" title={p.exe_path}>
                  {p.exe_path || "—"}
                </td>
                <td className="max-w-xs truncate px-4 py-1.5 font-mono text-xs text-zinc-500" title={p.cwd}>
                  {p.cwd || "—"}
                </td>
                <td className="px-4 py-1.5">
                  <button
                    onClick={() => handleKill(p.pid)}
                    disabled={killing !== null}
                    className="rounded border border-rose-800/60 bg-rose-950/40 px-2 py-0.5 text-xs font-medium text-rose-400 transition-colors hover:bg-rose-900/60 disabled:opacity-40"
                  >
                    {killing === p.pid ? "Killing…" : "Kill"}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
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
