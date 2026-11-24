import { invoke } from "@tauri-apps/api/core";

export interface PortInfo {
  port: number;
  protocol: string;
  status: string;
  local: string;
  pid: number;
  process_name: string;
  exe_path: string;
  cwd: string;
}

export interface PortSnapshot {
  ports: PortInfo[];
  error: string | null;
  loading: boolean;
  refreshing: boolean;
  lastUpdated: Date | null;
  killMessage: string | null;
  killing: number | null;
  autoRefresh: boolean;
}

const REFRESH_INTERVAL_MS = 3_000;
const INVOKE_TIMEOUT_MS = 10_000;

// Sumber data eksternal (Tauri IPC + timer) hidup di luar React. Komponen
// berlangganan lewat useSyncExternalStore, jadi tidak ada setState di effect.
let snapshot: PortSnapshot = {
  ports: [],
  error: null,
  loading: true,
  refreshing: false,
  lastUpdated: null,
  killMessage: null,
  killing: null,
  autoRefresh: true,
};

const listeners = new Set<() => void>();
// Simpan promise-nya, bukan cuma boolean: klik Refresh saat request masih
// jalan ikut menunggu request itu, bukannya diabaikan.
let inFlightPromise: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function emit(patch: Partial<PortSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function stopTimer(): void {
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

function scheduleTimer(): void {
  stopTimer();
  if (snapshot.autoRefresh && listeners.size > 0) {
    timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
  }
}

async function fetchPorts(clearKillMessage: boolean): Promise<void> {
  emit({
    refreshing: true,
    ...(clearKillMessage ? { killMessage: null } : {}),
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = await Promise.race([
      invoke<PortInfo[]>("get_active_ports"),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Request timed out")),
          INVOKE_TIMEOUT_MS
        );
      }),
    ]);
    // Satu emit di akhir: data + status selesai sekaligus. Mengurangi
    // render ulang yang membuat kontrol UI terasa berkedip.
    emit({
      ports: data,
      error: null,
      lastUpdated: new Date(),
      refreshing: false,
      loading: false,
    });
  } catch (error) {
    emit({
      error: String(error),
      refreshing: false,
      loading: false,
    });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function refresh(clearKillMessage = true): Promise<void> {
  if (inFlightPromise) {
    if (clearKillMessage) emit({ killMessage: null });
    return inFlightPromise;
  }
  const promise = fetchPorts(clearKillMessage).finally(() => {
    inFlightPromise = null;
  });
  inFlightPromise = promise;
  return promise;
}

export function subscribe(listener: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(listener);
  if (first) {
    void refresh();
    scheduleTimer();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopTimer();
  };
}

export function getSnapshot(): PortSnapshot {
  return snapshot;
}

export function getServerSnapshot(): PortSnapshot {
  return snapshot;
}

export function setAutoRefresh(enabled: boolean): void {
  emit({ autoRefresh: enabled });
  scheduleTimer();
}

export async function killPortProcess(row: PortInfo): Promise<void> {
  const label = row.process_name || "unknown";
  const detail = row.exe_path || "path tidak tersedia";
  const confirmText = `Kill ${label} (PID ${row.pid}, ${row.protocol} ${row.port})?\n${detail}`;
  if (!window.confirm(confirmText)) return;

  emit({ killMessage: null, killing: row.pid });
  try {
    // exe_path dikirim supaya backend menolak kalau PID sudah didaur ulang.
    await invoke("kill_process", { pid: row.pid, exe_path: row.exe_path });
    emit({ killMessage: `Process ${row.pid} killed.` });
    // Pertahankan pesan sukses; refresh berikutnya (auto/manual) akan
    // membersihkannya lewat refresh() default.
    await refresh(false);
  } catch (error) {
    emit({ killMessage: `Failed to kill ${row.pid}: ${String(error)}` });
  } finally {
    emit({ killing: null });
  }
}
