use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use shared_protocol::{OutputStream, ProviderId, TaskEvent, TaskEventPayload, TaskSnapshot};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

impl TokenTotals {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_read_tokens)
            .saturating_add(self.cache_creation_tokens)
    }

    fn add_assign(&mut self, other: TokenTotals) {
        self.input_tokens = self.input_tokens.saturating_add(other.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(other.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(other.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(other.cache_creation_tokens);
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuotaStatus {
    Normal,
    RateLimited,
    QuotaExceeded,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderUsage {
    pub provider: ProviderId,
    /// Usage reconstructed from provider-owned local transcripts.
    pub historical: TokenTotals,
    /// Usage observed from live process streams. Kept separate to avoid double counting
    /// when the same run is later persisted by the provider CLI.
    pub live: TokenTotals,
    pub sessions_scanned: u64,
    pub execution_seconds: u64,
    pub quota_status: QuotaStatus,
    pub historical_available: bool,
    pub live_available: bool,
    pub official_quota_available: bool,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageSnapshot {
    pub generated_at: DateTime<Utc>,
    pub providers: Vec<ProviderUsage>,
}

#[derive(Debug, Clone, Default)]
struct LiveTaskUsage {
    provider: Option<ProviderId>,
    totals: TokenTotals,
    claude_message_usage: HashMap<String, TokenTotals>,
    has_usage: bool,
}

type HistoricalCache =
    Arc<tokio::sync::RwLock<Option<(Instant, HashMap<ProviderId, HistoricalProviderUsage>)>>>;

#[derive(Clone, Default)]
pub struct UsageMonitor {
    live_tasks: Arc<Mutex<HashMap<Uuid, LiveTaskUsage>>>,
    quota_by_provider: Arc<Mutex<HashMap<ProviderId, QuotaStatus>>>,
    historical_cache: HistoricalCache,
}

#[derive(Debug, Clone, Default)]
struct HistoricalProviderUsage {
    totals: TokenTotals,
    sessions_scanned: u64,
    available: bool,
}

impl UsageMonitor {
    pub async fn observe_event(&self, event: &TaskEvent, provider: Option<ProviderId>) {
        let mut live_tasks = self.live_tasks.lock().await;
        let task = live_tasks.entry(event.task_id).or_default();
        if provider.is_some() {
            task.provider = provider;
        }

        if let Some(provider) = task.provider {
            if let TaskEventPayload::Output { stream, line } = &event.payload {
                let lower = line.to_ascii_lowercase();
                let status = classify_quota_text(&lower);
                if status != QuotaStatus::Normal {
                    self.quota_by_provider.lock().await.insert(provider, status);
                }
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    apply_live_usage(provider, &value, task);
                } else if matches!(stream, OutputStream::Stderr) && lower.contains("rate limit") {
                    self.quota_by_provider
                        .lock()
                        .await
                        .insert(provider, QuotaStatus::RateLimited);
                }
            }
        }
    }

    pub async fn snapshot(&self, tasks: &[TaskSnapshot]) -> UsageSnapshot {
        let cached = {
            let cache = self.historical_cache.read().await;
            cache
                .as_ref()
                .filter(|(at, _)| at.elapsed() < std::time::Duration::from_secs(60))
                .map(|(_, data)| data.clone())
        };
        let scanned = if let Some(cached) = cached {
            cached
        } else {
            let home = home_dir();
            let fresh = tokio::task::spawn_blocking(move || scan_historical_usage(&home))
                .await
                .unwrap_or_default();
            *self.historical_cache.write().await = Some((Instant::now(), fresh.clone()));
            fresh
        };
        let live_tasks = {
            let mut live_tasks = self.live_tasks.lock().await;
            // Match the process manager's bounded task retention so telemetry
            // from completed tasks cannot grow for the entire app lifetime.
            let retained: std::collections::HashSet<Uuid> =
                tasks.iter().map(|task| task.task_id).collect();
            live_tasks.retain(|task_id, _| retained.contains(task_id));
            live_tasks.clone()
        };
        let quota_by_provider = self.quota_by_provider.lock().await.clone();

        let providers = [ProviderId::ClaudeCode, ProviderId::Codex, ProviderId::Antigravity]
            .into_iter()
            .map(|provider| {
                let historical_data = scanned.get(&provider).cloned().unwrap_or_default();
                let historical = historical_data.totals;
                let mut live = TokenTotals::default();
                let mut live_available = false;
                for task in live_tasks.values().filter(|task| task.provider == Some(provider)) {
                    live.add_assign(task.totals);
                    live_available |= task.has_usage;
                }

                let mut execution_seconds = 0u64;
                for task in tasks.iter().filter(|task| task.provider == Some(provider)) {
                    if let Some(started) = task.started_at {
                        let end = task.finished_at.unwrap_or_else(Utc::now);
                        execution_seconds = execution_seconds.saturating_add(
                            (end - started).num_seconds().max(0) as u64,
                        );
                    }
                }

                let (sessions_scanned, historical_available, mut notes) = match provider {
                    ProviderId::ClaudeCode => (historical_data.sessions_scanned, historical_data.available, vec!["Tokens calculados a partir dos registros JSONL locais do Claude Code.".to_string()]),
                    ProviderId::Codex => (historical_data.sessions_scanned, historical_data.available, vec!["Tokens calculados a partir dos eventos token_count dos registros locais do Codex.".to_string()]),
                    ProviderId::Antigravity => (0, false, vec!["Formato de histórico local do Antigravity ainda não foi verificado; métricas dependem dos eventos emitidos pelo CLI durante a execução.".to_string()]),
                };
                if provider == ProviderId::Antigravity && !live_available {
                    notes.push("Nenhuma métrica de tokens foi exposta pelo stream nesta sessão.".into());
                }
                if quota_by_provider.get(&provider).copied().unwrap_or(QuotaStatus::Unknown) != QuotaStatus::Unknown {
                    notes.push("Indicador baseado na última mensagem de limite detectada nesta execução do Host; não representa uma consulta oficial da cota atual.".into());
                }

                ProviderUsage {
                    provider,
                    historical,
                    live,
                    sessions_scanned,
                    execution_seconds,
                    quota_status: quota_by_provider.get(&provider).copied().unwrap_or(QuotaStatus::Unknown),
                    historical_available,
                    live_available,
                    // CLIs locais não expõem uma cota oficial unificada de assinatura por este mecanismo.
                    official_quota_available: false,
                    notes,
                }
            })
            .collect();

        UsageSnapshot {
            generated_at: Utc::now(),
            providers,
        }
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn classify_quota_text(text: &str) -> QuotaStatus {
    if [
        "quota exceeded",
        "usage limit reached",
        "billing limit",
        "monthly limit",
        "out of credits",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        QuotaStatus::QuotaExceeded
    } else if [
        "rate limit",
        "rate_limit",
        "too many requests",
        "429",
        "try again later",
    ]
    .iter()
    .any(|needle| text.contains(needle))
    {
        QuotaStatus::RateLimited
    } else {
        QuotaStatus::Normal
    }
}

fn value_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn totals_from_usage(usage: &Value) -> TokenTotals {
    TokenTotals {
        input_tokens: value_u64(
            usage
                .get("input_tokens")
                .or_else(|| usage.get("inputTokens")),
        ),
        output_tokens: value_u64(
            usage
                .get("output_tokens")
                .or_else(|| usage.get("outputTokens")),
        ),
        cache_read_tokens: value_u64(
            usage
                .get("cache_read_input_tokens")
                .or_else(|| usage.get("cacheReadInputTokens"))
                .or_else(|| usage.get("cacheReadTokens")),
        ),
        cache_creation_tokens: value_u64(
            usage
                .get("cache_creation_input_tokens")
                .or_else(|| usage.get("cacheCreationInputTokens"))
                .or_else(|| usage.get("cacheCreationTokens")),
        ),
    }
}

fn apply_live_usage(provider: ProviderId, value: &Value, task: &mut LiveTaskUsage) {
    match provider {
        ProviderId::ClaudeCode => {
            let message = value.get("message");
            let usage = message
                .and_then(|message| message.get("usage"))
                .or_else(|| {
                    if value.get("type").and_then(Value::as_str) == Some("assistant") {
                        value.get("usage")
                    } else {
                        None
                    }
                });
            if let Some(usage) = usage {
                let message_id = message
                    .and_then(|message| message.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let row_totals = totals_from_usage(usage);
                if let Some(id) = message_id {
                    task.claude_message_usage.insert(id, row_totals);
                    task.totals = task.claude_message_usage.values().fold(
                        TokenTotals::default(),
                        |mut total, value| {
                            total.add_assign(*value);
                            total
                        },
                    );
                } else {
                    // The CLI normally supplies message.id. If it does not, retain
                    // this row as an independent observation rather than dropping it.
                    task.totals.add_assign(row_totals);
                }
                task.has_usage = true;
            }
        }
        ProviderId::Codex => {
            let info = value
                .pointer("/payload/info")
                .or_else(|| value.pointer("/data/info"));
            if let Some(info) = info {
                if let Some(total) = info.get("total_token_usage") {
                    task.totals = totals_from_usage(total);
                    task.has_usage = true;
                }
            }
        }
        ProviderId::Antigravity => {
            let usage = value
                .get("usage")
                .or_else(|| value.pointer("/data/usage"))
                .or_else(|| value.pointer("/result/usage"));
            if let Some(usage) = usage {
                // Antigravity's event semantics may be cumulative or per-message;
                // keep the last reported snapshot rather than inventing a sum.
                task.totals = totals_from_usage(usage);
                task.has_usage = true;
            }
        }
    }
}

fn scan_historical_usage(home: &Path) -> HashMap<ProviderId, HistoricalProviderUsage> {
    // Respect the same provider-home overrides consumed by the CLIs. Relative
    // overrides are ignored to avoid reading an accidental working-directory path.
    let claude_home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".claude"));
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".codex"));
    let claude_root = claude_home.join("projects");
    let codex_root = codex_home.join("sessions");
    let claude_files = collect_jsonl_files(&claude_root);
    let codex_files = collect_jsonl_files(&codex_root);
    let mut result = HashMap::new();
    result.insert(
        ProviderId::ClaudeCode,
        HistoricalProviderUsage {
            totals: scan_claude_files(&claude_files),
            sessions_scanned: claude_files.len() as u64,
            available: claude_root.is_dir(),
        },
    );
    result.insert(
        ProviderId::Codex,
        HistoricalProviderUsage {
            totals: scan_codex_files(&codex_files),
            sessions_scanned: codex_files.len() as u64,
            available: codex_root.is_dir(),
        },
    );
    result
}

fn collect_jsonl_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    walk_jsonl(root, &mut files, 0);
    files
}

fn walk_jsonl(root: &Path, output: &mut Vec<PathBuf>, depth: usize) {
    if depth > 12 {
        return;
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if ["subagents", "tool-results", ".git", "node_modules"].contains(&name.as_str()) {
                continue;
            }
            walk_jsonl(&path, output, depth + 1);
        } else if file_type.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("jsonl"))
        {
            output.push(path);
        }
    }
}

fn scan_claude_files(files: &[PathBuf]) -> TokenTotals {
    let mut aggregate = TokenTotals::default();
    for path in files {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);
        let mut messages = HashMap::<String, TokenTotals>::new();
        for (index, line) in reader.lines().enumerate() {
            let Ok(line) = line else { continue };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            if value.get("type").and_then(Value::as_str) != Some("assistant") {
                continue;
            }
            let Some(message) = value.get("message") else {
                continue;
            };
            let Some(usage) = message.get("usage") else {
                continue;
            };
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("line-{index}"));
            // Claude may rewrite the same message row as it streams. Keep its
            // latest usage snapshot instead of counting every partial update.
            messages.insert(id, totals_from_usage(usage));
        }
        for totals in messages.values() {
            aggregate.add_assign(*totals);
        }
    }
    aggregate
}

fn scan_codex_files(files: &[PathBuf]) -> TokenTotals {
    let mut aggregate = TokenTotals::default();
    for path in files {
        let file = match File::open(path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);
        let mut latest: Option<TokenTotals> = None;
        for line in reader.lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) == Some("event_msg")
                && value.pointer("/payload/type").and_then(Value::as_str) == Some("token_count")
            {
                if let Some(total) = value.pointer("/payload/info/total_token_usage") {
                    latest = Some(totals_from_usage(total));
                }
            }
        }
        if let Some(latest) = latest {
            aggregate.add_assign(latest);
        }
    }
    aggregate
}

#[cfg(test)]
mod tests {
    use super::*;
    use shared_protocol::TaskEventPayload;

    #[tokio::test]
    async fn detects_quota_text_from_stderr() {
        let monitor = UsageMonitor::default();
        let event = TaskEvent {
            task_id: Uuid::new_v4(),
            sequence: 1,
            emitted_at: Utc::now(),
            payload: TaskEventPayload::Output {
                stream: OutputStream::Stderr,
                line: "HTTP 429 rate limit exceeded".into(),
            },
        };
        monitor.observe_event(&event, Some(ProviderId::Codex)).await;
        let live = monitor.quota_by_provider.lock().await;
        assert_eq!(
            live.get(&ProviderId::Codex),
            Some(&QuotaStatus::RateLimited)
        );
    }

    #[test]
    fn live_claude_replaces_partial_message_snapshots() {
        let mut task = LiveTaskUsage {
            provider: Some(ProviderId::ClaudeCode),
            ..Default::default()
        };
        let first: Value = serde_json::from_str(r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":2,"output_tokens":1}}}"#).unwrap();
        let final_row: Value = serde_json::from_str(r#"{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":20,"output_tokens":6}}}"#).unwrap();
        apply_live_usage(ProviderId::ClaudeCode, &first, &mut task);
        apply_live_usage(ProviderId::ClaudeCode, &final_row, &mut task);
        assert_eq!(task.totals.input_tokens, 20);
        assert_eq!(task.totals.output_tokens, 6);
    }

    #[test]
    fn reads_codex_token_usage_shape() {
        let value: Value = serde_json::from_str(r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":3}}}}"#).unwrap();
        let mut task = LiveTaskUsage {
            provider: Some(ProviderId::Codex),
            ..Default::default()
        };
        apply_live_usage(ProviderId::Codex, &value, &mut task);
        assert_eq!(task.totals.input_tokens, 10);
        assert_eq!(task.totals.output_tokens, 3);
    }

    #[test]
    fn claude_transcript_keeps_latest_partial_message_row() {
        let path = std::env::temp_dir().join(format!("claude-usage-{}.jsonl", Uuid::new_v4()));
        let first = r#"{"type":"assistant","message":{"id":"message-1","usage":{"input_tokens":2,"output_tokens":1}}}"#;
        let final_row = r#"{"type":"assistant","message":{"id":"message-1","usage":{"input_tokens":21,"output_tokens":8,"cache_read_input_tokens":5}}}"#;
        std::fs::write(&path, format!("{first}\n{final_row}\n")).unwrap();
        let totals = scan_claude_files(std::slice::from_ref(&path));
        let _ = std::fs::remove_file(path);
        assert_eq!(totals.input_tokens, 21);
        assert_eq!(totals.output_tokens, 8);
        assert_eq!(totals.cache_read_tokens, 5);
        assert_eq!(totals.total_tokens(), 34);
    }
}
