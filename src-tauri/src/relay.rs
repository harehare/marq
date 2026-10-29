//! Messages between sessions outside crews.
//!
//! The recipient's log gets a `marq_message` line just before the prompt, and the sender's a
//! `marq_sent` line, so both sessions show where a message came from and went. A message that asks
//! for a reply gets one: when the recipient finishes the turn that handled it, that turn's result
//! is sent back to the sender (`marq_replied` marks it answered).

use std::path::Path;
use std::sync::Mutex;

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::session;
use crate::error::{Error, Result};
use crate::sidecar::{Runner, Turn};
use crate::vault;

/// Held while replies are found and sent, so two turn ends never answer one message twice.
static REPLIES: Mutex<()> = Mutex::new(());

/// Who sent a message: a session itself (with its tool) or the user on its behalf.
#[derive(Clone, Copy, PartialEq)]
pub enum By {
    Session,
    User,
}

fn add(app: &AppHandle, vault: &Path, session: &str, line: Value) -> Result<()> {
    session::append(&session::raw_path(vault, session), &line)?;
    let _ = app.emit("session://event", json!({"session_id": session, "event": line}));
    Ok(())
}

/// Sends `text` from session `from` to session `to`, resuming `to` if it has stopped. With
/// `reply`, the answer comes back to `from` when `to` finishes the turn.
pub fn send(app: &AppHandle, vault: &Path, from: &str, to: &str, text: &str, reply: bool, by: By) -> Result<()> {
    if from == to {
        return Err(Error::Other("a session cannot send to itself".into()));
    }
    if text.trim().is_empty() {
        return Err(Error::Other("the message is empty".into()));
    }
    let sender = session::meta(vault, from)?;
    let meta = session::meta(vault, to)?;
    let prompt = match by {
        By::Session => {
            let back = if reply { " Your final answer this turn is sent back to it automatically." } else { "" };
            format!("Message from another Marq session, \"{}\" ({from}).{back}\n\n{}", sender.title, text.trim())
        }
        By::User => text.trim().to_string(),
    };
    let id = vault::new_id();
    let at = vault::now();
    let by = if by == By::User { "user" } else { "session" };
    add(app, vault, to, json!({"type": "marq_message", "id": id, "from": from, "title": sender.title, "reply": reply, "by": by, "at": at}))?;
    app.state::<Runner>().start(app.clone(), vault.to_path_buf(), meta.clone(), prompt, Turn::Resume)?;
    add(app, vault, from, json!({"type": "marq_sent", "id": id, "to": to, "title": meta.title, "reply": reply, "by": by, "at": at}))
}

/// Messages in a session's log whose reply is due: (message id, sender, the result that answers it).
/// A message is answered by the first turn that starts after the turns already queued before it.
fn due(events: &[Value]) -> Vec<(String, String, String)> {
    let replied: Vec<&str> = events.iter().filter(|e| e["type"] == "marq_replied").filter_map(|e| e["msg"].as_str()).collect();
    let mut out = vec![];
    for (i, e) in events.iter().enumerate() {
        if e["type"] != "marq_message" || e["reply"] != true {
            continue;
        }
        let (Some(id), Some(from)) = (e["id"].as_str(), e["from"].as_str()) else { continue };
        if replied.contains(&id) {
            continue;
        }
        let count = |t: &str| events[..i].iter().filter(|x| x["type"] == t).count();
        let queued = count("marq_user").saturating_sub(count("result"));
        if let Some(r) = events[i..].iter().filter(|x| x["type"] == "result").nth(queued) {
            out.push((id.to_string(), from.to_string(), r["result"].as_str().unwrap_or("").to_string()));
        }
    }
    out
}

/// Called when a session's turn ends: sends the replies its senders are waiting for.
pub fn on_turn_end(app: &AppHandle, vault: &Path, session: &str) -> Result<()> {
    let _lock = REPLIES.lock().unwrap();
    let events = session::read_events(vault, session)?;
    let replies = due(&events);
    if replies.is_empty() {
        return Ok(());
    }
    let meta = session::meta(vault, session)?;
    for (msg, to, result) in replies {
        session::append(&session::raw_path(vault, session), &json!({"type": "marq_replied", "msg": msg, "at": vault::now()}))?;
        let Ok(sender) = session::meta(vault, &to) else { continue };
        let answer = if result.trim().is_empty() { "(it finished without a written answer)" } else { result.trim() };
        let prompt = format!("Reply from the Marq session \"{}\" ({session}) to your message:\n\n{answer}", meta.title);
        add(app, vault, &to, json!({"type": "marq_message", "id": vault::new_id(), "from": session, "title": meta.title, "reply": false, "by": "reply", "at": vault::now()}))?;
        app.state::<Runner>().start(app.clone(), vault.to_path_buf(), sender, prompt, Turn::Resume)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_with_the_turn_that_handled_the_message() {
        let msg = |id: &str| json!({"type": "marq_message", "id": id, "from": "a", "reply": true});
        let user = json!({"type": "marq_user"});
        let result = |r: &str| json!({"type": "result", "result": r});
        // Sent while idle: the next result answers it.
        let ev = vec![user.clone(), result("first"), msg("m1"), user.clone()];
        assert!(due(&ev).is_empty());
        let mut ev = ev;
        ev.push(result("answer"));
        assert_eq!(due(&ev), [("m1".to_string(), "a".to_string(), "answer".to_string())]);
        ev.push(json!({"type": "marq_replied", "msg": "m1"}));
        assert!(due(&ev).is_empty());
        // Sent during a turn: that turn's result is not the answer.
        let ev = vec![user.clone(), msg("m2"), user.clone(), result("busy")];
        assert!(due(&ev).is_empty());
        let ev = [ev, vec![result("answer")]].concat();
        assert_eq!(due(&ev)[0].2, "answer");
        // No reply asked for.
        let ev = vec![json!({"type": "marq_message", "id": "m3", "from": "a", "reply": false}), user, result("x")];
        assert!(due(&ev).is_empty());
    }
}
