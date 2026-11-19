//! The user's shell environment. Apps started from Finder or the Dock get a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew tools such as `gh`, `node` and `claude`, and
//! anything the agent runs through Bash, would not be found without this. On Windows an app gets the
//! user's own PATH, so it is used as is.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

#[cfg(unix)]
const MARK: &str = "__MARQ_PATH__";

/// PATH from an interactive login shell, read once. Interactive, so PATH set in `.zshrc` counts too.
#[cfg(unix)]
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let shell = default_shell();
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

/// A UTF-8 `LANG` for a terminal when the app has no locale, as when started from Finder or the Dock: without
/// one, `less`, `vim` and the like take the terminal for ASCII and print `<E2><94><82>` for `│`. None when
/// the environment already names a locale.
pub fn lang() -> Option<&'static str> {
    static LANG: OnceLock<Option<String>> = OnceLock::new();
    LANG.get_or_init(|| {
        let set = |k: &str| std::env::var(k).is_ok_and(|v| !v.is_empty());
        if cfg!(windows) || set("LC_ALL") || set("LC_CTYPE") || set("LANG") {
            return None;
        }
        Some(system_lang())
    })
    .as_deref()
}

/// The language and region of System Settings, as Terminal.app does, when the system has that locale.
#[cfg(target_os = "macos")]
fn system_lang() -> String {
    std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().split('@').next().unwrap_or_default().to_string())
        .map(|l| format!("{l}.UTF-8"))
        .filter(|l| l.len() > 6 && Path::new("/usr/share/locale").join(l).exists())
        .unwrap_or_else(|| "en_US.UTF-8".into())
}

#[cfg(not(target_os = "macos"))]
fn system_lang() -> String {
    "C.UTF-8".into()
}

#[cfg(windows)]
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| std::env::var("PATH").unwrap_or_default())
}

/// The shell to start for the user: `$SHELL`, else zsh on macOS and bash elsewhere (sh if neither is there).
/// On Windows, PowerShell 7 if it is installed, else Windows PowerShell, else `%COMSPEC%`.
pub fn default_shell() -> String {
    #[cfg(unix)]
    {
        let fallback = if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/bash" };
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| [fallback, "/bin/sh"].into_iter().find(|p| Path::new(p).exists()).map(str::to_string))
            .unwrap_or_else(|| "/bin/sh".into())
    }
    #[cfg(windows)]
    {
        ["pwsh", "powershell"]
            .into_iter()
            .map(which)
            .find(|p| Path::new(p).is_absolute())
            .or_else(|| std::env::var("COMSPEC").ok())
            .unwrap_or_else(|| "cmd.exe".into())
    }
}

/// The name of a shell's program without its folder and `.exe`, lower case: `/bin/zsh` is `zsh`,
/// `C:\Program Files\Git\bin\bash.exe` is `bash`.
pub fn shell_name(shell: &str) -> String {
    let file = shell.rsplit(['/', '\\']).next().unwrap_or(shell).to_lowercase();
    file.strip_suffix(".exe").map(str::to_string).unwrap_or(file)
}

/// The arguments that make `shell` run `command` through its own syntax, for a shell whose syntax
/// is not sh's: PowerShell and cmd on Windows. `None` for sh-style shells, which take `-c`.
pub fn command_args(shell: &str, command: &str) -> Option<Vec<String>> {
    match shell_name(shell).as_str() {
        "pwsh" | "powershell" => Some(vec!["-NoLogo".into(), "-Command".into(), command.into()]),
        "cmd" => Some(vec!["/C".into(), command.into()]),
        _ => None,
    }
}

/// A command line run by the platform's own shell: `sh -c` on Unix, `cmd /C` on Windows.
pub fn system_command(command: &str) -> std::process::Command {
    #[cfg(unix)]
    {
        let mut c = std::process::Command::new("/bin/sh");
        c.args(["-c", command]);
        c
    }
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()));
        c.args(["/C", command]);
        c
    }
}

/// Full path of a command found on the shell PATH, or the bare name when it is not there.
/// On Windows the extensions in `%PATHEXT%` are tried too, so `claude` finds `claude.cmd` or `claude.exe`.
pub fn which(name: &str) -> String {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(p) = cache.lock().unwrap().get(name) {
        return p.clone();
    }
    let found = std::env::split_paths(path())
        .flat_map(|dir| candidates(&dir, name))
        .find(|p| is_executable(p))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    cache.lock().unwrap().insert(name.to_string(), found.clone());
    found
}

#[cfg(unix)]
fn candidates(dir: &Path, name: &str) -> Vec<std::path::PathBuf> {
    vec![dir.join(name)]
}

#[cfg(windows)]
fn candidates(dir: &Path, name: &str) -> Vec<std::path::PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut found = vec![dir.join(name)];
    found.extend(exts.split(';').filter(|e| !e.is_empty()).map(|e| dir.join(format!("{name}{}", e.to_lowercase()))));
    found
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Windows has no execute bit; a file with an executable extension is one.
#[cfg(windows)]
fn is_executable(p: &Path) -> bool {
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    p.is_file() && matches!(ext.as_str(), "exe" | "com" | "bat" | "cmd")
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
    #[cfg(unix)]
    fn reads_the_shell_path() {
        assert!(path().split(':').any(|d| d == "/usr/bin"), "{}", path());
        assert!(which("git").ends_with("/git"));
        assert_eq!(which("surely-not-a-command-xyz"), "surely-not-a-command-xyz");
    }

    #[test]
    #[cfg(windows)]
    fn finds_commands_with_their_extension() {
        assert!(which("git").to_lowercase().ends_with("git.exe"), "{}", which("git"));
        assert_eq!(which("surely-not-a-command-xyz"), "surely-not-a-command-xyz");
    }

    #[test]
    fn names_shells_on_either_platform() {
        assert_eq!(shell_name("/bin/zsh"), "zsh");
        assert_eq!(shell_name(r"C:\Program Files\Git\bin\bash.exe"), "bash");
        assert_eq!(shell_name("PowerShell.EXE"), "powershell");
    }

    #[test]
    fn powershell_and_cmd_have_their_own_arguments() {
        assert_eq!(command_args("pwsh", "ls").unwrap(), ["-NoLogo", "-Command", "ls"]);
        assert_eq!(command_args(r"C:\Windows\System32\cmd.exe", "dir").unwrap(), ["/C", "dir"]);
        assert!(command_args("/bin/zsh", "ls").is_none());
    }
}
