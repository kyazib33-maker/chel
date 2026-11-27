use process_manager::{ProcessManager, ProcessManagerError};
use provider_adapters::{build_process_spec, AdapterError};
use shared_protocol::{AgentLaunchRequest, TaskId, TaskSnapshot};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum OrchestratorError {
    #[error(transparent)]
    Adapter(#[from] AdapterError),
    #[error(transparent)]
    Process(#[from] ProcessManagerError),
}

#[derive(Clone)]
pub struct Orchestrator {
    processes: ProcessManager,
}

impl Orchestrator {
    pub fn new(processes: ProcessManager) -> Self {
        Self { processes }
    }
    pub async fn launch(&self, request: AgentLaunchRequest) -> Result<TaskId, OrchestratorError> {
        let spec = build_process_spec(request)?;
        Ok(self.processes.start(spec).await?)
    }
    pub async fn cancel(&self, id: TaskId) -> Result<(), OrchestratorError> {
        Ok(self.processes.cancel(id).await?)
    }
    pub async fn tasks(&self) -> Vec<TaskSnapshot> {
        self.processes.list_tasks().await
    }
}
