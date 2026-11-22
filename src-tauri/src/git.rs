//! Per-session git worktrees and their changes, through libgit2: no `git` process is run.
//! (`gh pr create` is an external command, since it is GitHub's CLI rather than git; so is the `git fetch`
//! that brings a base branch up to date, which needs the user's own credential setup.)

use std::path::{Path, PathBuf};

use git2::{
    BranchType, Delta, Diff, DiffFindOptions, DiffFormat, DiffOptions, IndexAddOption, Oid,
    Repository, Status, StatusOptions,
};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::shell;

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

impl From<git2::Error> for Error {
    fn from(e: git2::Error) -> Self {
        Error::Other(format!("git: {}", e.message()))
    }
}

fn open(dir: &Path) -> Result<Repository> {
    Ok(Repository::open(dir)?)
}

/// The branch checked out in `repo`; None on a detached or unborn HEAD.
fn head_name(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if repo.head_detached().unwrap_or(false) || !head.is_branch() {
        return None;
    }
    head.shorthand().ok().map(str::to_string)
}

fn short_id(repo: &Repository, id: Oid) -> String {
    repo.find_object(id, None)
        .and_then(|o| o.short_id())
        .ok()
        .and_then(|b| b.as_str().ok().map(str::to_string))
        .unwrap_or_else(|| id.to_string().chars().take(7).collect())
}

/// `<short id> <subject>`, as `git log --format='%h %s'` prints it.
fn describe(repo: &Repository, id: Oid) -> Result<String> {
    let commit = repo.find_commit(id)?;
    Ok(format!("{} {}", short_id(repo, id), commit.summary().ok().flatten().unwrap_or_default()))
}

/// The repository root, if `dir` is inside a git work tree.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let repo = Repository::discover(dir).ok()?;
    let root = repo.workdir()?;
    Some(PathBuf::from(root.to_string_lossy().trim_end_matches(['/', '\\'])))
}

/// The checkout at `dir` as a pseudo-worktree for a session that ran in its project: the repo root,
/// diffed against `HEAD`, so only uncommitted changes show. None outside a repo or before the first commit.
pub fn checkout(dir: &Path) -> Option<Worktree> {
    let root = repo_root(dir)?;
    let repo = open(&root).ok()?;
    repo.head().ok()?.peel_to_commit().ok()?;
    let branch = head_name(&repo).unwrap_or_else(|| "HEAD".into());
    Some(Worktree {
        repo: root.to_string_lossy().into_owned(),
        path: root.to_string_lossy().into_owned(),
        branch: branch.clone(),
        base: "HEAD".into(),
        base_branch: branch,
    })
}

/// Checks a branch name with git's own rules and returns it trimmed.
pub fn check_branch_name(_repo: &Path, name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() || !git2::Branch::name_is_valid(name)? {
        return Err(Error::Other(format!("not a valid branch name: {name}")));
    }
    Ok(name.to_string())
}

fn branch_exists(repo: &Repository, name: &str) -> bool {
    repo.find_branch(name, BranchType::Local).is_ok()
}

/// The branch for a new worktree: `wanted` if given, otherwise `marq/<short id>`. The name can be
/// changed later with [`rename_branch`]. `-2`, `-3`… keep it unique.
pub fn branch_name(repo: &Path, wanted: Option<&str>, session_id: &str) -> Result<String> {
    let base = match wanted.map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => check_branch_name(repo, w)?,
        None => format!("marq/{}", &session_id[session_id.len().saturating_sub(8)..]),
    };
    let repo = open(repo)?;
    let mut name = base.clone();
    let mut n = 2;
    while branch_exists(&repo, &name) {
        name = format!("{base}-{n}");
        n += 1;
    }
    Ok(name)
}

/// Where a new worktree's branch starts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Base {
    /// What the project has checked out now.
    #[default]
    Head,
    /// The tip of the repository's default branch (`origin/HEAD`, else `main` or `master`), fetched first.
    Latest,
    /// The tip of this branch, fetched first.
    Branch(String),
}

impl Base {
    /// From the `base:` value of a request note: `head`, `latest`, or a branch name. Empty is `head`.
    pub fn parse(s: Option<&str>) -> Base {
        match s.map(str::trim).unwrap_or("") {
            "" | "head" => Base::Head,
            "latest" => Base::Latest,
            name => Base::Branch(name.to_string()),
        }
    }
}

/// Brings `origin` up to date. False when there is no `origin` or the fetch failed (offline, no access):
/// the local branches are used as they are then. Never prompts for credentials.
pub fn fetch_origin(repo_dir: &Path) -> bool {
    let Ok(repo) = open(repo_dir) else { return false };
    if repo.find_remote("origin").is_err() {
        return false;
    }
    shell::command("git")
        .current_dir(repo_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["fetch", "--quiet", "--prune", "origin"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The repository's default branch: where `origin/HEAD` points, else `main` or `master`.
fn default_branch(repo: &Repository) -> Option<String> {
    if let Ok(r) = repo.find_reference("refs/remotes/origin/HEAD")
        && let Some(t) = r.symbolic_target().ok().flatten().and_then(|t| t.strip_prefix("refs/remotes/origin/"))
    {
        return Some(t.to_string());
    }
    ["main", "master"]
        .into_iter()
        .find(|n| branch_exists(repo, n) || repo.find_branch(&format!("origin/{n}"), BranchType::Remote).is_ok())
        .map(str::to_string)
}

/// The commit a branch is at: `origin/<name>` when there is one (after a fetch it is the newest), else the local branch.
fn branch_tip<'r>(repo: &'r Repository, name: &str) -> Result<git2::Commit<'r>> {
    let found = repo
        .find_branch(&format!("origin/{name}"), BranchType::Remote)
        .or_else(|_| repo.find_branch(name, BranchType::Local))
        .map_err(|_| Error::Other(format!("no branch {name} to start from")))?;
    Ok(found.get().peel_to_commit()?)
}

/// `[worktree] dir` in config.toml (`~` allowed), else `~/.marq/worktrees`.
fn worktrees_root() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    let dir = crate::config::read().ok().and_then(|c| c["worktree"]["dir"].as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty());
    match dir {
        Some(d) if d == "~" => home,
        Some(d) if d.starts_with("~/") => home.join(&d[2..]),
        Some(d) => PathBuf::from(d),
        None => home.join(".marq/worktrees"),
    }
}

/// Creates `<worktrees dir>/<repo>/<short id>`, `~/.marq/worktrees` unless `[worktree] dir` says otherwise, on a new `branch` starting at `base`.
/// With `carry`, the repo's uncommitted changes and untracked files are copied into it as well.
pub fn create(repo_dir: &Path, session_id: &str, branch: &str, carry: bool, base: &Base) -> Result<Worktree> {
    let short = &session_id[session_id.len().saturating_sub(8)..];
    let name = repo_dir.file_name().unwrap_or_default().to_string_lossy();
    let path = worktrees_root().join(&*name).join(short);
    create_at(repo_dir, &path, short, branch, carry, base)
}

/// [`create`] at a given `path`, registered as worktree `name`.
fn create_at(repo_dir: &Path, path: &Path, short: &str, branch: &str, carry: bool, base: &Base) -> Result<Worktree> {
    std::fs::create_dir_all(path.parent().unwrap())?;
    let repo = open(repo_dir)?;
    // The PR goes back to the branch the work started from.
    let (head, base_branch) = match base {
        Base::Head => (repo.head()?.peel_to_commit()?, head_name(&repo).unwrap_or_else(|| "HEAD".into())),
        Base::Latest => {
            let name = default_branch(&repo).ok_or_else(|| Error::Other("no default branch (main or master) to start from".into()))?;
            (branch_tip(&repo, &name)?, name)
        }
        Base::Branch(name) => (branch_tip(&repo, name)?, name.clone()),
    };
    let created = repo.branch(branch, &head, false)?;
    let mut opts = git2::WorktreeAddOptions::new();
    opts.reference(Some(created.get()));
    if let Err(e) = repo.worktree(short, path, Some(&opts)) {
        // Do not leave the branch behind without its worktree.
        let _ = repo.find_branch(branch, BranchType::Local).and_then(|mut b| b.delete());
        return Err(e.into());
    }
    if carry {
        carry_changes(repo_dir, path)?;
    }
    Ok(Worktree {
        repo: repo_dir.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        branch: branch.to_string(),
        base: head.id().to_string(),
        base_branch,
    })
}

/// The worktree with the branch that is checked out in it now. The agent (or the user in a terminal)
/// may have renamed or switched it, so the recorded name cannot be trusted.
pub fn sync_branch(wt: &Worktree) -> Result<Worktree> {
    let dir = Path::new(&wt.path);
    if !dir.exists() {
        return Ok(wt.clone());
    }
    match head_name(&open(dir)?) {
        Some(head) => Ok(Worktree { branch: head, ..wt.clone() }),
        None => Err(Error::Other(format!(
            "the worktree is on a detached HEAD, not on a branch. Check out a branch in {} first",
            wt.path
        ))),
    }
}

/// `<repo>/.git/worktrees/<name>`, from the worktree's `.git` file.
fn git_dir(wt: &Worktree) -> Option<PathBuf> {
    let text = std::fs::read_to_string(Path::new(&wt.path).join(".git")).ok()?;
    let dir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    Some(if dir.is_absolute() { dir } else { Path::new(&wt.path).join(dir) })
}

/// Checked-out branch from the HEAD file, without opening the repository. None when detached or missing.
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

/// Untracked files (not ignored), one entry per file.
fn untracked(repo: &Repository) -> Result<Vec<String>> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts))?;
    Ok(statuses
        .iter()
        .filter(|s| s.status() == Status::WT_NEW)
        .filter_map(|s| s.path().ok().map(str::to_string))
        .collect())
}

fn line_count(path: &Path) -> u32 {
    std::fs::read_to_string(path).map(|t| t.lines().count() as u32).unwrap_or(0)
}

/// The diff from `base` to the working tree (staged and unstaged), with renames detected.
fn diff_against<'r>(repo: &'r Repository, base: &str, opts: &mut DiffOptions) -> Result<Diff<'r>> {
    let tree = repo.revparse_single(base)?.peel_to_tree()?;
    let mut diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(opts))?;
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    Ok(diff)
}

/// `changes` totals (added, deleted).
pub fn diffstat(wt: &Worktree) -> Result<(u32, u32)> {
    let dir = Path::new(&wt.path);
    if !dir.exists() {
        return Ok((0, 0));
    }
    let repo = open(dir)?;
    let stats = diff_against(&repo, &wt.base, &mut DiffOptions::new())?.stats()?;
    let (mut add, del) = (stats.insertions() as u32, stats.deletions() as u32);
    for path in untracked(&repo)? {
        add += line_count(&dir.join(path));
    }
    Ok((add, del))
}

/// Renames the session's branch. Commits and an upstream already pushed under the old name stay
/// as they are; the next push goes to the new name.
pub fn rename_branch(wt: &Worktree, new_name: &str) -> Result<Worktree> {
    let name = check_branch_name(Path::new(&wt.repo), new_name)?;
    if name == wt.branch {
        return Ok(wt.clone());
    }
    // From the worktree itself, so that its HEAD follows the branch to the new name.
    let dir = if Path::new(&wt.path).exists() { &wt.path } else { &wt.repo };
    let repo = open(Path::new(dir))?;
    if branch_exists(&repo, &name) {
        return Err(Error::Other(format!("a branch named {name} already exists")));
    }
    repo.find_branch(&wt.branch, BranchType::Local)?.rename(&name, false)?;
    Ok(Worktree { branch: name, ..wt.clone() })
}

/// Applies `repo`'s uncommitted diff to `dest` and copies its untracked files.
fn carry_changes(repo_dir: &Path, dest: &Path) -> Result<()> {
    let repo = open(repo_dir)?;
    let tree = repo.head()?.peel_to_tree()?;
    let diff = repo.diff_tree_to_workdir_with_index(Some(&tree), Some(DiffOptions::new().show_binary(true)))?;
    let mut patch = vec![];
    diff.print(DiffFormat::Patch, |_, _, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            patch.push(line.origin() as u8);
        }
        patch.extend_from_slice(line.content());
        true
    })?;
    if !patch.is_empty() {
        let to_apply = Diff::from_buffer(&patch)?;
        open(dest)?
            .apply(&to_apply, git2::ApplyLocation::WorkDir, None)
            .map_err(|e| Error::Other(format!("applying uncommitted changes: {}", e.message())))?;
    }
    for file in untracked(&repo)? {
        let to = dest.join(&file);
        std::fs::create_dir_all(to.parent().unwrap())?;
        std::fs::copy(repo_dir.join(&file), to)?;
    }
    Ok(())
}

fn status_letter(d: Delta) -> &'static str {
    match d {
        Delta::Added => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        Delta::Copied => "C",
        Delta::Typechange => "T",
        _ => "M",
    }
}

/// Committed and uncommitted changes since `base`, including untracked files.
pub fn changes(wt: &Worktree) -> Result<Changes> {
    let dir = Path::new(&wt.path);
    if !dir.exists() {
        return Ok(Changes::default());
    }
    let repo = open(dir)?;
    let mut files: Vec<FileChange> = vec![];
    let diff = diff_against(&repo, &wt.base, &mut DiffOptions::new())?;
    for i in 0..diff.deltas().len() {
        let delta = diff.get_delta(i).unwrap();
        let path = delta.new_file().path().or(delta.old_file().path()).unwrap_or(Path::new(""));
        let (additions, deletions) = match git2::Patch::from_diff(&diff, i)? {
            Some(p) => p.line_stats().map(|(_, a, d)| (a as u32, d as u32))?,
            None => (0, 0),
        };
        files.push(FileChange { path: path.to_string_lossy().into_owned(), status: status_letter(delta.status()).into(), additions, deletions });
    }
    for path in untracked(&repo)? {
        let additions = line_count(&dir.join(&path));
        files.push(FileChange { path, status: "?".into(), additions, deletions: 0 });
    }

    let head = repo.head()?.peel_to_commit()?.id();
    let mut commits = vec![];
    if let Ok(base) = repo.revparse_single(&wt.base).and_then(|o| o.peel_to_commit()) {
        let mut walk = repo.revwalk()?;
        walk.set_sorting(git2::Sort::TIME)?;
        walk.push(head)?;
        walk.hide(base.id())?;
        for id in walk {
            commits.push(describe(&repo, id?)?);
        }
    }

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(false);
    let dirty = !repo.statuses(Some(&mut opts))?.is_empty();

    let branch = head_name(&repo);
    let upstream_ref = branch.as_deref().and_then(|b| repo.find_branch(b, BranchType::Local).ok()).and_then(|b| b.upstream().ok());
    let upstream = upstream_ref.as_ref().and_then(|u| u.name().ok().flatten().map(str::to_string));
    let ahead = match upstream_ref.as_ref().and_then(|u| u.get().target()) {
        Some(up) => repo.graph_ahead_behind(head, up)?.0 as u32,
        None => commits.len() as u32,
    };
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

/// A diff as unified-diff text.
fn patch_text(diff: &Diff) -> Result<String> {
    let mut out = vec![];
    diff.print(DiffFormat::Patch, |_, _, line| {
        if matches!(line.origin(), '+' | '-' | ' ') {
            out.push(line.origin() as u8);
        }
        out.extend_from_slice(line.content());
        true
    })?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Unified diff of one file against `base`. Untracked files are shown as all-added.
/// With `ignore_whitespace`, lines that differ only in whitespace are not shown as changed.
pub fn file_diff(wt: &Worktree, file: &str, ignore_whitespace: bool) -> Result<String> {
    let dir = Path::new(&wt.path);
    let repo = open(dir)?;
    let is_untracked = repo.status_file(Path::new(file)).is_ok_and(|s| s == Status::WT_NEW);
    if is_untracked {
        let Ok(content) = std::fs::read(dir.join(file)) else { return Ok(String::new()) };
        let mut patch = git2::Patch::from_buffers(&[], None, &content, Some(Path::new(file)), None)?;
        let text = patch.to_buf()?.as_str().unwrap_or_default().to_string();
        // As `git diff --no-index /dev/null file` prints it: an added file, not a change to an empty one.
        return Ok(match text.find("\n@@") {
            Some(at) => format!("diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}{}", &text[at..]),
            None => text,
        });
    }
    let mut opts = DiffOptions::new();
    // The path is literal: no globbing of `[`, `*` or `?` in file names.
    opts.pathspec(file).disable_pathspec_match(true).ignore_whitespace(ignore_whitespace);
    patch_text(&diff_against(&repo, &wt.base, &mut opts)?)
}

pub fn commit_all(wt: &Worktree, message: &str) -> Result<String> {
    let repo = open(Path::new(&wt.path))?;
    let mut index = repo.index()?;
    // `git add -A`: new and changed files, and removals.
    index.add_all(["*"], IndexAddOption::DEFAULT, None)?;
    index.update_all(["*"], None)?;
    index.write()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    if parent.as_ref().is_some_and(|p| p.tree_id() == tree.id()) {
        return Err(Error::Other("nothing to commit".into()));
    }
    let sig = repo.signature().map_err(|e| {
        Error::Other(format!("git needs user.name and user.email to commit ({})", e.message()))
    })?;
    let message = if message.ends_with('\n') { message.to_string() } else { format!("{message}\n") };
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let id = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;
    describe(&repo, id)
}

/// Pushes `branch` to `origin` and makes `origin/<branch>` its upstream. Returns the upstream name.
///
/// This runs `git push`, so the user's SSH config, agent and credential helpers apply as they do
/// in a terminal. It never prompts: a missing credential fails instead of waiting for input.
fn push_branch(repo: &Repository, branch: &str) -> Result<String> {
    let dir = repo.workdir().unwrap_or_else(|| repo.path());
    let out = shell::command("git")
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .args(["push", "--set-upstream", "origin", &format!("refs/heads/{branch}:refs/heads/{branch}")])
        .output()?;
    if !out.status.success() {
        return Err(Error::Other(format!("git push: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(format!("origin/{branch}"))
}

/// Pushes the session's branch to `origin` and sets it as the upstream. Returns the upstream name.
pub fn push(wt: &Worktree) -> Result<String> {
    push_branch(&open(Path::new(&wt.path))?, &wt.branch)
}

/// Pushes the branch checked out in `dir` (a session without a worktree). Returns the upstream.
pub fn push_dir(dir: &Path) -> Result<String> {
    let repo = open(dir)?;
    let branch = head_name(&repo).ok_or_else(|| Error::Other("detached HEAD: check out a branch to push".into()))?;
    push_branch(&repo, &branch)
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

/// Drops the registration of worktrees whose directory is gone, as `git worktree prune` does.
fn prune(repo: &Repository) -> Result<()> {
    for name in repo.worktrees()?.iter() {
        let Some(name) = name? else { continue };
        let w = repo.find_worktree(name)?;
        if w.validate().is_err() {
            w.prune(None)?;
        }
    }
    Ok(())
}

/// Removes the worktree. The branch is kept so committed work is never lost.
///
/// The directory is first renamed out of the way, which is instant. Deleting it in place takes a
/// while for a large checkout, and anything that diffs it meanwhile sees every file as deleted.
pub fn remove(wt: &Worktree) -> Result<()> {
    let path = Path::new(&wt.path);
    let repo = open(Path::new(&wt.repo))?;
    if path.exists() {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let doomed = path.with_file_name(format!(".{name}.removing-{}", std::process::id()));
        std::fs::rename(path, &doomed)?;
        // The worktree's directory is gone, so prune drops its registration (the branch stays).
        prune(&repo)?;
        std::fs::remove_dir_all(&doomed)?;
    } else {
        prune(&repo)?;
    }
    Ok(())
}

pub fn delete_branch(wt: &Worktree) -> Result<()> {
    open(Path::new(&wt.repo))?.find_branch(&wt.branch, BranchType::Local)?.delete()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Fixtures are set up with the git CLI, which also checks that libgit2 reads what git writes.
    fn sh(dir: &Path, args: &[&str]) {
        assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success());
    }

    fn git(dir: &Path, args: &[&str]) -> Result<String> {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output()?;
        if !out.status.success() {
            return Err(Error::Other(String::from_utf8_lossy(&out.stderr).into_owned()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
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
        assert!(file_diff(&wt, "a.txt", false).unwrap().contains("+three"));
        assert!(file_diff(&wt, "new.txt", false).unwrap().contains("+y"));

        // Re-indenting `one` is a change, unless whitespace is ignored; the real edits stay.
        std::fs::write(wt_path.join("a.txt"), "  one\n2\nthree\n").unwrap();
        assert!(file_diff(&wt, "a.txt", false).unwrap().contains("+  one"));
        let quiet = file_diff(&wt, "a.txt", true).unwrap();
        assert!(!quiet.contains("one") || quiet.contains(" one"), "{quiet}");
        assert!(!quiet.contains("+  one") && quiet.contains("+three"), "{quiet}");
        std::fs::write(wt_path.join("a.txt"), "one\n2\nthree\n").unwrap();

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
        assert!(file_diff(&wt, "日本語.md", false).unwrap().contains("+two"));
        assert!(file_diff(&wt, "未追跡.md", false).unwrap().contains("+x"));
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
        // Renamed outside Marq, e.g. by the agent running git in the worktree.
        git(&wt_path, &["branch", "-m", "marq/by-agent"]).unwrap();
        assert_eq!(sync_branch(&wt).unwrap().branch, "marq/by-agent");
        assert_eq!(head_branch(&wt).as_deref(), Some("marq/by-agent"));
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
        // Windows runners check out with autocrlf, which would turn the patch's lines into CRLF.
        sh(r, &["config", "core.autocrlf", "false"]);
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

    #[test]
    fn commit_edge_cases() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("gone.txt"), "x\n").unwrap();
        std::fs::write(r.join("[a].md"), "one\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);
        let wt = Worktree {
            repo: r.to_string_lossy().into(),
            path: r.to_string_lossy().into(),
            branch: "main".into(),
            base: "HEAD".into(),
            base_branch: "main".into(),
        };
        assert!(commit_all(&wt, "nothing").unwrap_err().to_string().contains("nothing to commit"));

        // Deletions are committed too, and a path with glob characters is taken literally.
        std::fs::remove_file(r.join("gone.txt")).unwrap();
        std::fs::write(r.join("[a].md"), "one\ntwo\n").unwrap();
        std::fs::write(r.join("b.md"), "other\n").unwrap();
        let d = file_diff(&wt, "[a].md", false).unwrap();
        assert!(d.contains("+two") && !d.contains("other"), "{d}");
        let new = file_diff(&wt, "b.md", false).unwrap();
        assert!(new.contains("new file") && new.contains("+other"), "{new}");
        let line = commit_all(&wt, "update").unwrap();
        assert!(line.ends_with(" update"), "{line}");
        assert_eq!(git(r, &["status", "--porcelain"]).unwrap(), "");
        assert!(git(r, &["ls-files"]).unwrap().lines().all(|f| f != "gone.txt"));
        assert_eq!(git(r, &["log", "-1", "--format=%B"]).unwrap().trim_end(), "update");
    }

    #[test]
    fn carries_binary_files_and_deletions() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("img.bin"), [0u8, 1, 2, 255, 0]).unwrap();
        std::fs::write(r.join("old.txt"), "old\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);
        std::fs::write(r.join("img.bin"), [0u8, 9, 9, 9, 255, 0]).unwrap();
        std::fs::remove_file(r.join("old.txt")).unwrap();

        let dest = tempfile::tempdir().unwrap();
        let wt = dest.path().join("wt");
        git(r, &["worktree", "add", "-b", "marq/z", &wt.to_string_lossy(), "HEAD"]).unwrap();
        carry_changes(r, &wt).unwrap();
        assert_eq!(std::fs::read(wt.join("img.bin")).unwrap(), [0u8, 9, 9, 9, 255, 0]);
        assert!(!wt.join("old.txt").exists());
    }

    #[test]
    fn creates_a_worktree_with_the_library() {
        let repo = tempfile::tempdir().unwrap();
        let r = repo.path();
        sh(r, &["init", "-q", "-b", "main"]);
        sh(r, &["config", "user.email", "t@example.com"]);
        sh(r, &["config", "user.name", "t"]);
        std::fs::write(r.join("a.txt"), "x\n").unwrap();
        sh(r, &["add", "."]);
        sh(r, &["commit", "-qm", "init"]);
        let home = tempfile::tempdir().unwrap();
        let wt = create_at(r, &home.path().join("wt"), "abcd1234", "marq/lib", false, &Base::Head).unwrap();
        assert_eq!(wt.base_branch, "main");
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert_eq!(git(Path::new(&wt.path), &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim(), "marq/lib");
        assert!(git(r, &["worktree", "list"]).unwrap().contains("marq/lib"));
        // The branch is taken, so the same name cannot be created again.
        assert!(create_at(r, &home.path().join("wt2"), "efgh5678", "marq/lib", false, &Base::Head).is_err());
        remove(&wt).unwrap();
        assert!(!git(r, &["worktree", "list"]).unwrap().contains("marq/lib"));
    }

    #[test]
    fn starts_from_the_latest_default_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        let clone = tmp.path().join("clone");
        std::fs::create_dir_all(&origin).unwrap();
        sh(&origin, &["init", "-q", "-b", "main"]);
        sh(&origin, &["config", "user.email", "t@example.com"]);
        sh(&origin, &["config", "user.name", "t"]);
        std::fs::write(origin.join("a.txt"), "one\n").unwrap();
        sh(&origin, &["add", "."]);
        sh(&origin, &["commit", "-qm", "one"]);
        sh(tmp.path(), &["clone", "-q", origin.to_str().unwrap(), clone.to_str().unwrap()]);
        // The clone is working on a feature branch, and origin moves on.
        sh(&clone, &["config", "user.email", "t@example.com"]);
        sh(&clone, &["config", "user.name", "t"]);
        sh(&clone, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(origin.join("b.txt"), "two\n").unwrap();
        sh(&origin, &["add", "."]);
        sh(&origin, &["commit", "-qm", "two"]);

        assert!(fetch_origin(&clone));
        let home = tempfile::tempdir().unwrap();
        // HEAD is still the feature branch, without the new commit.
        let head = create_at(&clone, &home.path().join("h"), "aaaa1111", "marq/h", false, &Base::Head).unwrap();
        assert_eq!(head.base_branch, "feature");
        assert!(!Path::new(&head.path).join("b.txt").exists());
        // Latest starts from origin/main and aims the PR at main.
        let latest = create_at(&clone, &home.path().join("l"), "bbbb2222", "marq/l", false, &Base::Latest).unwrap();
        assert_eq!(latest.base_branch, "main");
        assert!(Path::new(&latest.path).join("b.txt").exists());
        // A named branch works too, and an unknown one is an error.
        let named = create_at(&clone, &home.path().join("n"), "cccc3333", "marq/n", false, &Base::Branch("main".into())).unwrap();
        assert!(Path::new(&named.path).join("b.txt").exists());
        assert!(create_at(&clone, &home.path().join("x"), "dddd4444", "marq/x", false, &Base::Branch("nope".into())).is_err());
        assert!(!clone.join("b.txt").exists(), "the project checkout is left alone");
    }

    #[test]
    fn parses_base() {
        assert_eq!(Base::parse(None), Base::Head);
        assert_eq!(Base::parse(Some(" head ")), Base::Head);
        assert_eq!(Base::parse(Some("latest")), Base::Latest);
        assert_eq!(Base::parse(Some("release/1.0")), Base::Branch("release/1.0".into()));
    }
}
