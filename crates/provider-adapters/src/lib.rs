use shared_protocol::{AgentLaunchRequest, ProcessSpec, ProviderId};
use std::collections::BTreeMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("prompt vazio")]
    EmptyPrompt,
    #[error("effort inválido para {provider:?}: {effort}")]
    InvalidEffort {
        provider: ProviderId,
        effort: String,
    },
}

/// Creates a provider-specific argv without invoking a shell.
/// Provider flags are deliberately isolated here: CLI changes should not leak
/// into the process manager or UI.
pub fn build_process_spec(request: AgentLaunchRequest) -> Result<ProcessSpec, AdapterError> {
    if request.prompt.trim().is_empty() {
        return Err(AdapterError::EmptyPrompt);
    }

    let mut args = Vec::new();
    let program = match request.provider {
        ProviderId::ClaudeCode => {
            args.extend([
                "-p".to_string(),
                request.prompt,
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--include-partial-messages".to_string(),
            ]);
            if let Some(id) = request.resume_id.as_ref() {
                args.extend(["--resume".into(), id.clone()]);
            }
            if let Some(model) = request.model.as_ref() {
                args.extend(["--model".into(), model.clone()]);
            }
            if let Some(effort) = request.effort.as_ref() {
                validate_effort(request.provider, effort)?;
                args.extend(["--effort".into(), effort.to_ascii_lowercase()]);
            }
            "claude"
        }
        ProviderId::Codex => {
            args.extend(["exec".into(), "--json".into(), "--skip-git-repo-check".into()]);
            if let Some(model) = request.model.as_ref() {
                args.extend(["--model".into(), model.clone()]);
            }
            if let Some(effort) = request.effort.as_ref() {
                validate_effort(request.provider, effort)?;
                args.extend([
                    "-c".into(),
                    format!("model_reasoning_effort={}", effort.to_ascii_lowercase()),
                ]);
            }
            if let Some(id) = request.resume_id.as_ref() {
                args.extend(["resume".into(), id.clone()]);
            }
            args.push(request.prompt);
            "codex"
        }
        ProviderId::Antigravity => {
            args.extend([
                "-p".into(),
                request.prompt,
                "--output-format".into(),
                "stream-json".into(),
            ]);
            if let Some(id) = request.resume_id.as_ref() {
                args.extend(["--conversation".into(), id.clone()]);
            }
            if let Some(model) = request.model.as_ref() {
                args.extend(["--model".into(), model.clone()]);
            }
            if let Some(effort) = request.effort.as_ref() {
                validate_effort(request.provider, effort)?;
                args.extend(["--effort".into(), effort.to_ascii_lowercase()]);
            }
            "agy"
        }
    };

    Ok(ProcessSpec {
        provider: Some(request.provider),
        display_name: request
            .display_name
            .unwrap_or_else(|| format!("{} task", request.provider.as_str())),
        model: request.model,
        effort: request.effort.map(|value| value.to_ascii_lowercase()),
        program: program.into(),
        args,
        cwd: request.cwd,
        env: BTreeMap::new(),
        timeout_seconds: None,
    })
}

fn validate_effort(provider: ProviderId, effort: &str) -> Result<(), AdapterError> {
    let allowed = match provider {
        ProviderId::ClaudeCode => &["low", "medium", "high", "max"][..],
        ProviderId::Codex => &["low", "medium", "high", "xhigh"][..],
        ProviderId::Antigravity => &["low", "medium", "high"][..],
    };
    if !allowed.contains(&effort.to_ascii_lowercase().as_str()) {
        return Err(AdapterError::InvalidEffort {
            provider,
            effort: effort.into(),
        });
    }
    Ok(())
}
