use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WindowEvent,
};

// The `creation_flags` API for suppressing the child's console window
// lives behind this Windows-specific trait.
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::{Path, PathBuf};

// On Windows, prevents the child process (netstat) from flashing a
// console window each time it runs.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// `System` cannot be terminated from user mode anyway; reject it explicitly
// so the UI never offers a misleading "Kill" action for it.
const SYSTEM_PID: u32 = 4;

#[derive(Serialize)]
struct PortInfo {
    port: u16,
    protocol: String,
    status: String,
    local: String,
    pid: u32,
    process_name: String,
    exe_path: String,
    cwd: String,
}

/// Hasil parse murni dari output `netstat -ano`. Dipisah dari Tauri command
/// supaya bisa di-unit-test tanpa menjalankan `netstat`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedPort {
    port: u16,
    protocol: String,
    status: String,
    pid: u32,
    local: String,
    foreign: String,
}

/// Identitas proses yang dipakai untuk mencegah kill salah orang kalau PID
/// didaur ulang antara saat tabel di-refresh dan saat tombol ditekan.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ProcessIdentity {
    name: String,
    exe_path: String,
    start_time: u64,
}

#[derive(Default)]
struct PortSnapshotState(Mutex<HashMap<u32, ProcessIdentity>>);

fn normalize_protocol(raw: &str) -> Option<String> {
    let upper = raw.to_ascii_uppercase();
    match upper.as_str() {
        "TCP" | "UDP" => Some(upper),
        // Windows memakai TCPv6/UDPv6 untuk baris IPv6.
        "TCPV6" => Some("TCP".into()),
        "UDPV6" => Some("UDP".into()),
        _ => None,
    }
}

fn parse_netstat(text: &str) -> Vec<ParsedPort> {
    let mut seen: HashSet<(String, String, String, String, u32)> = HashSet::new();
    let mut ports = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }

        // Expected layouts (Windows netstat -ano):
        //   TCP: Proto  Local Address  Foreign Address  State  PID
        //   UDP: Proto  Local Address  Foreign Address  PID
        let Some(protocol) = normalize_protocol(cols[0]) else {
            continue;
        };
        let local = cols[1].to_string();
        let foreign = cols[2].to_string();

        // Port = segmen terakhir setelah ':' — benar untuk IPv4 maupun [::]:443.
        let Some((_, port_str)) = local.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = port_str.parse::<u16>() else {
            continue;
        };

        let (status, pid_str) = if protocol == "TCP" && cols.len() >= 5 {
            (cols[3].to_string(), cols[4])
        } else if protocol == "UDP" {
            (String::new(), cols[3])
        } else {
            // TCP tanpa kolom state bukan baris yang valid.
            continue;
        };

        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        // PID 0 dipakai oleh entri sistem yang tidak bisa dibunuh.
        if pid == 0 {
            continue;
        }

        let candidate = ParsedPort {
            port,
            protocol,
            status,
            pid,
            local,
            foreign,
        };
        let key = (
            candidate.protocol.clone(),
            candidate.local.clone(),
            candidate.foreign.clone(),
            candidate.status.clone(),
            candidate.pid,
        );
        if !seen.insert(key) {
            continue;
        }
        ports.push(candidate);
    }

    ports
}

fn is_forbidden_pid(pid: u32, self_pid: u32) -> bool {
    pid == 0 || pid == SYSTEM_PID || pid == self_pid
}

fn identity_of(process: &Process) -> ProcessIdentity {
    ProcessIdentity {
        name: process.name().to_string_lossy().into_owned(),
        exe_path: process
            .exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        start_time: process.start_time(),
    }
}

fn forget_pid(state: &PortSnapshotState, pid: u32) {
    if let Ok(mut snapshot) = state.0.lock() {
        snapshot.remove(&pid);
    }
}

/// Path `netstat` tidak boleh diambil dari PATH: executable di direktori yang
/// lebih awal bisa menyamar dan dieksekusi tiap kali refresh.
#[cfg(windows)]
fn netstat_path_from_root(system_root: &str) -> PathBuf {
    Path::new(system_root).join("System32").join("netstat.exe")
}

fn netstat_command() -> Command {
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let mut command = Command::new(netstat_path_from_root(&root));
        command.creation_flags(CREATE_NO_WINDOW);
        command.arg("-ano");
        command
    }
    #[cfg(not(windows))]
    {
        // Hanya dipakai supaya `cargo check`/clippy lint di CI non-Windows tetap jalan.
        let mut command = Command::new("netstat");
        command.arg("-ano");
        command
    }
}

#[tauri::command]
fn get_active_ports(state: State<'_, PortSnapshotState>) -> Result<Vec<PortInfo>, String> {
    let output = netstat_command().output().map_err(|e| {
        log::error!("gagal menjalankan netstat: {e}");
        format!("Gagal menjalankan netstat: {e}")
    })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::error!("netstat keluar dengan status {} — {stderr}", output.status);
        return Err(if stderr.is_empty() {
            "netstat keluar dengan status non-zero".into()
        } else {
            format!("netstat gagal: {stderr}")
        });
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_netstat(&text);

    let pids: Vec<Pid> = {
        let mut unique = HashSet::new();
        parsed
            .iter()
            .filter_map(|port| unique.insert(port.pid).then_some(Pid::from_u32(port.pid)))
            .collect()
    };

    let mut sys = System::new();
    if !pids.is_empty() {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::new()
                .with_exe(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet),
        );
    }

    let mut identities: HashMap<u32, ProcessIdentity> = HashMap::new();
    for pid in &pids {
        if let Some(process) = sys.process(*pid) {
            identities.insert(pid.as_u32(), identity_of(process));
        }
    }

    let ports: Vec<PortInfo> = parsed
        .iter()
        .map(|port| {
            let pid_handle = Pid::from_u32(port.pid);
            let identity = identities.get(&port.pid);
            let cwd = sys
                .process(pid_handle)
                .and_then(|process| process.cwd())
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();

            PortInfo {
                port: port.port,
                protocol: port.protocol.clone(),
                status: port.status.clone(),
                local: port.local.clone(),
                pid: port.pid,
                process_name: identity
                    .map(|value| value.name.clone())
                    .unwrap_or_else(|| "<unknown>".into()),
                exe_path: identity
                    .map(|value| value.exe_path.clone())
                    .unwrap_or_default(),
                cwd,
            }
        })
        .collect();

    let mut snapshot = state.0.lock().map_err(|_| {
        log::error!("snapshot state poisoned saat menyimpan hasil netstat");
        "snapshot state tidak tersedia".to_string()
    })?;
    *snapshot = identities;

    Ok(ports)
}

#[tauri::command]
fn kill_process(
    pid: u32,
    exe_path: String,
    state: State<'_, PortSnapshotState>,
) -> Result<(), String> {
    if is_forbidden_pid(pid, std::process::id()) {
        log::warn!("kill ditolak untuk PID terlarang {pid}");
        return Err(format!("PID {pid} tidak boleh dibunuh"));
    }

    let expected = {
        let snapshot = state.0.lock().map_err(|_| {
            log::error!("snapshot state poisoned saat memvalidasi kill {pid}");
            "snapshot state tidak tersedia".to_string()
        })?;
        snapshot
            .get(&pid)
            .cloned()
            .ok_or_else(|| format!("PID {pid} tidak ada di snapshot terakhir"))?
    };

    if !exe_path.is_empty() && expected.exe_path != exe_path {
        return Err(format!(
            "Identitas PID {pid} berubah sejak refresh terakhir"
        ));
    }

    let pid_handle = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[pid_handle]),
        true,
        ProcessRefreshKind::new().with_exe(UpdateKind::OnlyIfNotSet),
    );

    let Some(process) = sys.process(pid_handle) else {
        forget_pid(&state, pid);
        return Err(format!("Proses {pid} sudah tidak ada"));
    };
    if identity_of(process) != expected {
        log::warn!("identitas PID {pid} berubah sejak snapshot, kill dibatalkan");
        forget_pid(&state, pid);
        return Err(format!("Identitas PID {pid} berubah, kill dibatalkan"));
    }
    if !process.kill() {
        log::error!("gagal membunuh proses {pid}");
        return Err(format!("Gagal membunuh proses {pid}"));
    }

    // `kill()` hanya mengirim sinyal/terminate; verifikasi dulu sebelum UI
    // mengklaim berhasil.
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(50));
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid_handle]),
            true,
            ProcessRefreshKind::new(),
        );
        if sys.process(pid_handle).is_none() {
            forget_pid(&state, pid);
            return Ok(());
        }
    }

    log::error!("proses {pid} masih hidup setelah kill");
    Err(format!("Proses {pid} masih hidup setelah kill"))
}

/// Show and focus the main window.
fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Build the tray icon with a right-click menu (Show / Quit).
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Port Monitor", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let icon = app.default_window_icon().cloned();

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Port Monitor")
        // Klik kiri hanya show/focus window; menu muncul lewat klik kanan.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        });

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Plugin ini wajib didaftarkan paling awal agar instance kedua
        // ditutup sebelum plugin lain sempat jalan.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app);
        }))
        .manage(PortSnapshotState::default())
        .invoke_handler(tauri::generate_handler![get_active_ports, kill_process])
        .setup(|app| {
            // Release tetap mengirim log (warn/error) supaya kegagalan
            // netstat/kill bisa didiagnosis dari mesin user.
            let level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };
            app.handle()
                .plugin(tauri_plugin_log::Builder::default().level(level).build())?;
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close button hides the window instead of quitting, so the
            // app keeps running in the system tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            // `run()` hanya gagal sebelum event loop hidup, jadi plugin log
            // belum tentu terpasang. Tulis ke stderr supaya tetap terlihat.
            eprintln!("error while running tauri application: {error}");
            log::error!("error while running tauri application: {error}");
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tcp_udp_ipv6_dan_header() {
        let text = "\
Active Connections\r\n\
\r\n  Proto  Local Address          Foreign Address        State           PID\r\n\
  TCP    0.0.0.0:80              0.0.0.0:0              LISTENING       1234\r\n\
  TCP    [::]:443                [::]:0                 LISTENING       1234\r\n\
  TCPv6  [::1]:8080              [::1]:50000            ESTABLISHED     5678\r\n\
  UDP    0.0.0.0:5353            *:*                                    9012\r\n\
  UDPv6  [::]:5353               *:*                                    9012\r\n";
        let parsed = parse_netstat(text);
        assert_eq!(parsed.len(), 5);
        assert!(parsed.iter().all(|port| port.pid != 0));
        assert_eq!(parsed[0].status, "LISTENING");
        assert_eq!(parsed[1].port, 443);
        assert_eq!(parsed[2].protocol, "TCP");
        assert_eq!(parsed[3].status, "");
        assert_eq!(parsed[4].protocol, "UDP");
    }

    #[test]
    fn parse_membuang_pid_nol_port_invalid_dan_duplikat() {
        let text = "\
  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    0\r\n\
  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    4294967296\r\n\
  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    42\r\n\
  TCP    0.0.0.0:80    0.0.0.0:0    LISTENING    42\r\n";
        let parsed = parse_netstat(text);
        assert_eq!(parsed.len(), 1, "baris identik harus didedup");
        assert_eq!(parsed[0].pid, 42);
    }

    #[test]
    fn pid_terlarang_mencakup_nol_sistem_dan_diri_sendiri() {
        let self_pid = std::process::id();
        assert!(is_forbidden_pid(0, self_pid));
        assert!(is_forbidden_pid(4, self_pid));
        assert!(is_forbidden_pid(self_pid, self_pid));
        assert!(!is_forbidden_pid(4242, self_pid));
    }

    #[test]
    fn identitas_membedakan_pid_daur_ulang() {
        let original = ProcessIdentity {
            name: "chrome.exe".into(),
            exe_path: "C:\\Program Files\\Chrome\\chrome.exe".into(),
            start_time: 100,
        };
        let mut reused = original.clone();
        reused.start_time = 200;
        assert_ne!(original, reused);

        let mut replaced = original.clone();
        replaced.exe_path = "C:\\Program Files\\Evil\\evil.exe".into();
        assert_ne!(original, replaced);
    }

    #[test]
    fn parser_tidak_bergantung_bahasa_header_atau_status() {
        // Windows bisa mem-localisasi header dan nama state. Parser hanya
        // bergantung pada token protokol, bukan teks header/status.
        let text = "\
Connexions actives\r\n\r\n  Proto  Adresse locale     Adresse distante   État         PID\r\n\
  TCP    0.0.0.0:8080      0.0.0.0:0          ÉCOUTE       42\r\n\
  UDP    0.0.0.0:5353      *:*                              42\r\n";
        let parsed = parse_netstat(text);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].status, "ÉCOUTE");
        assert_eq!(parsed[0].port, 8080);
        assert_eq!(parsed[1].protocol, "UDP");
    }

    #[cfg(windows)]
    #[test]
    fn netstat_diambil_dari_system32_bukan_path() {
        let path = netstat_path_from_root("C:\\Windows");
        assert_eq!(path, PathBuf::from("C:\\Windows\\System32\\netstat.exe"));
    }
}
