import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

const backend = read("src-tauri/src/lib.rs");
const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const page = read("src/app/page.tsx");
const store = read("src/lib/port-store.ts");
const layout = read("src/app/layout.tsx");
const globals = read("src/app/globals.css");
const readme = read("README.md");
const planning = read("planning.md");
const gitignore = read(".gitignore");
const pkg = JSON.parse(read("package.json"));

test("STATUS_COLORS mencakup semua state TCP Windows dan UDP", () => {
  const states = [
    "LISTENING",
    "ESTABLISHED",
    "SYN_SENT",
    "SYN_RECEIVED",
    "TIME_WAIT",
    "CLOSE_WAIT",
    "FIN_WAIT_1",
    "FIN_WAIT_2",
    "LAST_ACK",
    "CLOSING",
    "CLOSED",
    "DELETE",
    "UDP",
  ];
  for (const state of states) {
    assert.match(page, new RegExp(`${state}: "text-`), `state ${state} belum ada`);
  }
  assert.match(page, /status\.toUpperCase\(\)/);
});

test("killMessage dibersihkan saat refresh, tapi dipertahankan setelah kill", () => {
  assert.match(store, /clearKillMessage = true/);
  assert.match(store, /killMessage: null/);
  assert.match(store, /await refresh\(false\)/);
  assert.match(page, /onClick=\{\(\) => void refresh\(\)\}/);
});

test("komponen tidak pakai effect/setTimeout untuk fetch awal", () => {
  assert.match(page, /useSyncExternalStore\(subscribe, getSnapshot, getServerSnapshot\)/);
  assert.doesNotMatch(page, /useEffect|setTimeout/);
  assert.match(store, /setInterval/);
  assert.match(store, /clearInterval/);
});

test("startup tidak panic pakai expect", () => {
  assert.doesNotMatch(backend, /expect\("error while running tauri application"\)/);
  assert.match(backend, /unwrap_or_else\(\|error\|/);
  assert.match(backend, /eprintln!/);
});

test("parser diuji terhadap header/status terlokalisasi", () => {
  assert.match(backend, /parser_tidak_bergantung_bahasa_header_atau_status/);
  assert.match(backend, /ÉCOUTE/);
});

test("identity snapshot pakai struct, bukan tuple berlebih", () => {
  assert.doesNotMatch(backend, /HashMap<u32, \(String, String, String\)>/);
  assert.match(backend, /struct ProcessIdentity/);
  assert.match(backend, /output\.status\.success\(\)/);
  assert.match(backend, /netstat gagal: \{stderr\}/);
});

test("window punya label eksplisit dan drag-drop dimatikan", () => {
  assert.equal(config.app.windows[0].label, "main");
  assert.equal(config.app.windows[0].dragDropEnabled, false);
  assert.match(backend, /get_webview_window\("main"\)/);
});

test("metadata Cargo tidak lagi template", () => {
  assert.doesNotMatch(cargo, /A Tauri App|authors = \["you"\]/);
  assert.match(cargo, /authors = \["Evraldi"\]/);
  assert.match(cargo, /license = "UNLICENSED"/);
  assert.match(readme, /rust-version.*1\.77\.2|>= 1\.77\.2/);
});

test("planning.md tidak lagi diabaikan dan docs tidak basi", () => {
  assert.doesNotMatch(gitignore, /planning\.md/);
  assert.doesNotMatch(readme, /cargo tauri|npm i -g/);
  assert.doesNotMatch(planning, /cargo tauri|npm i -g/);
  assert.match(planning, /tidak memakai ACL permission/);
});

test("font tidak bergantung network saat build", () => {
  assert.doesNotMatch(layout, /next\/font\/google|Geist/);
  assert.match(globals, /--font-sans:/);
  assert.match(globals, /--font-mono:/);
});

test("audit otomatis terpasang dengan allowlist bertanggal", () => {
  assert.equal(pkg.scripts["audit:prod"], "node scripts/audit.mjs");
  assert.ok(existsSync(join(root, "scripts/audit.mjs")));
  const allowlist = JSON.parse(read("audit-allowlist.json"));
  assert.match(allowlist.reviewBy, /^20\d\d-\d\d-\d\d$/);
  assert.ok(Object.keys(allowlist.accepted).length >= 14);
  const workflow = read(".github/workflows/ci.yml");
  assert.match(workflow, /npm run audit:prod/);
});

test("regresi UI rendah tetap terjaga", () => {
  assert.match(page, /colSpan=\{COLUMNS\.length \+ 1\}/);
  assert.match(page, /disabled=\{data\.refreshing \|\| data\.killing !== null\}/);
  assert.match(page, /min-h-0/);
  assert.doesNotMatch(page, /key=\{index\}/);
  assert.match(page, /aria-sort=/);
});
