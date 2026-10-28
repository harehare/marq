//! Per-session git worktrees and their changes.

use std::path::{Path, PathBuf};
use crate::shell;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Where a session works when its project is a git repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub repo: String,
    pub path: String,
    pub branch: String,
    /// Commit the branch started from. Changes are diffed against it.
    pub base: String,
    /// Branch checked out in the repo when the session started, for PRs.
    pub base_branch: String,
}

#[derive(Debug, Serialize)]
pub struct FileChange {
    pub path: String,
    /// `A`, `M`, `D`, `R` or `?` (untracked).
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Serialize, Default)]
pub struct Changes {
    pub files: Vec<FileChange>,
    pub additions: u32,
    pub deletions: u32,
    pub commits: Vec<String>,
    /// Whether there are uncommitted changes.
    pub dirty: bool,
    /// The branch's upstream, e.g. `origin/marq/abcd1234`, once it has been pushed.
    pub upstream: Option<String>,
    /// Commits not pushed yet: ahead of the upstream, or all session commits before the first push.
    pub ahead: u32,
    /// The branch checked out in the worktree now, which may differ from the recorded one.
    pub branch: Option<String>,
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = shell::command("git").arg("-C").arg(dir).args(args).output()?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// The repository root, if `dir` is inside a git work tree.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    git(dir, &["rev-parse", "--show-toplevel"]).ok().map(|s| PathBuf::from(s.trim()))
}

/// The checkout at `dir` as a pseudo-worktree for a session that ran in its project: the repo root,
/// diffed against `HEAD`, so only uncommitted changes show. None outside a repo or before the first commit.
pub fn checkout(dir: &Path) -> Option<Worktree> {
    let root = repo_root(dir)?;
    git(&root, &["rev-parse", "--verify", "--quiet", "HEAD"]).ok()?;
    let branch = git(&root, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?.trim().to_string();
    Some(Worktree {
        repo: root.to_string_lossy().into_owned(),
        path: root.to_string_lossy().into_owned(),
        branch: branch.clone(),
        base: "HEAD".into(),
        base_branch: branch,
    })
}

/// Checks a branch name with git's own rules and returns it normalized.
pub fn check_branch_name(repo: &Path, name: &str) -> Result<String> {
    let out = shell::command("git").arg("-C").arg(repo).args(["check-ref-format", "--branch", name.trim()]).output()?;
    if !out.status.success() || name.trim().is_empty() {
        return Err(Error::Other(format!("not a valid branch name: {name}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn branch_exists(repo: &Path, name: &str) -> bool {
    git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok()
}

/// The branch for a new worktree: `wanted` if given, otherwise `marq/<short id>`. The name can be
/// changed later with [`rename_branch`]. `-2`, `-3`… keep it unique.
pub fn branch_name(repo: &Path, wanted: Option<&str>, session_id: &str) -> Result<String> {
    let base = match wanted.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => check_branch_name(repo, w)?,
        None => format!("marq/{}", &session_id[session_id.len().saturating_sub(8)..]),
    };
    let mut name = base.clone();
    let mut n = 2;
    while branch_exists(repo, &name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    Ok(name)
}

/// Creates `~/.marq/worktrees/<repo>/<short id>` on a new `branch` from HEAD.
/// With `carry`, the repo's uncommitted changes and untracked files are copied into it as well.
pub fn create(repo: &Path, session_id: &str, branch: &str, carry: bool) -> Result<Worktree> {
    let short = &session_id[session_id.len().saturating_sub(8)..];
    let name = repo.file_name().unwrap_or_default().to_string_lossy();
    let path = dirs::home_dir().unwrap_or_default().join(".marq/worktrees").join(&*name).join(short);
    std::fs::create_dir_all(path.parent().unwrap())?;
    let base = git(repo, &["rev-parse", "HEAD"])?.trim().to_string();
    let base_branch = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    git(repo, &["worktree", "add", "-b", branch, &path.to_string_lossy(), &base])?;
    if carry {
        carry_changes(repo, &path)?;
    }
    Ok(Worktree {
        repo: repo.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        branch: branch.to_string(),
        base,
        base_branch,
    })
}

/// The worktree with the branch that is checked out in it now. Claude (or the user in a terminal)
/// may have renamed or switched it, so the recorded name cannot be trusted.
pub fn sync_branch(wt: &Worktree) -> Result<Worktree> {
    let dir = Path::new(&wt.path);
    if !dir.exists() {
        return Ok(wt.clone());
    }
    let head = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if head == "HEAD" {
        return Err(Error::Other(format!(
            "the worktree is on a detached HEAD, not on a branch. Check out a branch in {} first",
            wt.path
        )));
    }
    Ok(Worktree { branch: head, ..wt.clone() })
}

/// `<repo>/.git/worktrees/<name>`, from the worktree's `.git` file.
fn git_dir(wt: &Worktree) -> Option<PathBuf> {
    let text = std::fs::read_to_string(Path::new(&wt.path).join(".git")).ok()?;
    let dir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    Some(if dir.is_absolute() { dir } else { Path::new(&wt.path).join(dir) })
}

/// Checked-out branch from the HEAD file, without running git. None when detached or missing.
pub fn head_branch(wt: &Worktree) -> Option<String> {
    let head = std::fs::read_to_string(git_dir(wt)?.join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(str::to_string)
}

/// HEAD and index mtimes, to tell when a cached diffstat is stale.
pub fn state_stamp(wt: &Worktree) -> Option<(std::time::SystemTime, std::time::SystemTime)> {
    let dir = git_dir(wt)?;
    let mtime = |f: &str| std::fs::metadata(dir.join(f)).and_then(|m| m.modified()).ok();
    Some((mtime("HEAD")?, mtime("index").unwrap_or(std::time::UNIX_EPOCH)))
}

/// `changes` totals (added, deleted) with two git calls instead of eight.
pub fn diffstat(wt: &Worktree) -> Result<(u32, u32)> {
    let dir = Path::new(&wt.path);
    if !dir.exists() {
        return Ok((0, 0));
    }
    let (mut add, mut del) = (0, 0);
    for line in git(dir, &["diff", "--numstat", "-M", &wt.base])?.lines() {
        let mut f = line.split('\t');
        add += f.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
        del += f.next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
    }
    for path in git(dir, &["ls-files", "--others", "--exclude-standard"])?.lines() {
        add += std::fs::read_to_string(dir.join(path)).map(|t| t.lines().count() as u32).unwrap_or(0);
    }
    Ok((add, del))
}

/// Renames the session's branch. Commits and an upstream already pushed under the old name stay
/// as they are; the next push goes to the new name.
pub fn rename_branch(wt: &Worktree, new_name: &str) -> Result<Worktree> {
    let repo = Path::new(&wt.repo);
    let name = check_branch_name(repo, new_name)?;
    if name == wt.branch {
        return Ok(wt.clone());
    }
    if branch_exists(repo, &name) {
        return Err(Error::Other(format!("a branch named {name} already exists")));
    }
    git(repo, &["branch", "-m", &wt.branch, &name])?;
    Ok(Worktree { branch: name, ..wt.clone() })
}

/// Applies `repo`'s uncommitted diff to `dest` and copies its untracked files.
fn carry_changes(repo: &Path, dest: &Path) -> Result<()> {
    use std::io::Write;
    let patch = shell::command("git").arg("-C").arg(repo).args(["diff", "HEAD", "--binary"]).output()?.stdout;
    if !patch.is_empty() {
        let mut child = shell::command("git")
            .arg("-C")
            .arg(dest)
            .args(["apply", "--whitespace=nowarn", "-"])
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()?;
        child.stdin.take().unwrap().write_all(&patch)?;
        let out = child.wait_with_output()?;
        if !out.status.success() {
            return Err(Error::Other(format!("git apply: {}", String::from_utf8_lossy(&out.stderr).trim())));
        }
    }
    for file in git(repo, &["ls-files", "--others", "--exclude-standard"])?.lines() {
        let to = dest.join(file);
        std::fs::create_dir_all(to.parent().unwrap())?;
        std::fs::copy(repo.join(file), to)?;
    }
    Ok(())
}

/// Counts per file from `git diff --numstat -z`. A rename is `add\tdel\t\0old\0new\0`; binary files count as 0.
fn parse_numstat(out: &str) -> Vec<(u32, u32)> {
    let mut rows = vec![];
    let mut tokens = out.split('\0');
    while let Some(t) = tokens.next() {
        if t.is_empty() {
            continue;
        }
        let mut f = t.splitn(3, '\t');
        let add = f.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let del = f.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        if f.next() == Some("") {
            // Rename or copy: the old and new paths follow as separate entries.
            tokens.next();
            tokens.next();
        }
        rows.push((add, del));
    }
    rows
}

/// Status letter and (new) path per file from `git diff --name-status -z`.
fn parse_name_status(out: &str) -> Vec<(String, String)> {
    let mut rows = vec![];
    let mut tokens = out.split('\0');
    while let Some(status) = tokens.next() {
        let Some(letter) = status.chars().next() else { continue };
        if matches!(letter, 'R' | 'C') {
            tokens.next();
        }
        rows.push((letter.to_string(), tokens.next().unwrap_or_default().to_string()));
    }
    rows
}

/// Committed and uncommitted changes since `base`, including untracked files.
pub fn changes(wt: &Worktree) -> Result<Changes> {
    let dir = Path::new(&wt.path);
    if !dir.exists() {
        return Ok(Changes::default());
    }
    // `-z` keeps non-ASCII and special-character paths literal; otherwise git quotes them
    // (`"\346\227\245.md"`), and that string matches nothing when passed back to `file_diff`.
    let mut files: Vec<FileChange> = vec![];
    let numstat = parse_numstat(&git(dir, &["diff", "--numstat", "-z", "-M", &wt.base])?);
    let names = parse_name_status(&git(dir, &["diff", "--name-status", "-z", "-M", &wt.base])?);
    for ((add, del), (status, path)) in numstat.into_iter().zip(names) {
        files.push(FileChange { path, status, additions: add, deletions: del });
    }
    for path in git(dir, &["ls-files", "--others", "--exclude-standard", "-z"])?.split('\0').filter(|p| !p.is_empty()) {
        let lines = std::fs::read_to_string(dir.join(path)).map(|t| t.lines().count() as u32).unwrap_or(0);
        files.push(FileChange { path: path.to_string(), status: "?".into(), additions: lines, deletions: 0 });
    }
    let commits: Vec<String> = git(dir, &["log", "--format=%h %s", &format!("{}..HEAD", wt.base)])?
        .lines()
        .map(str::to_string)
        .collect();
    let dirty = !git(dir, &["status", "--porcelain"])?.trim().is_empty();
    let upstream = git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .ok()
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty());
    let ahead = match &upstream {
        Some(_) => git(dir, &["rev-list", "--count", "@{u}..HEAD"])?.trim().parse().unwrap_or(0),
        None => commits.len() as u32,
    };
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().map(|b| b.trim().to_string()).filter(|b| b != "HEAD");
    Ok(Changes {
        dirty,
        upstream,
        ahead,
        branch,
        additions: files.iter().map(|f| f.additions).sum(),
        deletions: files.iter().map(|f| f.deletions).sum(),
        files,
        commits,
    })
}

/// Unified diff of one file against `base`. Untracked files are shown as all-added.
pub fn file_diff(wt: &Worktree, file: &str) -> Result<String> {
    let dir = Path::new(&wt.path);
    let untracked = !git(dir, &["ls-files", "--others", "--exclude-standard", "--", file])?.trim().is_empty();
    if untracked {
        // `git diff --no-index` exits 1 when files differ, so read stdout directly.
        let out = shell::command("git")
            .arg("-C")
            .arg(dir)
            .args(["diff", "--no-index", "--", "/dev/null", file])
            .output()?;
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    git(dir, &["diff", "-M", &wt.base, "--", file])
}

pub fn commit_all(wt: &Worktree, message: &str) -> Result<String> {
    let dir = Path::new(&wt.path);
    git(dir, &["add", "-A"])?;
    git(dir, &["commit", "-m", message])?;
    Ok(git(dir, &["log", "-1", "--format=%h %s"])?.trim().to_string())
}

/// Pushes the session's branch to `origin` and sets it as the upstream. Returns the upstream name.
pub fn push(wt: &Worktree) -> Result<String> {
    let dir = Path::new(&wt.path);
    git(dir, &["push", "-u", "origin", &wt.branch])?;
    Ok(git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.trim().to_string())
}

/// Pushes the branch checked out in `dir` (a session without a worktree). Returns the upstream.
pub fn push_dir(dir: &Path) -> Result<String> {
    let branch = git(dir, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
    if branch == "HEAD" {
        return Err(Error::Other("detached HEAD: check out a branch to push".into()));
    }
    git(dir, &["push", "-u", "origin", &branch])?;
    Ok(git(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.trim().to_string())
}

/// Splits a commit-style message into a PR title (first line) and body (the rest), adding a footer.
pub fn pr_text(message: &str, fallback_title: &str, footer: &str) -> (String, String) {
    let message = message.trim();
    let (first, rest) = message.split_once('\n').unwrap_or((message, ""));
    let title = if first.trim().is_empty() { fallback_title.trim() } else { first.trim() };
    let rest = rest.trim();
    let body = if rest.is_empty() { footer.to_string() } else { format!("{rest}\n\n{footer}") };
    (title.to_string(), body)
}

/// Pushes the branch and opens a PR against the branch the session started from. Returns the PR URL.
pub fn create_pr(wt: &Worktree, title: &str, body: &str) -> Result<String> {
    let dir = Path::new(&wt.path);
    push(wt)?;
    let out = shell::command("gh")
        .current_dir(dir)
        .args(["pr", "create", "--base", &wt.base_branch, "--head", &wt.branch, "--title", title, "--body", body])
        .output()?;
    if !out.status.success() {
        return Err(Error::Other(format!("gh pr create: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Removes the worktree. The branch is kept so committed work is never lost.
///
/// The directory is first renamed out of the way, which is instant. Deleting it in place takes a
/// while for a large checkout, and anything that diffs it meanwhile sees every file as deleted.
pub fn remove(wt: &Worktree) -> Result<()> {
    let path = Path::new(&wt.path);
    if path.exists() {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let doomed = path.with_file_name(format!(".{name}.removing-{}", std::process::id()));
        std::fs::rename(path, &doomed)?;
        // The worktree's directory is gone, so prune drops its registration (the branch stays).
        git(Path::new(&wt.repo), &["worktree", "prune"])?;
        std::fs::remove_dir_all(&doomed)?;
    } else {
        git(Path::new(&wt.repo), &["worktree", "prune"])?;
    }
    Ok(())
}

pub fn delete_branch(wt: &Worktree) -> Result<()> {
    git(Path::new(&wt.repo), &["branch", "-D", &wt.branch])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
    }

    #[test]
    fn worktree_changes() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "one\ntwo\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);

        let home = tempfile::tempdir().unwrap();
        let wt_path = home.path().join("wt");
        let base = git(r, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        git(r, &["worktree", "add", "-b", "marq/x", &wt_path.to_string_lossy(), &base]).unwrap();
        let wt = Worktree {
            repo: r.to_string_lossy().into(),
            path: wt_path.to_string_lossy().into(),
            branch: "marq/x".into(),
            base,
            base_branch: "main".into(),
        };

        std::fs::write(wt_path.join("a.txt"), "one\n2\nthree\n").unwrap();
        std::fs::write(wt_path.join("new.txt"), "x\ny\n").unwrap();
        let c = changes(&wt).unwrap();
        assert_eq!(c.files.len(), 2);
        assert_eq!((c.additions, c.deletions), (4, 1));
        assert!(c.dirty);
        assert!(file_diff(&wt, "a.txt").unwrap().contains("+three"));
        assert!(file_diff(&wt, "new.txt").unwrap().contains("+y"));

        commit_all(&wt, "change").unwrap();
        let c = changes(&wt).unwrap();
        assert_eq!(c.commits.len(), 1);
        assert!(!c.dirty);
        assert_eq!(c.files.len(), 2);
        assert_eq!(c.files.iter().find(|f| f.path == "new.txt").unwrap().status, "A");

        remove(&wt).unwrap();
        assert!(!wt_path.exists());
        assert!(git(r, &["rev-parse", "marq/x"]).is_ok());
        remove(&wt).unwrap();
        delete_branch(&wt).unwrap();
        assert!(git(r, &["rev-parse", "--verify", "marq/x"]).is_err());
    }

    #[test]
    fn non_ascii_paths_and_renames() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("old.txt"), "a\nb\nc\nd\n").unwrap();
        std::fs::write(r.join("keep.txt"), "k\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);
        let base = git(r, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let wt = Worktree {
            repo: r.to_string_lossy().into(),
            path: r.to_string_lossy().into(),
            branch: "main".into(),
            base,
            base_branch: "main".into(),
        };

        std::fs::write(r.join("日本語.md"), "one\ntwo\n").unwrap();
        std::fs::write(r.join("empty.txt"), "").unwrap();
        std::fs::rename(r.join("old.txt"), r.join("新しい.txt")).unwrap();
        std::fs::write(r.join("keep.txt"), "k\nk2\n").unwrap();
        sh(r, &["add", "-A"]);
        std::fs::write(r.join("未追跡.md"), "x\n").unwrap();

        let c = changes(&wt).unwrap();
        let find = |p: &str| c.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} missing in {:?}", c.files));
        assert_eq!(find("日本語.md").additions, 2);
        assert_eq!(find("新しい.txt").status, "R");
        assert_eq!(find("keep.txt").additions, 1);
        assert_eq!(find("未追跡.md").additions, 1);
        assert!(file_diff(&wt, "日本語.md").unwrap().contains("+two"));
        assert!(file_diff(&wt, "未追跡.md").unwrap().contains("+x"));
    }

    #[test]
    fn push_tracks_unpushed_commits() {
        let origin = tempfile::tempdir().unwrap();
        sh(origin.path(), &["init", "-q", "--bare", "-b", "main"]);
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        sh(r, &["remote", "add", "origin", &origin.path().to_string_lossy()]);
        std::fs::write(r.join("a.txt"), "x\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);

        let home = tempfile::tempdir().unwrap();
        let wt_path = home.path().join("wt");
        let base = git(r, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        git(r, &["worktree", "add", "-b", "marq/p", &wt_path.to_string_lossy(), &base]).unwrap();
        let wt = Worktree { repo: r.to_string_lossy().into(), path: wt_path.to_string_lossy().into(), branch: "marq/p".into(), base, base_branch: "main".into() };

        std::fs::write(wt_path.join("b.txt"), "y\n").unwrap();
        commit_all(&wt, "one").unwrap();
        let c = changes(&wt).unwrap();
        assert_eq!((c.upstream.as_deref(), c.ahead), (None, 1));

        assert_eq!(push(&wt).unwrap(), "origin/marq/p");
        let c = changes(&wt).unwrap();
        assert_eq!((c.upstream.as_deref(), c.ahead), (Some("origin/marq/p"), 0));

        std::fs::write(wt_path.join("c.txt"), "z\n").unwrap();
        commit_all(&wt, "two").unwrap();
        assert_eq!(changes(&wt).unwrap().ahead, 1);
    }

    #[test]
    fn pr_title_and_body() {
        let f = "Created from marq session `s`.";
        assert_eq!(pr_text("Fix hover\n\nShow types.\nAlso docs.", "t", f), ("Fix hover".into(), format!("Show types.\nAlso docs.\n\n{f}")));
        assert_eq!(pr_text("Just a title", "t", f), ("Just a title".into(), f.into()));
        assert_eq!(pr_text("  \n", "Session title", f), ("Session title".into(), f.into()));
    }

    #[test]
    fn branch_names() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "x\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);
        let id = "0192f0c5-0000-7000-8000-0000abcd1234";

        assert_eq!(branch_name(r, None, id).unwrap(), "marq/abcd1234");
        assert_eq!(branch_name(r, Some("feature/x"), id).unwrap(), "feature/x");
        assert!(branch_name(r, Some("bad name.."), id).is_err());
        sh(r, &["branch", "marq/abcd1234"]);
        assert_eq!(branch_name(r, None, id).unwrap(), "marq/abcd1234-2");

        let home = tempfile::tempdir().unwrap();
        let wt_path = home.path().join("wt");
        git(r, &["worktree", "add", "-b", "marq/tmp", &wt_path.to_string_lossy(), "HEAD"]).unwrap();
        let wt = Worktree {
            repo: r.to_string_lossy().into(),
            path: wt_path.to_string_lossy().into(),
            branch: "marq/tmp".into(),
            base: String::new(),
            base_branch: "main".into(),
        };
        // Renamed outside Marq, e.g. by Claude running git in the worktree.
        git(&wt_path, &["branch", "-m", "marq/by-claude"]).unwrap();
        assert_eq!(sync_branch(&wt).unwrap().branch, "marq/by-claude");
        assert_eq!(head_branch(&wt).as_deref(), Some("marq/by-claude"));
        assert!(state_stamp(&wt).is_some());
        let base = git(&wt_path, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(wt_path.join("new.txt"), "a\nb\n").unwrap();
        assert_eq!(diffstat(&Worktree { base, ..wt.clone() }).unwrap(), (2, 0));
        std::fs::remove_file(wt_path.join("new.txt")).unwrap();
        let wt = sync_branch(&wt).unwrap();
        let renamed = rename_branch(&wt, "feature/hover-types").unwrap();
        assert_eq!(renamed.branch, "feature/hover-types");
        assert_eq!(git(&wt_path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(), "feature/hover-types");
        assert!(rename_branch(&renamed, "marq/abcd1234").is_err(), "existing name");
        assert!(rename_branch(&renamed, "a..b").is_err(), "invalid name");
        git(&wt_path, &["checkout", "-q", "--detach"]).unwrap();
        assert!(sync_branch(&renamed).is_err(), "detached HEAD");
    }

    #[test]
    fn carry_uncommitted_changes() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "one\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);
        std::fs::write(r.join("a.txt"), "one\nedited\n").unwrap();
        std::fs::create_dir(r.join("sub")).unwrap();
        std::fs::write(r.join("sub/new.txt"), "new\n").unwrap();

        let dest = tempfile::tempdir().unwrap();
        let wt = dest.path().join("wt");
        git(r, &["worktree", "add", "-b", "marq/y", &wt.to_string_lossy(), "HEAD"]).unwrap();
        carry_changes(r, &wt).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "one\nedited\n");
        assert_eq!(std::fs::read_to_string(wt.join("sub/new.txt")).unwrap(), "new\n");
        // The original repo is left as it was.
        assert_eq!(std::fs::read_to_string(r.join("a.txt")).unwrap(), "one\nedited\n");
    }
}
