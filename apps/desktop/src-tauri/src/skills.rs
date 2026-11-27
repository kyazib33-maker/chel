//! Skill library: collects the skills of every AI installed on this computer
//! into one Psylium library (~/.psylium/skills) and shares that library back
//! with each AI, so whichever AI the chat picks can use any skill.
//!
//! A skill is a folder containing a `SKILL.md`. Existing skills in an AI's
//! own folder are never overwritten; only missing ones are added.

use serde::Serialize;
use std::{fs, io, path::{Path, PathBuf}};

#[derive(Serialize, Clone)]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// Which AIs this skill was found in ("Claude", "Codex", "Antigravity", "Compartilhada").
    pub sources: Vec<String>,
    pub in_library: bool,
}

#[derive(Serialize)]
pub struct ImportReport {
    pub imported: usize,
    pub shared: usize,
    pub library_path: String,
    pub skills: Vec<SkillInfo>,
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

fn library() -> PathBuf { home().join(".psylium").join("skills") }

/// Folders where each AI keeps skills, with a friendly label.
fn sources() -> Vec<(&'static str, PathBuf)> {
    let h = home();
    vec![
        ("Claude", h.join(".claude").join("skills")),
        ("Codex", h.join(".codex").join("skills")),
        ("Compartilhada", h.join(".agents").join("skills")),
        ("Antigravity", h.join(".gemini").join("antigravity-cli").join("builtin").join("skills")),
    ]
}

/// Folders Psylium shares its library into. `~/.agents/skills` is the shared
/// location read by Codex and other agent CLIs; Claude reads `~/.claude/skills`.
fn targets() -> Vec<PathBuf> {
    let h = home();
    vec![h.join(".claude").join("skills"), h.join(".agents").join("skills")]
}

fn skill_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.join("SKILL.md").is_file()).collect();
    dirs.sort();
    dirs
}

fn description(dir: &Path) -> String {
    let text = fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
    text.lines()
        .find_map(|l| l.trim().strip_prefix("description:").map(|d| d.trim().trim_matches('"').to_string()))
        .unwrap_or_default()
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_dir() { copy_dir(&entry.path(), &dest)?; }
        else if kind.is_file() { fs::copy(entry.path(), dest)?; }
        // symlinks are skipped on purpose
    }
    Ok(())
}

fn name_of(dir: &Path) -> String { dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }

pub fn scan() -> Vec<SkillInfo> {
    let mut found: Vec<SkillInfo> = Vec::new();
    let lib = library();
    let mut add = |label: &str, dir: &Path| {
        let name = name_of(dir);
        if let Some(existing) = found.iter_mut().find(|s| s.name == name) {
            if !existing.sources.iter().any(|s| s == label) { existing.sources.push(label.to_string()); }
        } else {
            found.push(SkillInfo { name: name.clone(), description: description(dir), sources: vec![label.to_string()], in_library: lib.join(&name).join("SKILL.md").is_file() });
        }
    };
    for (label, root) in sources() { for dir in skill_dirs(&root) { add(label, &dir); } }
    for dir in skill_dirs(&lib) { add("Psylium", &dir); }
    found.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    found
}

pub fn import_all() -> Result<ImportReport, String> {
    let lib = library();
    fs::create_dir_all(&lib).map_err(|e| e.to_string())?;
    let mut imported = 0;
    for (_, root) in sources() {
        for dir in skill_dirs(&root) {
            let dest = lib.join(name_of(&dir));
            if dest.exists() { continue; }
            copy_dir(&dir, &dest).map_err(|e| format!("{}: {e}", dir.display()))?;
            imported += 1;
        }
    }
    // Antigravity's built-in skills describe Antigravity itself; keep them in
    // the library but don't push them into the other AIs.
    let builtin = home().join(".gemini").join("antigravity-cli").join("builtin").join("skills");
    let mut shared = 0;
    for target in targets() {
        fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        for dir in skill_dirs(&lib) {
            let dest = target.join(name_of(&dir));
            if dest.exists() || builtin.join(name_of(&dir)).exists() { continue; }
            copy_dir(&dir, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
            shared += 1;
        }
    }
    Ok(ImportReport { imported, shared, library_path: lib.display().to_string(), skills: scan() })
}

#[tauri::command]
pub fn list_skills() -> Vec<SkillInfo> { scan() }

#[tauri::command]
pub fn import_skills() -> Result<ImportReport, String> { import_all() }
