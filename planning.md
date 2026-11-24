# Planning: Port Monitor Desktop App

## Overview
Aplikasi desktop (Windows) untuk menampilkan daftar port yang sedang aktif dengan auto-refresh 3 detik, sebagai alternatif dari menjalankan command `netstat` secara manual. Menampilkan nomor port, protokol, status koneksi, PID, dan nama proses dalam bentuk tabel dengan UI desktop native.

## Tech Stack
- **Backend/Shell**: Tauri v2 (Rust)
- **Frontend**: Next.js (App Router, TypeScript, Tailwind CSS), static export (`output: "export"`)
- **System info**: crate `sysinfo` (Rust) untuk resolve nama proses dari PID
- **Data source**: `netstat -ano` (Windows) di-parse dari Rust backend

## Status Setup (sudah selesai)
- [x] Rust + Cargo terinstall (rustc 1.97.1)
- [x] Visual Studio C++ Build Tools (MSVC v143) + Windows 11 SDK terinstall
- [x] Node.js v24.16.0 + npm terinstall
- [x] Tauri CLI tersedia lewat devDependency `@tauri-apps/cli` v2.11.4 (dipanggil via `npm run tauri`), tidak perlu install global
- [x] Project Next.js dibuat di `C:\Data\01_Development\Projek\port-monitor` (TypeScript, Tailwind, App Router, src/ dir, tanpa React Compiler)
- [x] `npm run tauri init` dijalankan dengan konfigurasi:
  - App name: `port-monitor`
  - Window title: `port-monitor`
  - Web assets: `../out`
  - Dev server URL: `http://localhost:3000`
  - Dev command: `npm run dev`
  - Build command: `npm run build`

## Yang Perlu Dikerjakan

### 1. Konfigurasi Next.js untuk static export
Ubah `next.config.ts`:
```typescript
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};
```

### 2. Backend Rust — command untuk ambil data port
File: `src-tauri/src/lib.rs`

Tambahkan dependency di `src-tauri/Cargo.toml`:
```toml
sysinfo = "0.32"
```

Buat Tauri command `get_active_ports()` yang:
- Menjalankan `netstat -ano` via `std::process::Command`
- Parse output-nya baris per baris (protocol, local address → port, status, PID)
- Resolve nama proses dari PID pakai `sysinfo`
- Return `Vec<PortInfo>` (struct: port, protocol, pid, process_name, status) yang di-serialize ke JSON via `serde`
- Register command tersebut di `invoke_handler![get_active_ports]`

### 3. Frontend — tampilan tabel
- Panggil `invoke("get_active_ports")` dari `@tauri-apps/api/core` di React
- Tampilkan dalam tabel: Port | Protocol | Status | PID | Process Name
- Auto-refresh polling tiap 3 detik (`setInterval` + `useEffect`), bisa dijeda; guard overlap supaya tidak ada request ganda
- Fitur tambahan (nice to have):
  - Search/filter by port number atau nama proses
  - Sort by kolom (klik header)
  - Tombol "Kill Process" per baris (butuh Tauri command tambahan `kill_process(pid)`)
  - Highlight/pin port tertentu

### 4. Styling
- Pakai Tailwind CSS yang sudah di-setup
- Dark theme (biar konsisten kayak terminal/tools sejenis)
- Layout sederhana: header (judul + refresh button/interval indicator) + tabel full-width

### 5. Permission Tauri
Command buatan sendiri tidak memakai ACL permission — cukup terdaftar di `invoke_handler!`. `capabilities/default.json` hanya perlu `core:default`; pembatasan akses dilakukan di level command (validasi PID/snapshot).

### 6. Testing & Build
- Test dev mode: `npm run tauri dev`
- Build production: `npm run tauri build` → hasil `.exe`/`.msi` installer di `src-tauri/target/release/bundle`
- Gate CI: `cargo fmt --check`, `cargo test`, `cargo clippy -D warnings`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`

## Catatan
- Project berjalan di Windows, jadi parsing bergantung pada format output `netstat -ano` Windows (kolom: Proto, Local Address, Foreign Address, State, PID — UDP tidak punya kolom State).
- Build release meminta admin lewat manifest `build.rs` (`requireAdministrator`); debug/test tetap `asInvoker` supaya `cargo test` tidak memicu UAC.