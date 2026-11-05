//! Keeps the window on Marq. A link to anywhere else opens in the default browser instead of
//! replacing the app, which has no back button to return with.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};
use tauri_plugin_opener::OpenerExt;

/// Schemes the app itself loads from.
const OWN_SCHEMES: [&str; 6] = ["tauri", "asset", "ipc", "about", "data", "blob"];
/// Schemes handed to the system when the window is asked to go there.
const EXTERNAL_SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// Whether the window may load `url`, given the page it shows now (none before the first load).
fn is_internal(url: &Url, current: Option<&Url>) -> bool {
    if OWN_SCHEMES.contains(&url.scheme()) {
        return true;
    }
    match current {
        None => true,
        Some(c) if c.scheme() == "about" => true,
        // The app's own origin: the dev server while developing, tauri://localhost when built.
        Some(c) => c.origin() == url.origin(),
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("marq-navigation")
        .on_navigation(|webview, url| {
            if is_internal(url, webview.url().ok().as_ref()) {
                return true;
            }
            if EXTERNAL_SCHEMES.contains(&url.scheme())
                && let Err(e) = webview.opener().open_url(url.as_str(), None::<&str>)
            {
                eprintln!("marq: could not open {url}: {e}");
            }
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn stays_on_the_app() {
        let dev = u("http://localhost:1420/");
        let built = u("tauri://localhost/");
        assert!(is_internal(&u("http://localhost:1420/index.html"), Some(&dev)));
        assert!(is_internal(&u("tauri://localhost/x"), Some(&built)));
        assert!(is_internal(&u("http://localhost:1420/"), None), "the first load");
        assert!(is_internal(&u("http://localhost:1420/"), Some(&u("about:blank"))));
        assert!(!is_internal(&u("https://github.com/harehare/mq"), Some(&dev)));
        assert!(!is_internal(&u("https://github.com/harehare/mq"), Some(&built)));
        // Another server on localhost is somebody else's page too.
        assert!(!is_internal(&u("http://localhost:3000/"), Some(&dev)));
        assert!(!is_internal(&u("mailto:a@b.c"), Some(&built)));
    }
}
