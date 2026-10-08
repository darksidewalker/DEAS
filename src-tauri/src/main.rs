#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(test))]
fn main() {
    tauri::Builder::default()
        .manage(deas::install::Engine::default())
        .manage(deas::auth::AuthState::default())
        .manage(deas::downloads::DownloadEngine::default())
        .invoke_handler(tauri::generate_handler![
            deas::native_auth_status,
            deas::native_auth_set,
            deas::native_auth_remove,
            deas::native_auth_restore,
            deas::native_download_catalog,
            deas::native_download_import_catalog,
            deas::native_download_browse,
            deas::native_download_plan,
            deas::native_download_start,
            deas::native_download_status,
            deas::native_download_cancel,
            deas::inspect_backend,
            deas::native_negotiate_api,
            deas::native_pick_directory,
            deas::native_detect_hardware,
            deas::native_install_plan,
            deas::native_install_start,
            deas::native_install_status,
            deas::native_install_cancel,
            deas::native_backend_start,
            deas::native_backend_status,
            deas::native_backend_stop
        ])
        .build(tauri::generate_context!())
        .expect("failed to build DEAS")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                use tauri::Manager;
                app.state::<deas::install::Engine>().shutdown_backend();
                let _ = app.state::<deas::downloads::DownloadEngine>().cancel();
            }
        });
}

#[cfg(test)]
fn main() {}
