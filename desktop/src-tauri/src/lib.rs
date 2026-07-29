mod installer;
mod tools;
mod supervisor;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
