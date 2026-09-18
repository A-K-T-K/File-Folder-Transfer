use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(dev))]
use tauri_plugin_shell::ShellExt;

// Holds the spawned backend server's process handle so it can be killed when
// the window closes — otherwise it lingers and holds port 5000 on the next launch.
struct ServerProcess(Mutex<Option<CommandChild>>);

#[tauri::command]
fn pick_files(app: tauri::AppHandle, title: Option<String>) -> Result<Vec<String>, String> {
    let mut builder = app.dialog().file();
    if let Some(ref t) = title {
        builder = builder.set_title(t);
    }
    let files = builder.blocking_pick_files();
    match files {
        Some(selected) => {
            let paths: Vec<String> = selected
                .into_iter()
                .filter_map(|fp| fp.into_path().ok().map(|p| p.to_string_lossy().into_owned()))
                .collect();
            Ok(paths)
        }
        None => Ok(Vec::new()),
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        if let Err(e) = std::fs::create_dir_all(&target) {
            return Err(format!("Failed to create directory: {}", e));
        }
    }

    match open::that(&target) {
        Ok(_) => Ok(format!("Opened {}", path)),
        Err(e) => Err(format!("Could not open path: {}", e)),
    }
}

#[tauri::command]
fn toggle_hotspot(enable: bool, ssid: Option<String>, password: Option<String>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        if enable {
            let actual_ssid = ssid.unwrap_or_else(|| "FT-Direct-Server".to_string());
            let actual_pass = password.unwrap_or_else(|| "12345678".to_string());
            
            // Set hosted network parameters
            let set_status = Command::new("netsh")
                .args(&["wlan", "set", "hostednetwork", "mode=allow", &format!("ssid={}", actual_ssid), &format!("key={}", actual_pass)])
                .output();

            match set_status {
                Ok(_) => {
                    let start_status = Command::new("netsh")
                        .args(&["wlan", "start", "hostednetwork"])
                        .output();
                    match start_status {
                        Ok(out) => {
                            let msg = String::from_utf8_lossy(&out.stdout).to_string();
                            Ok(format!("Hotspot started: {}", msg))
                        }
                        Err(e) => Err(format!("Could not start hostednetwork: {}", e)),
                    }
                }
                Err(e) => Err(format!("Could not configure hostednetwork: {}", e)),
            }
        } else {
            let stop_status = Command::new("netsh")
                .args(&["wlan", "stop", "hostednetwork"])
                .output();
            match stop_status {
                Ok(_) => Ok("Hotspot stopped.".to_string()),
                Err(e) => Err(format!("Could not stop hotspot: {}", e)),
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if enable {
            let actual_ssid = ssid.unwrap_or_else(|| "FT-Direct-Server".to_string());
            let actual_pass = password.unwrap_or_else(|| "12345678".to_string());
            let status = Command::new("nmcli")
                .args(&["dev", "wifi", "hotspot", "ssid", &actual_ssid, "password", &actual_pass])
                .output();
            match status {
                Ok(out) => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
                Err(e) => Err(format!("Could not start hotspot via nmcli: {}", e)),
            }
        } else {
            Ok("Hotspot disabled.".to_string())
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok("Hotspot not directly supported on this OS without root/admin privileges.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            // In `tauri dev`, tauri.conf.json's beforeDevCommand already runs
            // `node server.js` on port 5000 for hot-reload — spawning the sidecar
            // here too would just race it for the same port. Only production
            // builds need to bring up their own backend.
            #[cfg(not(dev))]
            {
                let handle = app.handle().clone();
                let (_events, child) = handle
                    .shell()
                    .sidecar("server")
                    .expect("failed to create server sidecar command")
                    // Tells server.js not to also auto-open a browser tab — the native
                    // window is already about to show the dashboard.
                    .env("TAURI_PLATFORM", "desktop")
                    .spawn()
                    .expect("failed to spawn server sidecar");

                *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
            }

            // Poll for the server actually accepting connections before showing the
            // window, so the user never sees a connection-refused flash.
            let window = app.get_webview_window("main").unwrap();
            std::thread::spawn(move || {
                let addr: SocketAddr = "127.0.0.1:5000".parse().unwrap();
                let mut ready = false;
                for _ in 0..100 {
                    if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
                        ready = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                if ready {
                    if let Ok(url) = "http://127.0.0.1:5000/server".parse() {
                        let _ = window.navigate(url);
                    }
                }
                let _ = window.show();
                let _ = window.set_focus();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(child) = window.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![open_folder, toggle_hotspot, pick_files])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Belt-and-suspenders: the window's CloseRequested handler above covers
            // the normal "user clicks X" case, but this app-level exit event fires
            // more reliably across every way the app can actually shut down — this
            // is what guarantees the sidecar never survives as an orphaned process.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(child) = app_handle.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}


