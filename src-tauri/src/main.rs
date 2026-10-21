#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
mod linux_startup;

#[cfg(not(test))]
fn main() {
    #[cfg(target_os = "linux")]
    linux_startup::configure();
    #[cfg(target_os = "linux")]
    linux_startup::provide_gstreamer_plugins();

    tauri::Builder::default()
        .setup(|app| {
            let config = app.config().app.windows[0].clone();
            let mut bridge = String::new();
            #[cfg(debug_assertions)]
            if let Some(url) = &app.config().build.dev_url {
                bridge.push_str(&format!(
                    "const DEAS_DEV_ORIGIN = {};\n",
                    serde_json::to_string(&url.origin().ascii_serialization())?
                ));
            }
            bridge.push_str(include_str!("comfy_bridge.js"));
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .initialization_script_for_all_frames(bridge)
                .build()?;
            Ok(())
        })
        .manage(deas::install::Engine::default())
        .manage(deas::FolderOperations::default())
        .manage(deas::jobs::Jobs::default())
        .manage(deas::projects::Projects::default())
        .manage(deas::auth::AuthState::default().restore_saved())
        .manage(deas::downloads::DownloadEngine::default())
        .invoke_handler(tauri::generate_handler![
            deas::native_auth_status,
            deas::native_auth_verify,
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
            deas::native_models_scan,
            deas::native_model_info,
            deas::inspect_backend,
            deas::native_negotiate_api,
            deas::native_recipe_prerequisites,
            deas::native_job_current,
            deas::native_job_output,
            deas::native_job_export,
            deas::native_job_prepare,
            deas::native_job_submit,
            deas::native_mask_upload,
            deas::native_input_upload,
            deas::native_h3_session,
            deas::native_h3_video_prepare,
            deas::native_h3_video_upload,
            deas::native_h3_refmods,
            deas::native_job_status,
            deas::native_project_create,
            deas::native_project_open,
            deas::native_project_save,
            deas::native_project_import_image,
            deas::native_project_export_package,
            deas::native_project_import_package,
            deas::native_project_close,
            deas::native_project_close_notice,
            deas::native_pick_directory,
            deas::native_json_save,
            deas::native_json_open,
            deas::native_media_list,
            deas::native_media_star,
            deas::native_media_star_status,
            deas::native_media_star_notice,
            deas::native_media_describe,
            deas::native_media_thumbnail,
            deas::native_media_reveal,
            deas::native_media_metadata,
            deas::native_open_token_page,
            deas::native_open_repo,
            deas::native_repo_stars,
            deas::native_repo_star,
            deas::native_open_releases,
            deas::native_update_check,
            deas::native_settings_read,
            deas::native_settings_write,
            deas::native_settings_move,
            deas::native_startup_read,
            deas::native_startup_write,
            deas::native_llm_read,
            deas::native_llm_write,
            deas::native_llm_generate,
            deas::native_llm_models,
            deas::native_forge,
            deas::native_wildcard_library,
            deas::native_wildcard_build,
            deas::native_files_present,
            deas::native_detect_hardware,
            deas::native_install_defaults,
            deas::native_install_plan,
            deas::native_install_start,
            deas::native_install_open,
            deas::native_install_status,
            deas::native_install_cancel,
            deas::native_install_update,
            deas::native_logs,
            deas::native_logs_export,
            deas::native_logs_people_image_error,
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
