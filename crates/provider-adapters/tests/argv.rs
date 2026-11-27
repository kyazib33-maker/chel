use provider_adapters::{build_process_spec, AdapterError};
use shared_protocol::{AgentLaunchRequest, ProviderId};
use std::path::PathBuf;

fn request(provider: ProviderId) -> AgentLaunchRequest {
    AgentLaunchRequest {
        provider,
        prompt: "Implementar endpoint de saúde".into(),
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        model: Some("model-test".into()),
        effort: Some("HIGH".into()),
        display_name: Some("Backend agent".into()),
    }
}

#[test]
fn claude_adapter_builds_streaming_print_arguments() {
    let spec = build_process_spec(request(ProviderId::ClaudeCode)).unwrap();
    assert_eq!(spec.program, "claude");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "--output-format" && pair[1] == "stream-json"));
    assert!(spec
        .args
        .iter()
        .any(|arg| arg == "--include-partial-messages"));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "--effort" && pair[1] == "high"));
    assert_eq!(spec.model.as_deref(), Some("model-test"));
    assert_eq!(spec.effort.as_deref(), Some("high"));
}

#[test]
fn codex_adapter_uses_exec_json_and_reasoning_effort_override() {
    let spec = build_process_spec(request(ProviderId::Codex)).unwrap();
    assert_eq!(spec.program, "codex");
    assert_eq!(spec.args[0], "exec");
    assert_eq!(spec.args[1], "--json");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "--model" && pair[1] == "model-test"));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "-c" && pair[1] == "model_reasoning_effort=high"));
    assert_eq!(
        spec.args.last().map(String::as_str),
        Some("Implementar endpoint de saúde")
    );
}

#[test]
fn antigravity_adapter_is_isolated_from_other_provider_flags() {
    let spec = build_process_spec(request(ProviderId::Antigravity)).unwrap();
    assert_eq!(spec.program, "agy");
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "--output-format" && pair[1] == "stream-json"));
    assert!(spec
        .args
        .windows(2)
        .any(|pair| pair[0] == "--effort" && pair[1] == "high"));
    assert!(!spec.args.iter().any(|arg| arg == "--json"));
}

#[test]
fn adapter_rejects_effort_values_outside_provider_contract() {
    let mut input = request(ProviderId::Codex);
    input.effort = Some("max".into());
    assert!(matches!(
        build_process_spec(input),
        Err(AdapterError::InvalidEffort {
            provider: ProviderId::Codex,
            ..
        })
    ));
}

#[test]
fn adapter_rejects_an_empty_prompt() {
    let mut input = request(ProviderId::ClaudeCode);
    input.prompt = "  \n".into();
    assert!(matches!(
        build_process_spec(input),
        Err(AdapterError::EmptyPrompt)
    ));
}
