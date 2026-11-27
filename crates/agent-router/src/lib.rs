//! Deterministic, explainable routing policy for locally authenticated CLI agents.
//! It recommends a provider and effort tier; it never probes credentials, invents
//! model identifiers, or launches a process by itself.
use serde::{Deserialize, Serialize};
use shared_protocol::ProviderId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Coding,
    Debugging,
    Testing,
    Research,
    Writing,
    Planning,
    General,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Complexity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QualityTarget {
    Economy,
    Balanced,
    Maximum,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRequest {
    pub prompt: String,
    #[serde(default)]
    pub preferred_provider: Option<ProviderId>,
    #[serde(default)]
    pub quality: Option<QualityTarget>,
    #[serde(default = "default_true")]
    pub allow_antigravity: bool,
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderScore {
    pub provider: ProviderId,
    pub score: u8,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteRecommendation {
    pub task_kind: TaskKind,
    pub complexity: Complexity,
    pub provider: ProviderId,
    /// None means use the CLI's configured default model. The router does not
    /// assume that a model alias exists in the user's local CLI installation.
    pub model: Option<String>,
    pub effort: String,
    pub confidence: f32,
    pub rationale: Vec<String>,
    pub fallback_order: Vec<ProviderId>,
    pub candidates: Vec<ProviderScore>,
    pub execution_requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationStep {
    pub id: String,
    pub role: String,
    pub objective: String,
    pub suggested_provider: ProviderId,
    pub effort: String,
    pub depends_on: Vec<String>,
    pub isolated_workspace: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationBlueprint {
    pub title: String,
    pub steps: Vec<DelegationStep>,
    pub note: String,
}

pub fn recommend(request: &RouteRequest) -> RouteRecommendation {
    let text = request.prompt.to_lowercase();
    let task_kind = classify(&text);
    let complexity = estimate_complexity(&text, request.prompt.len());
    let quality = request.quality.unwrap_or(QualityTarget::Balanced);
    let mut candidates = vec![
        score_provider(ProviderId::ClaudeCode, task_kind, complexity, quality),
        score_provider(ProviderId::Codex, task_kind, complexity, quality),
    ];
    if request.allow_antigravity {
        candidates.push(score_provider(
            ProviderId::Antigravity,
            task_kind,
            complexity,
            quality,
        ));
    }
    if let Some(preferred) = request.preferred_provider {
        if let Some(item) = candidates
            .iter_mut()
            .find(|item| item.provider == preferred)
        {
            item.score = item.score.saturating_add(18).min(100);
            item.reasons
                .push("Preferência explícita do usuário aplicada".into());
        }
    }
    candidates.sort_by_key(|a| std::cmp::Reverse(a.score));
    let chosen = candidates
        .first()
        .expect("Claude and Codex are always candidates");
    let provider = chosen.provider;
    let effort = match (quality, complexity) {
        (QualityTarget::Economy, Complexity::Low | Complexity::Medium) => "low",
        (QualityTarget::Economy, Complexity::High) => "medium",
        (QualityTarget::Maximum, _) => match provider {
            ProviderId::Codex => "xhigh",
            ProviderId::ClaudeCode => "max",
            ProviderId::Antigravity => "high",
        },
        (_, Complexity::High) => "high",
        (_, Complexity::Medium) => "medium",
        (_, Complexity::Low) => "low",
    }
    .to_string();
    let confidence = if candidates.len() > 1 {
        ((chosen.score.saturating_sub(candidates[1].score) as f32 / 100.0) + 0.55).min(0.95)
    } else {
        0.55
    };
    let mut rationale = chosen.reasons.clone();
    rationale.push(format!(
        "Classificação estimada: {:?}, complexidade {:?}.",
        task_kind, complexity
    ));
    rationale.push("Modelo não especificado: será usado o padrão configurado no CLI local.".into());
    let fallback_order = candidates
        .iter()
        .skip(1)
        .map(|item| item.provider)
        .collect();
    RouteRecommendation {
        task_kind,
        complexity,
        provider,
        model: None,
        effort,
        confidence,
        rationale,
        fallback_order,
        candidates,
        execution_requires_confirmation: true,
    }
}

fn effort_for_provider(provider: ProviderId, preferred: &str) -> String {
    match provider {
        ProviderId::ClaudeCode if preferred == "xhigh" => "max".into(),
        ProviderId::Codex if preferred == "max" => "xhigh".into(),
        ProviderId::Antigravity if preferred == "max" || preferred == "xhigh" => "high".into(),
        _ => preferred.into(),
    }
}

pub fn delegation_blueprint(
    prompt: &str,
    recommendation: &RouteRecommendation,
) -> DelegationBlueprint {
    let independent_provider = match recommendation.provider {
        ProviderId::Codex => ProviderId::ClaudeCode,
        _ => ProviderId::Codex,
    };
    let planning_provider = match recommendation.provider {
        ProviderId::Antigravity => ProviderId::ClaudeCode,
        other => other,
    };
    let title = prompt
        .split_whitespace()
        .take(8)
        .collect::<Vec<_>>()
        .join(" ");
    DelegationBlueprint { title: if title.is_empty() { "Nova tarefa".into() } else { title }, steps: vec![
        DelegationStep { id: "plan".into(), role: "Planejamento".into(), objective: "Analisar o objetivo, identificar arquivos relevantes, restrições, riscos e critérios de aceite. Não alterar arquivos.".into(), suggested_provider: planning_provider, effort: effort_for_provider(planning_provider, &recommendation.effort), depends_on: vec![], isolated_workspace: true },
        DelegationStep { id: "implement".into(), role: "Implementação".into(), objective: format!("Executar o objetivo original: {}", prompt.trim()), suggested_provider: recommendation.provider, effort: effort_for_provider(recommendation.provider, &recommendation.effort), depends_on: vec!["plan".into()], isolated_workspace: true },
        DelegationStep { id: "verify".into(), role: "Testes e validação".into(), objective: "Executar ou propor testes relevantes, verificar os critérios de aceite, registrar comandos e resultados. Não declarar testes aprovados sem evidência.".into(), suggested_provider: recommendation.provider, effort: effort_for_provider(recommendation.provider, &recommendation.effort), depends_on: vec!["implement".into()], isolated_workspace: true },
        DelegationStep { id: "review".into(), role: "Revisão independente".into(), objective: "Revisar diff e evidências de teste, procurar regressões, problemas de segurança e critérios não atendidos. Não sobrescrever alterações sem autorização.".into(), suggested_provider: independent_provider, effort: effort_for_provider(independent_provider, &recommendation.effort), depends_on: vec!["verify".into()], isolated_workspace: true },
    ], note: "Plano compilável em DAG. A execução ainda exige confirmação humana; revisão independente não equivale a merge automático.".into() }
}

fn classify(text: &str) -> TaskKind {
    if has_any(
        text,
        &[
            "bug",
            "erro",
            "crash",
            "stack trace",
            "debug",
            "corrigir",
            "falha",
        ],
    ) {
        TaskKind::Debugging
    } else if has_any(
        text,
        &[
            "teste",
            "testes",
            "coverage",
            "unit test",
            "integration test",
        ],
    ) {
        TaskKind::Testing
    } else if has_any(
        text,
        &[
            "pesquise",
            "pesquisa",
            "compare",
            "fontes",
            "referências",
            "investigue",
            "research",
        ],
    ) {
        TaskKind::Research
    } else if has_any(
        text,
        &[
            "documente",
            "escreva",
            "redija",
            "texto",
            "documentação",
            "readme",
        ],
    ) {
        TaskKind::Writing
    } else if has_any(
        text,
        &[
            "planeje",
            "arquitetura",
            "roadmap",
            "estratégia",
            "decomponha",
        ],
    ) {
        TaskKind::Planning
    } else if has_any(
        text,
        &[
            "implemente",
            "implementar",
            "código",
            "code",
            "refatore",
            "crie",
            "desenvolva",
            "feature",
            "api",
            "componente",
        ],
    ) {
        TaskKind::Coding
    } else {
        TaskKind::General
    }
}
fn estimate_complexity(text: &str, length: usize) -> Complexity {
    let indicators = [
        "arquitetura",
        "refatoração",
        "migração",
        "sistema",
        "integração",
        "múltiplos",
        "complexo",
        "segurança",
        "performance",
        "workflow",
    ];
    let count = indicators
        .iter()
        .filter(|word| text.contains(**word))
        .count();
    if count >= 3
        || length > 1800
        || has_any(
            text,
            &["do zero", "ponta a ponta", "end-to-end", "produção"],
        )
    {
        Complexity::High
    } else if count >= 1 || length > 500 {
        Complexity::Medium
    } else {
        Complexity::Low
    }
}
fn score_provider(
    provider: ProviderId,
    kind: TaskKind,
    complexity: Complexity,
    quality: QualityTarget,
) -> ProviderScore {
    let (mut score, reason): (u8, &str) = match (provider, kind) {
        (ProviderId::ClaudeCode, TaskKind::Coding | TaskKind::Writing | TaskKind::Planning) => (
            82,
            "Boa opção heurística para implementação, edição e planejamento",
        ),
        (ProviderId::Codex, TaskKind::Debugging | TaskKind::Testing) => (
            86,
            "Boa opção heurística para diagnóstico e validação técnica",
        ),
        (ProviderId::Antigravity, TaskKind::Research | TaskKind::General) => (
            76,
            "Alternativa disponível para exploração e tarefas gerais via CLI headless",
        ),
        (ProviderId::Codex, TaskKind::Coding) => (
            78,
            "Alternativa forte para implementação com fluxo App Server",
        ),
        (ProviderId::ClaudeCode, TaskKind::Debugging | TaskKind::Testing) => {
            (76, "Alternativa para análise e correção")
        }
        (ProviderId::Antigravity, _) => (
            62,
            "Alternativa headless; sem aprovação interativa centralizada",
        ),
        (_, _) => (68, "Provedor compatível como alternativa geral"),
    };
    if complexity == Complexity::High && provider == ProviderId::Antigravity {
        score = score.saturating_sub(8);
    }
    if quality == QualityTarget::Maximum && provider == ProviderId::Antigravity {
        score = score.saturating_sub(5);
    }
    ProviderScore {
        provider,
        score,
        reasons: vec![reason.into()],
    }
}
fn has_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debugging_prefers_codex_by_default() {
        let result = recommend(&RouteRequest {
            prompt: "Investigue e corrija este crash e stack trace".into(),
            preferred_provider: None,
            quality: None,
            allow_antigravity: true,
        });
        assert_eq!(result.task_kind, TaskKind::Debugging);
        assert_eq!(result.provider, ProviderId::Codex);
    }
    #[test]
    fn explicit_preference_is_respected_without_fabricating_model() {
        let result = recommend(&RouteRequest {
            prompt: "implemente uma API".into(),
            preferred_provider: Some(ProviderId::Codex),
            quality: Some(QualityTarget::Balanced),
            allow_antigravity: false,
        });
        assert_eq!(result.provider, ProviderId::Codex);
        assert!(result.model.is_none());
        assert!(result.execution_requires_confirmation);
    }
    #[test]
    fn blueprint_is_sequential_and_uses_independent_reviewer() {
        let route = recommend(&RouteRequest {
            prompt: "implemente feature".into(),
            preferred_provider: None,
            quality: None,
            allow_antigravity: true,
        });
        let plan = delegation_blueprint("implemente feature", &route);
        assert_eq!(plan.steps.len(), 4);
        assert_eq!(plan.steps[1].depends_on, vec!["plan"]);
        assert_eq!(plan.steps[2].depends_on, vec!["implement"]);
        assert_ne!(plan.steps[3].suggested_provider, route.provider);
        assert!(!plan
            .steps
            .iter()
            .any(|step| step.effort == "max" && step.suggested_provider == ProviderId::Codex));
        assert!(!plan.steps.iter().any(
            |step| step.effort == "xhigh" && step.suggested_provider == ProviderId::ClaudeCode
        ));
    }
    #[test]
    fn economy_reduces_effort_for_simple_task() {
        let result = recommend(&RouteRequest {
            prompt: "resuma este arquivo".into(),
            preferred_provider: None,
            quality: Some(QualityTarget::Economy),
            allow_antigravity: false,
        });
        assert_eq!(result.effort, "low");
    }
}
