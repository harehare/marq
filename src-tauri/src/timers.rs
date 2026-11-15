//! Follow-ups: a deadline a session sets for itself ("check the CI run in 30 minutes").
//!
//! They live in their own file, `<vault>/.marq/timers.json`, apart from the inbox: the inbox holds
//! what is ready to be handled now, this holds what is not due yet. Every tick `take_due` moves the
//! due ones to the inbox (see `automation`), which resumes the session with the note it left itself.
//! A follow-up fires once; a repeating task is a schedule.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::vault;

/// Most follow-ups one session can have waiting, so a loop cannot fill the file.
const PER_SESSION: usize = 5;
const KEEP: usize = 100;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Timer {
    pub id: String,
    pub session_id: String,
    /// RFC 3339.
    pub due: String,
    /// What the session wants to be told when it fires.
    pub note: String,
    /// `waiting`, `fired` or `cancelled`.
    pub status: String,
    pub created: String,
}

fn file(vault: &Path) -> PathBuf {
    vault.join(".marq/timers.json")
}

fn load(vault: &Path) -> Vec<Timer> {
    std::fs::read_to_string(file(vault)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(vault: &Path, timers: &mut Vec<Timer>) -> Result<()> {
    // Finished ones are history; only the newest are kept.
    let finished = timers.iter().filter(|t| t.status != "waiting").count();
    let mut drop = finished.saturating_sub(KEEP);
    timers.retain(|t| {
        if t.status != "waiting" && drop > 0 {
            drop -= 1;
            return false;
        }
        true
    });
    let path = file(vault);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(timers).map_err(|e| Error::Other(e.to_string()))?)?;
    std::fs::rename(tmp, path)?;
    Ok(())
}

/// Sets a follow-up `after` from `now`: `5m`, `2h`, `1d`, `1w`; at least five minutes.
pub fn add(vault: &Path, session: &str, after: &str, note: &str, now: DateTime<Local>) -> Result<Timer> {
    let wait = crate::automation::parse_every(after)
        .ok_or_else(|| Error::Other(format!("cannot read \"{after}\" as a wait; use 5m, 2h, 1d or 1w (at least five minutes)")))?;
    if note.trim().is_empty() {
        return Err(Error::Other("the note is empty; say what to do when the follow-up fires".into()));
    }
    let mut timers = load(vault);
    if timers.iter().filter(|t| t.session_id == session && t.status == "waiting").count() >= PER_SESSION {
        return Err(Error::Other(format!("this session already has {PER_SESSION} follow-ups waiting; cancel one first")));
    }
    let timer = Timer {
        id: vault::new_id(),
        session_id: session.to_string(),
        due: (now + wait).to_rfc3339(),
        note: note.trim().to_string(),
        status: "waiting".into(),
        created: vault::now(),
    };
    timers.push(timer.clone());
    save(vault, &mut timers)?;
    Ok(timer)
}

/// The session's follow-ups that are still waiting, soonest first.
pub fn waiting(vault: &Path, session: &str) -> Vec<Timer> {
    let mut v: Vec<Timer> = load(vault).into_iter().filter(|t| t.session_id == session && t.status == "waiting").collect();
    v.sort_by(|a, b| a.due.cmp(&b.due));
    v
}

/// Cancels one of the session's waiting follow-ups. False when there is no such one.
pub fn cancel(vault: &Path, session: &str, id: &str) -> Result<bool> {
    let mut timers = load(vault);
    let Some(t) = timers.iter_mut().find(|t| t.id == id && t.session_id == session && t.status == "waiting") else {
        return Ok(false);
    };
    t.status = "cancelled".into();
    save(vault, &mut timers)?;
    Ok(true)
}

/// Marks the follow-ups due at `now` as fired and returns them, oldest due first.
pub fn take_due(vault: &Path, now: DateTime<Local>) -> Vec<Timer> {
    let mut timers = load(vault);
    let mut due: Vec<Timer> = vec![];
    for t in timers.iter_mut().filter(|t| t.status == "waiting") {
        if DateTime::parse_from_rfc3339(&t.due).is_ok_and(|d| d <= now) {
            t.status = "fired".into();
            due.push(t.clone());
        }
    }
    if !due.is_empty() && let Err(e) = save(vault, &mut timers) {
        eprintln!("marq: could not save the follow-ups: {e}");
        return vec![];
    }
    due.sort_by(|a, b| a.due.cmp(&b.due));
    due
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    #[test]
    fn fires_once_when_due() {
        let dir = tempfile::tempdir().unwrap();
        let now = Local::now();
        let t = add(dir.path(), "s", "30m", "check CI", now).unwrap();
        assert!(take_due(dir.path(), now + Duration::minutes(29)).is_empty());
        let due = take_due(dir.path(), now + Duration::minutes(31));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, t.id);
        assert!(take_due(dir.path(), now + Duration::hours(2)).is_empty());
    }

    #[test]
    fn rejects_bad_waits_and_empty_notes() {
        let dir = tempfile::tempdir().unwrap();
        assert!(add(dir.path(), "s", "soon", "x", Local::now()).is_err());
        assert!(add(dir.path(), "s", "1m", "x", Local::now()).is_err());
        assert!(add(dir.path(), "s", "1h", "  ", Local::now()).is_err());
    }

    #[test]
    fn a_session_has_a_limit_and_can_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let mut ids = vec![];
        for _ in 0..PER_SESSION {
            ids.push(add(dir.path(), "s", "1h", "n", Local::now()).unwrap().id);
        }
        assert!(add(dir.path(), "s", "1h", "n", Local::now()).is_err());
        assert!(add(dir.path(), "other", "1h", "n", Local::now()).is_ok());
        assert!(cancel(dir.path(), "s", &ids[0]).unwrap());
        assert!(!cancel(dir.path(), "other", &ids[1]).unwrap());
        assert_eq!(waiting(dir.path(), "s").len(), PER_SESSION - 1);
        assert!(add(dir.path(), "s", "1h", "n", Local::now()).is_ok());
    }
}
