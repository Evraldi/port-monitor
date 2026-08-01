use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;
use sysinfo::{Pid, ProcessesToUpdate, System, UpdateKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WindowEvent,
};

// The `creation_flags` API for suppressing the child's console window
// lives behind this Windows-specific trait.
#[cfg(windows)]
use std::os::windows::process::CommandExt;

// On Windows, prevents the child process (netstat) from flashing a
// console window each time it runs.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
struct PortInfo {
    port: u16,
    protocol: String,
    status: String,
    pid: u32,
    process_name: String,
    exe_path: String,
    cwd: String,
}

#[tauri::command]
fn get_active_ports() -> Result<Vec<PortInfo>, String> {
    let output = Command::new("netstat")
        .arg("-ano")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to run netstat: {e}"))?;

    if !output.status.success() {
        return Err("netstat exited with a non-zero status".into());
    }

    let text = String::from_utf8_lossy(&output.stdout);

    // Build a pid -> process info map once so we can resolve names and
    // paths quickly. exe is included in the default refresh; cwd is not,
    // so request it explicitly.
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::new()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );
    let pid_names: HashMap<u32, (String, String, String)> = sys
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                (
                    process.name().to_string_lossy().to_string(),
                    process
                        .exe()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    process
                        .cwd()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                ),
            )
        })
        .collect();

    let mut ports: Vec<PortInfo> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();

        // Expected layouts (Windows netstat -ano):
        //   TCP: Proto  Local Address  Foreign Address  State  PID
        //   UDP: Proto  Local Address  Foreign Address  (blank)  PID
        // After whitespace split, UDP lines have the PID at index 3.
        if cols.len() < 4 {
            continue;
        }
        let protocol = cols[0].to_uppercase();
        if protocol != "TCP" && protocol != "UDP" {
            continue;
        }

        // Port = last segment of the local address after the final ':'.
        let local = cols[1];
        let port = match local.rsplit_once(':') {
            Some((_, port)) => port,
            None => continue,
        };
        let Ok(port) = port.parse::<u16>() else {
            continue;
        };

        let (status, pid_str) = if protocol == "TCP" && cols.len() >= 5 {
            (cols[3].to_string(), cols[4])
        } else {
            (String::new(), cols[3])
        };

        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };

        let (name, exe_path, cwd) = pid_names
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| ("<unknown>".into(), String::new(), String::new()));

        ports.push(PortInfo {
            port,
            protocol,
            status,
            pid,
            process_name: name,
            exe_path,
            cwd,
        });
    }

    Ok(ports)
}

#[tauri::command]
fn kill_process(pid: u32) -> Result<(), String> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    match sys.process(Pid::from_u32(pid)) {
        Some(process) => {
            if process.kill() {
                Ok(())
            } else {
                Err(format!("Failed to kill process {pid}"))
            }
        }
        None => Err(format!("Process {pid} not found")),
    }
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
        .show_menu_on_left_click(true)
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
        .invoke_handler(tauri::generate_handler![get_active_ports, kill_process])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
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
        .expect("error while running tauri application");
}
