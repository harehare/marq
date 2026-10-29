//! The user's shell environment. Apps started from Finder or the Dock get a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew tools such as `gh`, `node` and `claude`, and
//! anything the agent runs through Bash, would not be found without this.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

const MARK: &str = "__MARQ_PATH__";

/// PATH from an interactive login shell, read once. Interactive, so PATH set in `.zshrc` counts too.
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let script = format!("printf '{MARK}%s{MARK}' \"$PATH\"");
        std::process::Command::new(shell)
            .args(["-ilc", &script])
            .stdin(std::process::Stdio::null())
            .output()
            .ok()
            .and_then(|o| {
                // rc files may print their own output, so read only between the markers.
                let out = String::from_utf8_lossy(&o.stdout).into_owned();
                let start = out.find(MARK)? + MARK.len();
                let len = out[start..].find(MARK)?;
                Some(out[start..start + len].to_string())
            })
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
    })
}

/// Full path of a command found on the shell PATH, or the bare name when it is not there.
pub fn which(name: &str) -> String {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(p) = cache.lock().unwrap().get(name) {
        return p.clone();
    }
    let found = std::env::split_paths(path())
        .map(|dir| dir.join(name))
        .find(|p| is_executable(p))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    cache.lock().unwrap().insert(name.to_string(), found.clone());
    found
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// A command resolved on the shell PATH, run with that PATH so its own children find tools too.
pub fn command(name: &str) -> std::process::Command {
    let mut c = std::process::Command::new(which(name));
    c.env("PATH", path());
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_shell_path() {
        assert!(path().split(':').any(|d| d == "/usr/bin"), "{}", path());
        assert!(which("git").ends_with("/git"));
        assert_eq!(which("surely-not-a-command-xyz"), "surely-not-a-command-xyz");
    }
}
