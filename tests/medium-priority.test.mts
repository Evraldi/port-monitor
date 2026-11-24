import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

const backend = read("src-tauri/src/lib.rs");
const buildScript = read("src-tauri/build.rs");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const pkg = JSON.parse(read("package.json"));
const page = read("src/app/page.tsx");
const store = read("src/lib/port-store.ts");
const layout = read("src/app/layout.tsx");
const readme = read("README.md");
const planning = read("planning.md");

test("tray klik kiri hanya show window, menu lewat klik kanan", () => {
  assert.match(backend, /show_menu_on_left_click\(false\)/);
});

test("logging release aktif di level Warn dan error dicatat", () => {
  assert.match(backend, /log::LevelFilter::Warn/);
  assert.match(backend, /cfg!\(debug_assertions\)/);
  assert.match(backend, /log::error!/);
});

test("manifest admin hanya untuk release", () => {
  assert.match(buildScript, /requireAdministrator/);
  assert.match(buildScript, /asInvoker/);
  assert.match(buildScript, /PROFILE.*release/);
});

test("bundle Windows-only tanpa target Android", () => {
  assert.deepEqual(config.bundle.targets, ["nsis", "msi"]);
  assert.equal(config.bundle.android, undefined);
});

test("auto-refresh 3 detik punya pause dan guard overlap", () => {
  assert.match(store, /setInterval/);
  assert.match(store, /REFRESH_INTERVAL_MS = 3_000/);
  assert.match(store, /autoRefresh/);
  assert.match(store, /inFlight/);
  assert.match(store, /clearInterval/);
  assert.doesNotMatch(page, /setTimeout|useEffect/);
});

test("invoke punya timeout supaya loading tidak macet", () => {
  assert.match(store, /Promise\.race/);
  assert.match(store, /INVOKE_TIMEOUT_MS = 10_000/);
  assert.match(store, /clearTimeout\(timeoutId\)/);
  assert.doesNotMatch(page, /disabled=\{data\.loading\}/);
});

test("konfirmasi kill menyertakan nama, PID, protokol, dan port", () => {
  assert.match(store, /row\.process_name/);
  assert.match(store, /row\.protocol\} \$\{row\.port\}/);
  assert.match(store, /row\.exe_path/);
});

test("path disembunyikan default dan bisa ditampilkan", () => {
  assert.match(page, /useState\(false\)/);
  assert.match(page, /Show paths/);
  assert.match(page, /Tersembunyi/);
  assert.match(page, /showPaths &&/);
});

test("aksesibilitas dasar tabel dan pesan", () => {
  assert.match(page, /aria-label="Cari port, PID, proses, atau path"/);
  assert.match(page, /aria-sort=/);
  assert.match(page, /aria-hidden="true"/);
  assert.match(page, /aria-label=\{`Kill \$\{/);
  assert.match(page, /aria-live="polite"/);
});

test("dokumen dan engine Node sinkron dengan Next 16", () => {
  assert.equal(pkg.engines.node, ">=20.9.0");
  assert.match(readme, /Node\.js \*\*>= 20\.9\*\*/);
  assert.doesNotMatch(layout, /Real-time/);
  assert.doesNotMatch(planning, /cargo tauri/);
  assert.match(planning, /npm run tauri dev/);
});

test("CI menjalankan gate web dan Rust", () => {
  const workflowPath = join(root, ".github/workflows/ci.yml");
  assert.ok(existsSync(workflowPath), "workflow CI belum ada");
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /cargo fmt/);
  assert.match(workflow, /cargo clippy/);
});
