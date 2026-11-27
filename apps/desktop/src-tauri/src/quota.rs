//! Reads how much of each AI's usage limit is left, without spending tokens:
//! - Claude: `claude -p /usage` (local command, 0 turns, no saved session)
//! - Codex: `codex app-server` JSON-RPC `account/rateLimits/read`
//! - Antigravity: `agy -p /usage` (tab-separated lines)

use process_manager::build_cli_command;
use serde::Serialize;
use serde_json::{json, Value};
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Serialize, Clone)]
pub struct QuotaWindow {
    /// Friendly name, e.g. "Sessão (5 h)", "Semana", "Gemini · semana".
    pub label: String,
    /// Percent still available (0–100).
    pub remaining_pct: f64,
    /// When it resets, as text from the CLI or an ISO date.
    pub resets: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ProviderQuota {
    pub provider: String,
    pub available: bool,
    pub windows: Vec<QuotaWindow>,
    pub error: Option<String>,
}

const TIMEOUT: Duration = Duration::from_secs(20);

fn tmp() -> std::path::PathBuf { std::env::temp_dir() }

async fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    let mut cmd = build_cli_command(program, &args, &tmp());
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let out = tokio::time::timeout(TIMEOUT, cmd.output()).await
        .map_err(|_| "não respondeu a tempo".to_string())?
        .map_err(|e| format!("não encontrado ({e})"))?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn summarize(provider: &str, windows: Vec<QuotaWindow>, error: Option<String>) -> ProviderQuota {
    let available = error.is_none() && !windows.is_empty() && windows.iter().all(|w| w.remaining_pct > 0.0);
    ProviderQuota { provider: provider.into(), available, windows, error }
}

/// Parses "Current session: 16% used · resets Nov 27, 2:29am (...)".
fn parse_claude(text: &str) -> Vec<QuotaWindow> {
    text.lines().filter_map(|line| {
        let line = line.trim();
        let (label, rest) = if let Some(r) = line.strip_prefix("Current session:") { ("Sessão (5 h)", r) }
            else if let Some(r) = line.strip_prefix("Current week (all models):") { ("Semana", r) }
            else if let Some(r) = line.strip_prefix("Current week") { ("Semana", r.split_once(':').map(|x| x.1).unwrap_or(r)) }
            else { return None };
        let pct: f64 = rest.trim().split('%').next()?.trim().parse().ok()?;
        let resets = rest.split_once("resets").map(|x| x.1.trim().to_string());
        Some(QuotaWindow { label: label.into(), remaining_pct: (100.0 - pct).max(0.0), resets })
    }).collect()
}

async fn claude() -> ProviderQuota {
    match run("claude", &["-p", "/usage", "--output-format", "json", "--no-session-persistence"]).await {
        Ok(out) => {
            let text = serde_json::from_str::<Value>(out.trim()).ok()
                .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(String::from))
                .unwrap_or(out);
            let w = parse_claude(&text);
            let err = w.is_empty().then(|| "não informou o uso (talvez precise fazer login)".to_string());
            summarize("claude_code", w, err)
        }
        Err(e) => summarize("claude_code", vec![], Some(e)),
    }
}

fn window_name(mins: i64) -> String {
    match mins { m if m <= 300 => "Sessão (5 h)".into(), m if m <= 10080 => "Semana".into(), _ => "Mês".into() }
}

async fn codex() -> ProviderQuota {
    let result = async {
        let mut cmd = build_cli_command("codex", &["app-server".to_string()], &tmp());
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| format!("não encontrado ({e})"))?;
        let mut stdin = child.stdin.take().ok_or("sem stdin")?;
        let mut lines = BufReader::new(child.stdout.take().ok_or("sem stdout")?).lines();
        let send = |v: Value| format!("{v}\n");
        stdin.write_all(send(json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"psylium","title":"Psylium","version":env!("CARGO_PKG_VERSION")}}})).as_bytes()).await.map_err(|e| e.to_string())?;
        let mut sent = false;
        let reply = tokio::time::timeout(TIMEOUT, async {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["id"] == 1 && !sent {
                    sent = true;
                    stdin.write_all(send(json!({"method":"initialized"})).as_bytes()).await.ok();
                    stdin.write_all(send(json!({"id":2,"method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}})).as_bytes()).await.ok();
                } else if v["id"] == 2 { return Some(v); }
            }
            None
        }).await.map_err(|_| "não respondeu a tempo".to_string())?;
        let _ = child.kill().await;
        let v = reply.ok_or("sem resposta")?;
        if let Some(err) = v.get("error") { return Err(err["message"].as_str().unwrap_or("erro").to_string()); }
        let limits = &v["result"]["rateLimits"];
        let mut windows = Vec::new();
        for key in ["primary", "secondary"] {
            let w = &limits[key];
            if let Some(used) = w["usedPercent"].as_f64() {
                let resets = w["resetsAt"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|d| d.to_rfc3339());
                windows.push(QuotaWindow { label: window_name(w["windowDurationMins"].as_i64().unwrap_or(0)), remaining_pct: (100.0 - used).max(0.0), resets });
            }
        }
        Ok::<_, String>(windows)
    }.await;
    match result {
        Ok(w) => { let err = w.is_empty().then(|| "não informou o uso".to_string()); summarize("codex", w, err) }
        Err(e) => summarize("codex", vec![], Some(e)),
    }
}

/// Parses lines like "Gemini Models\tWeekly Limit Remaining\t0%\t2026-12-03T10:28:05Z".
fn parse_agy(text: &str) -> Vec<QuotaWindow> {
    text.lines().filter_map(|line| {
        let cols: Vec<&str> = line.split('\t').map(str::trim).collect();
        if cols.len() < 3 { return None; }
        let pct: f64 = cols[2].trim_end_matches('%').parse().ok()?;
        let family = cols[0].replace(" Models", "").replace(" models", "");
        let window = if cols[1].to_lowercase().contains("five") { "5 h" } else if cols[1].to_lowercase().contains("week") { "semana" } else { cols[1] };
        Some(QuotaWindow { label: format!("{family} · {window}"), remaining_pct: pct, resets: cols.get(3).map(|s| s.to_string()) })
    }).collect()
}

async fn agy() -> ProviderQuota {
    match run("agy", &["-p", "/usage"]).await {
        Ok(out) => {
            let w = parse_agy(&out);
            let err = w.is_empty().then(|| "não informou o uso".to_string());
            // Antigravity's default model is Gemini, so it is only usable without
            // picking a model while the Gemini family has room.
            let gemini: Vec<&QuotaWindow> = w.iter().filter(|x| x.label.starts_with("Gemini ·")).collect();
            let available = err.is_none() && if gemini.is_empty() { w.iter().any(|x| x.remaining_pct > 0.0) } else { gemini.iter().all(|x| x.remaining_pct > 0.0) };
            ProviderQuota { provider: "antigravity".into(), available, windows: w, error: err }
        }
        Err(e) => summarize("antigravity", vec![], Some(e)),
    }
}

#[tauri::command]
pub async fn read_quotas() -> Vec<ProviderQuota> {
    let (a, b, c) = tokio::join!(claude(), codex(), agy());
    vec![a, b, c]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn claude_text() {
        let w = parse_claude("Current session: 16% used · resets Nov 27, 2:29am (America/Sao_Paulo)\nCurrent week (all models): 2% used · resets Dec 3");
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].remaining_pct, 84.0);
        assert_eq!(w[1].label, "Semana");
    }
    #[test]
    fn agy_lines() {
        let w = parse_agy("Gemini Models\tWeekly Limit Remaining\t0%\t2026-12-03T10:28:05Z\nClaude and GPT models\tFive Hour Limit Remaining\t25%\t2026-11-27T04:17:37Z");
        assert_eq!(w[0].remaining_pct, 0.0);
        assert_eq!(w[1].label, "Claude and GPT · 5 h");
    }
}

#[cfg(test)]
mod live {
    #[tokio::test]
    #[ignore = "calls the real CLIs"]
    async fn read_all() {
        for q in super::read_quotas().await { println!("{}", serde_json::to_string(&q).unwrap()); }
    }
}
