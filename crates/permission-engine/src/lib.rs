use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::Duration as StdDuration};
use thiserror::Error;
use tokio::sync::Mutex;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    Read,
    Write,
    Execute,
    Network,
    Destructive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyMode {
    ReadOnly,
    AskForSensitive,
    AllowAll,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    Allow,
    Deny,
    RequireApproval,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: Uuid,
    pub task_id: Uuid,
    pub provider: String,
    pub tool_name: String,
    pub action: ActionClass,
    pub summary: String,
    pub input_preview: String,
    pub status: ApprovalStatus,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub decided_at: Option<DateTime<Utc>>,
    pub decided_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyEvaluation {
    pub decision: PermissionDecision,
    pub reason: String,
}

#[derive(Debug, Error)]
pub enum PermissionError {
    #[error("solicitação de permissão não encontrada")]
    NotFound,
    #[error("solicitação já foi decidida ou expirou")]
    NotPending,
    #[error("a política atual não exige aprovação para esta ação")]
    ApprovalNotRequired,
    #[error("identidade do decisor inválida")]
    InvalidActor,
    #[error("fila de aprovações cheia; decisões pendentes não serão descartadas")]
    QueueFull,
}

#[derive(Clone)]
pub struct PermissionEngine {
    mode: PolicyMode,
    ttl: StdDuration,
    requests: Arc<Mutex<HashMap<Uuid, PermissionRequest>>>,
}

impl Default for PermissionEngine {
    fn default() -> Self {
        Self::new(PolicyMode::AskForSensitive, StdDuration::from_secs(300))
    }
}

impl PermissionEngine {
    pub fn new(mode: PolicyMode, ttl: StdDuration) -> Self {
        Self {
            mode,
            ttl: ttl.max(StdDuration::from_secs(10)),
            requests: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn mode(&self) -> PolicyMode {
        self.mode
    }

    pub fn evaluate(&self, action: ActionClass) -> PolicyEvaluation {
        let decision = match self.mode {
            PolicyMode::AllowAll => PermissionDecision::Allow,
            PolicyMode::ReadOnly if action == ActionClass::Read => PermissionDecision::Allow,
            PolicyMode::ReadOnly => PermissionDecision::Deny,
            PolicyMode::AskForSensitive if action == ActionClass::Read => PermissionDecision::Allow,
            PolicyMode::AskForSensitive => PermissionDecision::RequireApproval,
        };
        let reason = match decision {
            PermissionDecision::Allow => "ação permitida pela política atual".into(),
            PermissionDecision::Deny => "ação bloqueada pela política somente leitura".into(),
            PermissionDecision::RequireApproval => "ação sensível exige aprovação explícita".into(),
        };
        PolicyEvaluation { decision, reason }
    }

    /// Called by a provider adapter when it receives a real tool-permission request.
    pub async fn submit(
        &self,
        task_id: Uuid,
        provider: impl Into<String>,
        tool_name: impl Into<String>,
        action: ActionClass,
        summary: impl Into<String>,
        input_preview: impl Into<String>,
    ) -> Result<PermissionRequest, PermissionError> {
        let evaluation = self.evaluate(action);
        if evaluation.decision != PermissionDecision::RequireApproval {
            return Err(PermissionError::ApprovalNotRequired);
        }
        let now = Utc::now();
        let ttl = Duration::from_std(self.ttl).unwrap_or_else(|_| Duration::minutes(5));
        let mut requests = self.requests.lock().await;
        expire_pending(&mut requests);
        if requests.len() >= 500 {
            let oldest_terminal = requests
                .values()
                .filter(|item| item.status != ApprovalStatus::Pending)
                .min_by_key(|item| item.created_at)
                .map(|item| item.id);
            if let Some(id) = oldest_terminal {
                requests.remove(&id);
            } else {
                return Err(PermissionError::QueueFull);
            }
        }
        let request = PermissionRequest {
            id: Uuid::new_v4(),
            task_id,
            provider: truncate(provider.into(), 40),
            tool_name: truncate(tool_name.into(), 100),
            action,
            summary: truncate(summary.into(), 500),
            input_preview: truncate(input_preview.into(), 8_000),
            status: ApprovalStatus::Pending,
            created_at: now,
            expires_at: now + ttl,
            decided_at: None,
            decided_by: None,
        };
        requests.insert(request.id, request.clone());
        Ok(request)
    }

    pub async fn list(&self) -> Vec<PermissionRequest> {
        let mut requests = self.requests.lock().await;
        expire_pending(&mut requests);
        let mut result: Vec<_> = requests.values().cloned().collect();
        result.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        result
    }

    pub async fn decide(
        &self,
        id: Uuid,
        approve: bool,
        actor: String,
    ) -> Result<PermissionRequest, PermissionError> {
        if actor.trim().is_empty() {
            return Err(PermissionError::InvalidActor);
        }
        let mut requests = self.requests.lock().await;
        expire_pending(&mut requests);
        let request = requests.get_mut(&id).ok_or(PermissionError::NotFound)?;
        if request.status != ApprovalStatus::Pending {
            return Err(PermissionError::NotPending);
        }
        request.status = if approve {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Denied
        };
        request.decided_at = Some(Utc::now());
        request.decided_by = Some(actor);
        Ok(request.clone())
    }

    /// Marks a native request as expired when its provider clears it externally.
    pub async fn expire(
        &self,
        id: Uuid,
        actor: String,
    ) -> Result<PermissionRequest, PermissionError> {
        if actor.trim().is_empty() {
            return Err(PermissionError::InvalidActor);
        }
        let mut requests = self.requests.lock().await;
        expire_pending(&mut requests);
        let request = requests.get_mut(&id).ok_or(PermissionError::NotFound)?;
        if request.status != ApprovalStatus::Pending {
            return Err(PermissionError::NotPending);
        }
        request.status = ApprovalStatus::Expired;
        request.decided_at = Some(Utc::now());
        request.decided_by = Some(actor);
        Ok(request.clone())
    }
}

fn truncate(value: String, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn expire_pending(requests: &mut HashMap<Uuid, PermissionRequest>) {
    let now = Utc::now();
    for request in requests.values_mut() {
        if request.status == ApprovalStatus::Pending && request.expires_at <= now {
            request.status = ApprovalStatus::Expired;
            request.decided_at = Some(now);
            request.decided_by = Some("system:expiry".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_policy_blocks_everything_except_reads() {
        let engine = PermissionEngine::new(PolicyMode::ReadOnly, StdDuration::from_secs(60));
        assert_eq!(
            engine.evaluate(ActionClass::Read).decision,
            PermissionDecision::Allow
        );
        assert_eq!(
            engine.evaluate(ActionClass::Write).decision,
            PermissionDecision::Deny
        );
        assert_eq!(
            engine.evaluate(ActionClass::Execute).decision,
            PermissionDecision::Deny
        );
    }

    #[tokio::test]
    async fn external_provider_clear_marks_request_expired() {
        let engine = PermissionEngine::default();
        let request = engine
            .submit(
                Uuid::new_v4(),
                "codex",
                "fileChange",
                ActionClass::Write,
                "Aplicar diff",
                "{}",
            )
            .await
            .unwrap();
        let expired = engine
            .expire(request.id, "codex:request-cleared".into())
            .await
            .unwrap();
        assert_eq!(expired.status, ApprovalStatus::Expired);
        assert!(matches!(
            engine.decide(request.id, true, "mobile:phone".into()).await,
            Err(PermissionError::NotPending)
        ));
    }

    #[tokio::test]
    async fn sensitive_action_requires_explicit_decision_and_cannot_be_replayed() {
        let engine = PermissionEngine::default();
        let request = engine
            .submit(
                Uuid::new_v4(),
                "codex",
                "shell",
                ActionClass::Execute,
                "Executar comando",
                "cargo test",
            )
            .await
            .unwrap();
        assert_eq!(request.status, ApprovalStatus::Pending);
        let decided = engine
            .decide(request.id, true, "mobile:device-1".into())
            .await
            .unwrap();
        assert_eq!(decided.status, ApprovalStatus::Approved);
        assert!(matches!(
            engine
                .decide(request.id, false, "mobile:device-1".into())
                .await,
            Err(PermissionError::NotPending)
        ));
    }
}
