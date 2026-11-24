import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

const config = JSON.parse(read("src-tauri/tauri.conf.json"));
const security = config.app.security;
const cargo = read("src-tauri/Cargo.toml");
const backend = read("src-tauri/src/lib.rs");
const store = read("src/lib/port-store.ts");
const pkg = JSON.parse(read("package.json"));

test("CSP produksi aktif tanpa origin berbahaya", () => {
  assert.ok(security.csp, "csp tidak boleh null");
  assert.equal(security.csp["default-src"], "'self' asset:");
  assert.equal(security.csp["script-src"], "'self'");
  assert.doesNotMatch(security.csp["script-src"], /unsafe-inline|unsafe-eval|\*/);
  assert.doesNotMatch(security.csp["connect-src"], /https?:\/\/(?!ipc\.localhost)/);
});

test("devCsp mengizinkan HMR localhost saja", () => {
  assert.match(security.devCsp["connect-src"], /ws:\/\/localhost:3000/);
  assert.doesNotMatch(security.devCsp["connect-src"], /https?:\/\/(?!ipc\.localhost|localhost:3000)/);
  assert.match(security.devCsp["script-src"], /unsafe-eval/);
});

test("single-instance terpasang dan didaftarkan lebih awal", () => {
  assert.match(cargo, /tauri-plugin-single-instance\s*=\s*"2"/);
  const pluginAt = backend.indexOf("tauri_plugin_single_instance::init");
  assert.ok(pluginAt >= 0, "plugin single-instance belum di-init");
  const logAt = backend.indexOf("tauri_plugin_log::Builder");
  assert.ok(logAt > pluginAt, "single-instance wajib jadi plugin pertama");
  assert.match(backend, /show_window\(app\)/);
});

test("netstat diambil dari System32, bukan PATH", () => {
  assert.match(backend, /netstat_path_from_root/);
  assert.match(backend, /join\("System32"\)\.join\("netstat\.exe"\)/);
  assert.match(backend, /#\[cfg\(windows\)\]/);
  assert.match(backend, /creation_flags\(CREATE_NO_WINDOW\)/);
});

test("kill_process punya guard PID, snapshot, dan verifikasi identitas", () => {
  assert.match(backend, /fn is_forbidden_pid/);
  assert.match(backend, /pid == SYSTEM_PID/);
  assert.match(backend, /std::process::id\(\)/);
  assert.match(backend, /tidak ada di snapshot terakhir/);
  assert.match(backend, /identity_of\(process\) != expected/);
  assert.match(backend, /ProcessesToUpdate::Some/);
  assert.match(backend, /masih hidup setelah kill/);
});

test("frontend mengirim exe_path dan tidak menebak status kill", () => {
  assert.match(store, /invoke\("kill_process", \{ pid: row\.pid, exe_path: row\.exe_path \}\)/);
  assert.doesNotMatch(store, /invoke\("kill_process", \{ pid \}\)/);
  assert.match(store, /row\.process_name/);
});

test("script test memakai glob yang dikutip", () => {
  assert.match(pkg.scripts.test, /node --test "tests\/\*\.test\.mts"/);
});
