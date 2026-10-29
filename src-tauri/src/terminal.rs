//! Terminals in tabs: a login shell on a PTY, streamed to xterm.js in the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::{config, shell, vault};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals(Mutex<HashMap<String, Term>>);

impl Terminals {
    /// A login shell, or `command` run by one.
    pub fn open(&self, app: &AppHandle, id: &str, cwd: &str, cols: u16, rows: u16, command: Option<&str>) -> Result<()> {
        let pty = native_pty_system()
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| Error::Other(format!("could not open a terminal: {e}")))?;
        let (configured, args) = config::terminal_shell();
        let shell = configured.unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into()));
        let mut cmd = match command {
            // Commands are written for sh, which nu, fish and the like don't parse.
            Some(c) => {
                let sh = [Some(shell.clone()), std::env::var("SHELL").ok(), Some("/bin/zsh".into())]
                    .into_iter()
                    .flatten()
                    .find(|s| posix(s) && std::path::Path::new(s).exists())
                    .unwrap_or_else(|| "/bin/sh".into());
                let mut cmd = CommandBuilder::new(sh);
                cmd.args(["-l", "-i", "-c", c]);
                cmd
            }
            None => {
                let mut cmd = CommandBuilder::new(&shell);
                cmd.args(args.unwrap_or_else(|| vec!["-l".into()]));
                cmd
            }
        };
        cmd.cwd(vault::expand_home(cwd));
        cmd.env("PATH", shell::path());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        let child = pty.slave.spawn_command(cmd).map_err(|e| Error::Other(format!("could not start {shell}: {e}")))?;
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().map_err(|e| Error::Other(e.to_string()))?;
        let writer = pty.master.take_writer().map_err(|e| Error::Other(e.to_string()))?;

        let (app, tid) = (app.clone(), id.to_string());
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // Bytes of a UTF-8 character split across reads.
            let mut rest: Vec<u8> = vec![];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                rest.extend_from_slice(&buf[..n]);
                let valid = match std::str::from_utf8(&rest) {
                    Ok(_) => rest.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(_) => rest.len(),
                };
                let data = String::from_utf8_lossy(&rest[..valid]).into_owned();
                rest.drain(..valid);
                let _ = app.emit("terminal://data", json!({"id": tid, "data": data}));
            }
            let _ = app.emit("terminal://exit", json!({"id": tid}));
        });

        self.0.lock().unwrap().insert(id.to_string(), Term { master: pty.master, writer, child });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut terms = self.0.lock().unwrap();
        let t = terms.get_mut(id).ok_or_else(|| Error::Other("the terminal is closed".into()))?;
        t.writer.write_all(data.as_bytes())?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        if let Some(t) = self.0.lock().unwrap().get(id) {
            t.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| Error::Other(e.to_string()))?;
        }
        Ok(())
    }

    pub fn close(&self, id: &str) {
        if let Some(mut t) = self.0.lock().unwrap().remove(id) {
            let _ = t.child.kill();
        }
    }
}

/// Whether the shell runs sh syntax.
fn posix(shell: &str) -> bool {
    let name = shell.rsplit('/').next().unwrap_or(shell);
    matches!(name, "sh" | "bash" | "zsh" | "dash" | "ksh")
}

#[cfg(test)]
mod tests {
    #[test]
    fn tells_posix_shells() {
        assert!(super::posix("/bin/zsh") && super::posix("/opt/homebrew/bin/bash") && super::posix("sh"));
        assert!(!super::posix("/opt/homebrew/bin/nu") && !super::posix("/opt/homebrew/bin/fish"));
    }
}
