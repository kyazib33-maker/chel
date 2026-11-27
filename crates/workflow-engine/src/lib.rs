use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use shared_protocol::ProviderId;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::Arc,
};
use thiserror::Error;
use tokio::{fs, sync::Mutex};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContextMode {
    None,
    Summary,
    FullOutput,
    FilesOnly,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeMode {
    Isolated,
    Shared,
    Inherit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentNode {
    pub id: String,
    pub name: String,
    pub role: String,
    pub prompt: String,
    pub provider: ProviderId,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default = "default_context_mode")]
    pub context_mode: ContextMode,
    #[serde(default = "default_worktree_mode")]
    pub worktree_mode: WorktreeMode,
    pub position: NodePosition,
}

fn default_context_mode() -> ContextMode {
    ContextMode::Summary
}
fn default_worktree_mode() -> WorktreeMode {
    WorktreeMode::Isolated
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default = "default_true")]
    pub pass_context: bool,
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub id: Uuid,
    pub name: String,
    pub nodes: Vec<AgentNode>,
    pub edges: Vec<WorkflowEdge>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl WorkflowDefinition {
    pub fn new(name: impl Into<String>, nodes: Vec<AgentNode>, edges: Vec<WorkflowEdge>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            name: name.into(),
            nodes,
            edges,
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    pub execution_levels: Vec<Vec<String>>,
}

#[derive(Debug, Error)]
pub enum WorkflowError {
    #[error("fluxo inválido: {0}")]
    Invalid(String),
    #[error("erro de arquivo: {0}")]
    Io(#[from] std::io::Error),
    #[error("erro de serialização: {0}")]
    Json(#[from] serde_json::Error),
}

pub fn validate_workflow(workflow: &WorkflowDefinition) -> WorkflowValidation {
    let mut errors = Vec::new();
    if workflow.name.trim().is_empty() {
        errors.push("O fluxo precisa ter um nome.".into());
    }
    if workflow.nodes.is_empty() {
        errors.push("Adicione pelo menos um bloco de agente.".into());
    }
    if workflow.nodes.len() > 64 {
        errors.push("O limite por fluxo é de 64 blocos.".into());
    }
    if workflow.edges.len() > 256 {
        errors.push("O limite por fluxo é de 256 conexões.".into());
    }

    let mut nodes = HashMap::new();
    for node in &workflow.nodes {
        if node.id.trim().is_empty() {
            errors.push("Existe um bloco sem identificador.".into());
        }
        if nodes.insert(node.id.clone(), node).is_some() {
            errors.push(format!("Identificador de bloco duplicado: {}", node.id));
        }
        if node.name.trim().is_empty() {
            errors.push(format!("O bloco {} precisa ter um nome.", node.id));
        }
        if node.role.trim().is_empty() {
            errors.push(format!("O bloco {} precisa ter um papel.", node.name));
        }
        if node.prompt.trim().is_empty() {
            errors.push(format!("O bloco {} precisa ter um prompt.", node.name));
        }
    }

    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    let mut indegree: HashMap<String, usize> = workflow
        .nodes
        .iter()
        .map(|node| (node.id.clone(), 0))
        .collect();
    let mut seen_edges = HashSet::new();
    for edge in &workflow.edges {
        if edge.source == edge.target {
            errors.push(format!(
                "O bloco {} não pode se conectar a si próprio.",
                edge.source
            ));
            continue;
        }
        if !nodes.contains_key(&edge.source) {
            errors.push(format!("Origem inexistente na conexão {}.", edge.id));
            continue;
        }
        if !nodes.contains_key(&edge.target) {
            errors.push(format!("Destino inexistente na conexão {}.", edge.id));
            continue;
        }
        if !seen_edges.insert((edge.source.clone(), edge.target.clone())) {
            errors.push(format!(
                "Conexão duplicada: {} → {}.",
                edge.source, edge.target
            ));
            continue;
        }
        adjacency
            .entry(edge.source.clone())
            .or_default()
            .push(edge.target.clone());
        *indegree.entry(edge.target.clone()).or_default() += 1;
    }

    let mut queue: VecDeque<String> = workflow
        .nodes
        .iter()
        .filter(|node| indegree.get(&node.id).copied().unwrap_or(0) == 0)
        .map(|node| node.id.clone())
        .collect();
    let mut levels = Vec::new();
    let mut visited = 0usize;
    while !queue.is_empty() {
        let level_size = queue.len();
        let mut level = Vec::with_capacity(level_size);
        for _ in 0..level_size {
            if let Some(node_id) = queue.pop_front() {
                visited += 1;
                level.push(node_id.clone());
                if let Some(targets) = adjacency.get(&node_id) {
                    for target in targets {
                        if let Some(count) = indegree.get_mut(target) {
                            *count -= 1;
                            if *count == 0 {
                                queue.push_back(target.clone());
                            }
                        }
                    }
                }
            }
        }
        levels.push(level);
    }
    if visited != workflow.nodes.len() {
        errors.push("O fluxo contém um ciclo. Remova uma conexão para formar um DAG.".into());
    }

    let valid = errors.is_empty();
    WorkflowValidation {
        valid,
        errors,
        execution_levels: if valid { levels } else { Vec::new() },
    }
}

#[derive(Clone)]
pub struct WorkflowStore {
    root: Arc<PathBuf>,
    lock: Arc<Mutex<()>>,
}

impl WorkflowStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root: Arc::new(root),
            lock: Arc::new(Mutex::new(())),
        }
    }

    pub async fn save(
        &self,
        mut workflow: WorkflowDefinition,
    ) -> Result<WorkflowDefinition, WorkflowError> {
        let _guard = self.lock.lock().await;
        let validation = validate_workflow(&workflow);
        if !validation.valid {
            return Err(WorkflowError::Invalid(validation.errors.join(" ")));
        }
        fs::create_dir_all(self.root.as_path()).await?;
        workflow.updated_at = Utc::now();
        let target = self.root.join(format!("{}.json", workflow.id));
        let temporary = self
            .root
            .join(format!("{}.{}.tmp", workflow.id, Uuid::new_v4()));
        fs::write(&temporary, serde_json::to_vec_pretty(&workflow)?).await?;
        if target.exists() {
            let backup = self
                .root
                .join(format!("{}.{}.bak", workflow.id, Uuid::new_v4()));
            fs::rename(&target, &backup).await?;
            match fs::rename(&temporary, &target).await {
                Ok(()) => {
                    let _ = fs::remove_file(backup).await;
                }
                Err(error) => {
                    let _ = fs::rename(&backup, &target).await;
                    let _ = fs::remove_file(&temporary).await;
                    return Err(WorkflowError::Io(error));
                }
            }
        } else {
            fs::rename(&temporary, &target).await?;
        }
        Ok(workflow)
    }

    pub async fn list(&self) -> Result<Vec<WorkflowDefinition>, WorkflowError> {
        let _guard = self.lock.lock().await;
        fs::create_dir_all(self.root.as_path()).await?;
        let mut directory = fs::read_dir(self.root.as_path()).await?;
        let mut workflows = Vec::new();
        while let Some(entry) = directory.next_entry().await? {
            if entry.path().extension().and_then(|part| part.to_str()) != Some("json") {
                continue;
            }
            let bytes = match fs::read(entry.path()).await {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let workflow: WorkflowDefinition = match serde_json::from_slice(&bytes) {
                Ok(value) => value,
                Err(_) => continue,
            };
            if validate_workflow(&workflow).valid {
                workflows.push(workflow);
            }
        }
        workflows.sort_by_key(|left| std::cmp::Reverse(left.updated_at));
        Ok(workflows)
    }

    pub async fn delete(&self, id: Uuid) -> Result<(), WorkflowError> {
        let _guard = self.lock.lock().await;
        match fs::remove_file(self.root.join(format!("{id}.json"))).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(WorkflowError::Io(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn node(id: &str, x: f64) -> AgentNode {
        AgentNode {
            id: id.into(),
            name: id.into(),
            role: "Developer".into(),
            prompt: "Implement the task".into(),
            provider: ProviderId::ClaudeCode,
            model: None,
            effort: Some("medium".into()),
            context_mode: ContextMode::Summary,
            worktree_mode: WorktreeMode::Isolated,
            position: NodePosition { x, y: 100.0 },
        }
    }

    #[test]
    fn validates_dag_and_returns_parallel_levels() {
        let workflow = WorkflowDefinition::new(
            "Build",
            vec![
                node("plan", 0.0),
                node("api", 250.0),
                node("ui", 250.0),
                node("review", 500.0),
            ],
            vec![
                WorkflowEdge {
                    id: "a".into(),
                    source: "plan".into(),
                    target: "api".into(),
                    pass_context: true,
                },
                WorkflowEdge {
                    id: "b".into(),
                    source: "plan".into(),
                    target: "ui".into(),
                    pass_context: true,
                },
                WorkflowEdge {
                    id: "c".into(),
                    source: "api".into(),
                    target: "review".into(),
                    pass_context: true,
                },
                WorkflowEdge {
                    id: "d".into(),
                    source: "ui".into(),
                    target: "review".into(),
                    pass_context: true,
                },
            ],
        );
        let validation = validate_workflow(&workflow);
        assert!(validation.valid, "{:?}", validation.errors);
        assert_eq!(
            validation.execution_levels,
            vec![
                vec!["plan".to_string()],
                vec!["api".to_string(), "ui".to_string()],
                vec!["review".to_string()]
            ]
        );
    }

    #[test]
    fn rejects_cycles_and_missing_endpoints() {
        let workflow = WorkflowDefinition::new(
            "Cyclic",
            vec![node("a", 0.0), node("b", 100.0)],
            vec![
                WorkflowEdge {
                    id: "ab".into(),
                    source: "a".into(),
                    target: "b".into(),
                    pass_context: true,
                },
                WorkflowEdge {
                    id: "ba".into(),
                    source: "b".into(),
                    target: "a".into(),
                    pass_context: true,
                },
                WorkflowEdge {
                    id: "missing".into(),
                    source: "b".into(),
                    target: "c".into(),
                    pass_context: true,
                },
            ],
        );
        let validation = validate_workflow(&workflow);
        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("ciclo")));
        assert!(validation
            .errors
            .iter()
            .any(|error| error.contains("Destino inexistente")));
    }

    #[tokio::test]
    async fn workflow_store_persists_valid_templates() {
        let temp = TempDir::new().unwrap();
        let store = WorkflowStore::new(temp.path().join("workflows"));
        let workflow = WorkflowDefinition::new("Simple", vec![node("agent", 0.0)], vec![]);
        let saved = store.save(workflow).await.unwrap();
        let mut updated = saved.clone();
        updated.name = "Renamed workflow".into();
        let saved_again = store.save(updated).await.unwrap();
        let all = store.list().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, saved.id);
        assert_eq!(all[0].name, "Renamed workflow");
        assert_eq!(saved_again.id, saved.id);
        store.delete(saved.id).await.unwrap();
        assert!(store.list().await.unwrap().is_empty());
    }
}
