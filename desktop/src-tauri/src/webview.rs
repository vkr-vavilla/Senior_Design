//! Microphone access for the packaged app.
//!
//! The interview is a voice interview: hands-free turn-taking runs Silero VAD
//! on the mic, and push-to-talk records from it. Both call getUserMedia, and
//! both are dead in the box unless the native shell says the microphone is
//! allowed. The three platforms disagree about who has to say it.
//!
//! **Linux (WebKitGTK).** Two separate refusals, and wry sets neither:
//!   1. `WebKitSettings:enable-media-stream` defaults to FALSE, so media
//!      capture is off before any permission question is asked.
//!   2. `WebKitWebView::permission-request` denies by default when no handler
//!      is connected — silence means no.
//! Result: getUserMedia rejects with NotAllowedError in the packaged app while
//! the identical page works in a browser on the same machine. Fixed below.
//!
//! **macOS (WKWebView).** Nothing to do here — wry's WKUIDelegate already
//! answers `requestMediaCapturePermissionForOrigin` with `.Grant`. But that is
//! only WebKit's own gate; macOS TCC sits underneath it and terminates any
//! process that touches the mic without `NSMicrophoneUsageDescription` in its
//! Info.plist. That string is supplied by `src-tauri/Info.plist`, which the
//! Tauri CLI merges into the bundle — a build-time fix, not a runtime one.
//!
//! **Windows (WebView2).** Prompts the user itself and remembers the answer.

/// Allow the webview to use the microphone. No-op where the platform already
/// handles it; see the module docs for what each platform needs instead.
#[allow(unused_variables)]
pub fn enable_microphone(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::glib::object::Cast;
        use webkit2gtk::{
            PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt,
        };

        // with_webview hands us the raw WebKitGTK handle on the GTK main
        // thread. Errors are ignored deliberately: a shell that can't reach
        // its own webview should still start and run a typed interview.
        let result = window.with_webview(|webview| {
            let wv = webview.inner();

            if let Some(settings) = WebViewExt::settings(&wv) {
                settings.set_enable_media_stream(true);
            }

            wv.connect_permission_request(|_, request| {
                // Only microphone/camera. Everything else (geolocation,
                // notifications, DRM) keeps WebKit's deny-by-default, since
                // this window loads a local page that has no business asking.
                if request.downcast_ref::<UserMediaPermissionRequest>().is_some() {
                    request.allow();
                    return true; // handled
                }
                false // let WebKit refuse it
            });
        });

        if let Err(e) = result {
            eprintln!("[webview] could not enable microphone access: {e}");
        }
    }
}
