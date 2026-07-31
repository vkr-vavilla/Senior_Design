mod installer;
mod tools;
mod supervisor;
mod webview;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Must happen before the webview navigates to the interview: the
            // microphone is off by default in the Linux webview, and a voice
            // interview with no microphone is not an interview.
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                webview::enable_microphone(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            supervisor::start_stack,
            supervisor::stop_stack,
            supervisor::app_url,
            installer::install_docker,
            installer::install_ollama,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the FinalRound desktop app");
}
