mod supervisor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            supervisor::start_stack,
            supervisor::stop_stack,
            supervisor::app_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the PrepAI desktop app");
}
