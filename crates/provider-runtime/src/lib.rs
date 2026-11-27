//! Shared provider capability catalog and normalized event vocabulary.
//! Capability flags describe implemented integration surfaces, not promises
//! about features exposed by the underlying CLI.
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderId {
    ClaudeCode,
    Codex,
    Antigravity,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProviderCapabilities {
    pub provider: ProviderId,
    pub display_name: &'static str,
    pub launch: bool,
    pub streaming: bool,
    pub persistent_sessions: bool,
    pub native_resume: bool,
    pub interactive_approvals: bool,
    pub remote_resume: bool,
    pub integration_mode: &'static str,
    pub notes: &'static str,
}

pub fn catalog() -> Vec<ProviderCapabilities> {
    vec![
        ProviderCapabilities { provider: ProviderId::ClaudeCode, display_name: "Claude Code", launch: true, streaming: true, persistent_sessions: true, native_resume: true, interactive_approvals: true, remote_resume: true, integration_mode: "stream-json / control protocol", notes: "Retomada nativa, envio de mensagens e interrupção remota disponíveis no Host pareado." },
        ProviderCapabilities { provider: ProviderId::Codex, display_name: "Codex CLI", launch: true, streaming: true, persistent_sessions: true, native_resume: true, interactive_approvals: true, remote_resume: true, integration_mode: "Codex App Server / JSON-RPC", notes: "Retomada de threads, novos turnos e interrupção remota disponíveis no Host pareado." },
        ProviderCapabilities { provider: ProviderId::Antigravity, display_name: "Antigravity", launch: true, streaming: true, persistent_sessions: true, native_resume: true, interactive_approvals: false, remote_resume: true, integration_mode: "CLI headless / conversation ID", notes: "Retomada remota por turno; permissões seguem a configuração do Antigravity." },
    ]
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NormalizedProviderEvent {
    SessionStarted {
        session_id: String,
    },
    TurnStarted {
        session_id: String,
    },
    TextDelta {
        session_id: String,
        text: String,
    },
    ToolApprovalRequired {
        session_id: String,
        request_id: String,
        tool_name: String,
    },
    TurnCompleted {
        session_id: String,
        success: bool,
    },
    SessionDisconnected {
        session_id: String,
        reason: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_exposes_capabilities_without_overstating_agy_approvals() {
        let providers = catalog();
        assert_eq!(providers.len(), 3);
        let agy = providers
            .iter()
            .find(|p| p.provider == ProviderId::Antigravity)
            .unwrap();
        assert!(agy.native_resume && agy.remote_resume);
        assert!(!agy.interactive_approvals);
    }
    #[test]
    fn all_providers_advertise_remote_resume_only_when_host_routes_exist() {
        let providers = catalog();
        assert!(providers
            .iter()
            .all(|provider| provider.native_resume && provider.remote_resume));
        assert!(providers
            .iter()
            .all(|provider| provider.interactive_approvals
                || provider.provider == ProviderId::Antigravity));
    }
    #[test]
    fn normalized_events_are_tagged_and_serializable() {
        let event = NormalizedProviderEvent::TextDelta {
            session_id: "s1".into(),
            text: "hello".into(),
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "text_delta");
    }
}
