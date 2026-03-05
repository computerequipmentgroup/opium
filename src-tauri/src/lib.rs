//! Opium - Load balancer for Anthropic accounts

mod commands;
mod proxy;
mod server_client;
mod state;
mod types;

use state::create_shared_state;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalPosition, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};
use tracing::info;
use tracing_subscriber::EnvFilter;

/// Proxy server handle stored in Tauri state
#[derive(Clone)]
struct ProxyHandle(std::sync::Arc<Mutex<Option<proxy::ProxyServer>>>);

/// Initialize logging
fn init_logging() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .init();
}

/// Create the tray menu
fn create_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync Accounts", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    Menu::with_items(app, &[&show, &sync, &quit])
}

/// Handle tray menu events
fn handle_tray_menu_event<R: Runtime>(app: &tauri::AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id.as_ref() {
        "show" => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "sync" => {
            // Emit sync event to frontend
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit("sync-accounts", ());
            }
        }
        "quit" => {
            app.exit(0);
        }
        _ => {}
    }
}

/// Calculate dropdown position near tray icon, accounting for screen edges
fn calculate_dropdown_position<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    click_x: f64,
    click_y: f64,
) -> (f64, f64) {
    let window_width = 380.0;
    let window_height = 480.0;
    
    // Get scale factor and monitor info
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    
    // Convert click position to logical coordinates
    let mut x = click_x / scale_factor;
    let mut y = click_y / scale_factor;
    
    // Try to get monitor bounds for edge detection
    if let Ok(Some(monitor)) = window.current_monitor() {
        let monitor_size = monitor.size();
        let monitor_pos = monitor.position();
        
        let monitor_width = monitor_size.width as f64 / scale_factor;
        let monitor_height = monitor_size.height as f64 / scale_factor;
        let monitor_x = monitor_pos.x as f64 / scale_factor;
        let monitor_y = monitor_pos.y as f64 / scale_factor;
        
        // Center the window horizontally on the click position
        x = x - (window_width / 2.0);
        
        // Ensure window doesn't go off right edge
        if x + window_width > monitor_x + monitor_width {
            x = monitor_x + monitor_width - window_width - 10.0;
        }
        
        // Ensure window doesn't go off left edge
        if x < monitor_x {
            x = monitor_x + 10.0;
        }
        
        // Position below click, but flip above if near bottom
        if y + window_height > monitor_y + monitor_height {
            y = y - window_height - 10.0;
        } else {
            y = y + 5.0; // Small offset below click
        }
        
        // Ensure window doesn't go off top edge
        if y < monitor_y {
            y = monitor_y + 10.0;
        }
    }
    
    (x, y)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    info!("Starting Opium");

    // Create shared state
    let shared_state = create_shared_state().expect("Failed to create app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shared_state.clone())
        .manage(ProxyHandle(std::sync::Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            commands::get_proxy_status,
            commands::get_config,
            commands::update_config,
            commands::test_server_connection,
            commands::get_pool,
            commands::server_start_oauth,
            commands::server_complete_oauth,
            commands::server_set_active,
            commands::server_set_share_limit,
            commands::server_sync_account,
            commands::server_sync_pool,
            commands::server_unlink_account,
            commands::is_server_mode,
        ])
        .setup(move |app| {
            // Hide dock icon on macOS (tray-only mode)
            #[cfg(target_os = "macos")]
            {
                use cocoa::appkit::{NSApp, NSApplication, NSApplicationActivationPolicy};
                unsafe {
                    let ns_app = NSApp();
                    ns_app.setActivationPolicy_(NSApplicationActivationPolicy::NSApplicationActivationPolicyAccessory);
                }
            }

            // Create tray icon
            let menu = create_tray_menu(app.handle())?;

            let _tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png")).unwrap())
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    handle_tray_menu_event(app, event);
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                // Calculate position and show as dropdown
                                let (x, y) = calculate_dropdown_position(
                                    &window,
                                    position.x,
                                    position.y,
                                );
                                let _ = window.set_position(LogicalPosition::new(x, y));
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Create main window (dropdown-style: frameless, always-on-top, rounded corners)
            let _window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Opium")
            .inner_size(380.0, 480.0)
            .resizable(false)
            .visible(false)       // Start hidden, shown from tray click
            .decorations(false)   // Frameless - makes it non-movable
            .always_on_top(true)  // Keep above other windows
            .skip_taskbar(true)
            .transparent(true)    // Transparent background for rounded corners
            .shadow(false)        // Disable native shadow (using CSS shadow instead)
            .build()?;

            // Start proxy server
            let state_clone = shared_state.clone();
            let proxy_handle = app.state::<ProxyHandle>().0.clone();

            tauri::async_runtime::spawn(async move {
                match proxy::start_proxy(state_clone).await {
                    Ok(server) => {
                        info!("Proxy server started");
                        // Store server handle to keep it alive
                        if let Ok(mut guard) = proxy_handle.lock() {
                            *guard = Some(server);
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to start proxy: {}", e);
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // Hide window instead of closing
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Hide window when it loses focus (click outside)
                tauri::WindowEvent::Focused(false) => {
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
