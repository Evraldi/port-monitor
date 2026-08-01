# Port Monitor

Desktop app untuk memantau port yang sedang aktif, dibangun dengan **Next.js 16 + Tauri 2** (Windows). Menampilkan daftar port TCP/UDP lengkap dengan proses pemiliknya, plus fitur pencarian, sorting, dan kill process.

## Fitur

- Menampilkan port aktif (TCP/UDP) dari `netstat -ano`
- Resolusi nama proses, path executable, dan working directory (via `sysinfo`)
- Pencarian (port, PID, proses, path) & sorting per kolom
- Kill process langsung dari tabel
- Sistem tray — tombol close menyembunyikan window, app tetap berjalan di tray

## Struktur

```
src/app/        UI Next.js (frontend)
src-tauri/      Rust backend + Tauri commands
  src/lib.rs    Commands: get_active_ports, kill_process, tray setup
```

## Requirement

- Node.js 20+
- Rust (stable)
- Tauri CLI 2 (`npm i -g @tauri-apps/cli` atau via cargo)

## Menjalankan (Development)

```bash
npm install
npm run tauri dev
```

Ini menjalankan `next dev` + window Tauri.

## Build

```bash
npm run tauri build
```

Hasil installer/executable ada di `src-tauri/target/release/bundle/`.

> Catatan: backend command `get_active_ports` memanggil `netstat -ano` dan hanya berjalan di lingkungan Tauri (bukan browser biasa). Frontend di-export statis (`output: "export"`) dan di-bundle ke dalam app.

## Tauri Commands

| Command          | Deskripsi                          |
| ---------------- | ---------------------------------- |
| `get_active_ports` | Mengembalikan daftar port aktif  |
| `kill_process`   | Membunuh proses berdasarkan PID    |
