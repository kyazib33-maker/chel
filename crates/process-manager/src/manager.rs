#[cfg(windows)]
use crate::platform::windows_shell_invocation;
use crate::platform::{configure_command, initialize_process_host, wait_after_interrupt};
use chrono::Utc;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use shared_protocol::{
    OutputStream, ProcessSpec, TaskEvent, TaskEventPayload, TaskId, TaskSnapshot, TaskStatus,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as SequenceMutex},
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{broadcast, mpsc, Mutex, Semaphore},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct ProcessManagerConfig {
    pub max_parallel_processes: usize,
    pub event_buffer_capacity: usize,
    pub max_retained_tasks: usize,
    pub interrupt_grace_period: Duration,
}

impl Default for ProcessManagerConfig {
    fn default() -> Self {
        Self {
            max_parallel_processes: 4,
            event_buffer_capacity: 4096,
            max_retained_tasks: 500,
            interrupt_grace_period: Duration::from_secs(4),
        }
    }
}

#[derive(Debug, Error)]
pub enum ProcessManagerError {
    #[error("diretório de trabalho não existe: {0}")]
    WorkingDirectoryMissing(String),
    #[error("o diretório de trabalho precisa ser absoluto: {0}")]
    WorkingDirectoryNotAbsolute(String),
    #[error("não foi possível iniciar o processo: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("tarefa não encontrada: {0}")]
    TaskNotFound(TaskId),
    #[error("a tarefa já terminou")]
    AlreadyFinished,
}

struct ManagedTask {
    snapshot: TaskSnapshot,
    cancellation: CancellationToken,
    sequence: Arc<SequenceMutex<u64>>,
}

struct Inner {
    tasks: Mutex<HashMap<TaskId, ManagedTask>>,
    slots: Arc<Semaphore>,
    events: broadcast::Sender<TaskEvent>,
    config: ProcessManagerConfig,
}

#[derive(Clone)]
pub struct ProcessManager {
    inner: Arc<Inner>,
}

impl ProcessManager {
    pub fn new(config: ProcessManagerConfig) -> Self {
        initialize_process_host();
        let capacity = config.event_buffer_capacity.max(128);
        let (events, _) = broadcast::channel(capacity);
        Self {
            inner: Arc::new(Inner {
                tasks: Mutex::new(HashMap::new()),
                slots: Arc::new(Semaphore::new(config.max_parallel_processes.max(1))),
                events,
                config,
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TaskEvent> {
        self.inner.events.subscribe()
    }

    pub async fn start(&self, spec: ProcessSpec) -> Result<TaskId, ProcessManagerError> {
        if !spec.cwd.is_absolute() {
            return Err(ProcessManagerError::WorkingDirectoryNotAbsolute(
                spec.cwd.display().to_string(),
            ));
        }
        if !spec.cwd.is_dir() {
            return Err(ProcessManagerError::WorkingDirectoryMissing(
                spec.cwd.display().to_string(),
            ));
        }

        let task_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        let sequence = Arc::new(SequenceMutex::new(0));
        let snapshot = TaskSnapshot {
            task_id,
            provider: spec.provider,
            display_name: spec.display_name.clone(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
            program: spec.program.clone(),
            cwd: spec.cwd.clone(),
            current_file: None,
            last_file_change_at: None,
            status: TaskStatus::Queued,
            created_at: Utc::now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            last_error: None,
        };

        {
            let mut tasks = self.inner.tasks.lock().await;
            self.prune_terminal_tasks(&mut tasks);
            tasks.insert(
                task_id,
                ManagedTask {
                    snapshot,
                    cancellation: cancellation.clone(),
                    sequence: sequence.clone(),
                },
            );
            // State mutation and event publication share the task-map lock so
            // a concurrent cancel cannot publish an older state afterwards.
            self.emit(
                task_id,
                &sequence,
                TaskEventPayload::StateChanged {
                    status: TaskStatus::Queued,
                },
            );
        }

        let manager = self.clone();
        tokio::spawn(async move {
            manager
                .run_task(task_id, spec, cancellation, sequence)
                .await;
        });

        Ok(task_id)
    }

    pub async fn cancel(&self, task_id: TaskId) -> Result<(), ProcessManagerError> {
        let mut tasks = self.inner.tasks.lock().await;
        let task = tasks
            .get_mut(&task_id)
            .ok_or(ProcessManagerError::TaskNotFound(task_id))?;
        if task.snapshot.status.is_terminal() {
            return Err(ProcessManagerError::AlreadyFinished);
        }
        task.snapshot.status = TaskStatus::Cancelling;
        task.cancellation.cancel();
        let sequence = task.sequence.clone();
        self.emit(
            task_id,
            &sequence,
            TaskEventPayload::StateChanged {
                status: TaskStatus::Cancelling,
            },
        );
        Ok(())
    }

    pub async fn list_tasks(&self) -> Vec<TaskSnapshot> {
        let tasks = self.inner.tasks.lock().await;
        let mut snapshots: Vec<_> = tasks.values().map(|task| task.snapshot.clone()).collect();
        snapshots.sort_by_key(|a| std::cmp::Reverse(a.created_at));
        snapshots
    }

    pub async fn get_task(&self, task_id: TaskId) -> Option<TaskSnapshot> {
        self.inner
            .tasks
            .lock()
            .await
            .get(&task_id)
            .map(|task| task.snapshot.clone())
    }

    async fn run_task(
        &self,
        task_id: TaskId,
        spec: ProcessSpec,
        cancellation: CancellationToken,
        sequence: Arc<SequenceMutex<u64>>,
    ) {
        let permit = tokio::select! {
            permit = self.inner.slots.clone().acquire_owned() => match permit {
                Ok(permit) => permit,
                Err(_) => {
                    self.finish_error(task_id, &sequence, "pool de processos foi encerrado".into()).await;
                    return;
                }
            },
            _ = cancellation.cancelled() => {
                self.finish_cancelled(task_id, &sequence, None).await;
                return;
            }
        };

        if cancellation.is_cancelled() {
            drop(permit);
            self.finish_cancelled(task_id, &sequence, None).await;
            return;
        }

        self.set_status(task_id, &sequence, TaskStatus::Starting)
            .await;
        if cancellation.is_cancelled() {
            drop(permit);
            self.finish_cancelled(task_id, &sequence, None).await;
            return;
        }

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .envs(&spec.env)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        configure_command(&mut command);

        #[cfg(windows)]
        {
            // npm-installed CLI tools commonly expose .cmd shims. Resolve them
            // through PowerShell with arguments carried as encoded JSON data.
            let lower = spec.program.to_ascii_lowercase();
            if !lower.ends_with(".exe") {
                let (program, args) = windows_shell_invocation(&spec.program, &spec.args);
                command = Command::new(program);
                command
                    .args(args)
                    .current_dir(&spec.cwd)
                    .envs(&spec.env)
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .kill_on_drop(true);
                configure_command(&mut command);
            }
        }

        // Arm the filesystem watcher before spawning the CLI so very fast
        // writes (for example, generated config files) cannot be missed.
        let (file_watcher, file_watch_task) =
            self.spawn_file_watcher(task_id, spec.cwd.clone(), sequence.clone());

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                drop(file_watcher);
                if let Some(handle) = file_watch_task {
                    handle.abort();
                }
                drop(permit);
                self.finish_error(task_id, &sequence, error.to_string())
                    .await;
                return;
            }
        };

        {
            let mut tasks = self.inner.tasks.lock().await;
            if let Some(task) = tasks.get_mut(&task_id) {
                // Cancellation may race with process creation. Never overwrite
                // Cancelling with Running if the request already arrived.
                let status = if cancellation.is_cancelled() {
                    TaskStatus::Cancelling
                } else {
                    task.snapshot.started_at = Some(Utc::now());
                    TaskStatus::Running
                };
                task.snapshot.status = status;
                self.emit(
                    task_id,
                    &sequence,
                    TaskEventPayload::StateChanged { status },
                );
            }
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_pump = stdout.map(|stream| {
            self.spawn_output_pump(task_id, stream, OutputStream::Stdout, sequence.clone())
        });
        let stderr_pump = stderr.map(|stream| {
            self.spawn_output_pump(task_id, stream, OutputStream::Stderr, sequence.clone())
        });

        let mut was_cancelled = false;
        let mut timed_out = false;
        let wait_result = if let Some(seconds) = spec.timeout_seconds {
            tokio::select! {
                result = child.wait() => result,
                _ = cancellation.cancelled() => {
                    was_cancelled = true;
                    wait_after_interrupt(&mut child, self.inner.config.interrupt_grace_period).await
                },
                _ = tokio::time::sleep(Duration::from_secs(seconds)) => {
                    timed_out = true;
                    wait_after_interrupt(&mut child, self.inner.config.interrupt_grace_period).await
                }
            }
        } else {
            tokio::select! {
                result = child.wait() => result,
                _ = cancellation.cancelled() => {
                    was_cancelled = true;
                    wait_after_interrupt(&mut child, self.inner.config.interrupt_grace_period).await
                }
            }
        };

        if let Some(handle) = stdout_pump {
            let _ = handle.await;
        }
        if let Some(handle) = stderr_pump {
            let _ = handle.await;
        }
        drop(file_watcher);
        if let Some(mut handle) = file_watch_task {
            if tokio::time::timeout(Duration::from_secs(1), &mut handle)
                .await
                .is_err()
            {
                handle.abort();
            }
        }
        drop(permit);

        match wait_result {
            Ok(status) if was_cancelled => {
                self.finish_cancelled(task_id, &sequence, status.code())
                    .await
            }
            Ok(_status) if timed_out => {
                self.finish_error(task_id, &sequence, "tempo limite da tarefa excedido".into())
                    .await
            }
            Ok(status) if status.success() => {
                self.finish_success(task_id, &sequence, status.code()).await
            }
            Ok(status) => {
                self.finish_error_with_code(
                    task_id,
                    &sequence,
                    status.code(),
                    format!("processo terminou com status {status}"),
                )
                .await
            }
            Err(error) => {
                self.finish_error(task_id, &sequence, error.to_string())
                    .await
            }
        }
    }

    fn spawn_file_watcher(
        &self,
        task_id: TaskId,
        root: PathBuf,
        sequence: Arc<SequenceMutex<u64>>,
    ) -> (Option<RecommendedWatcher>, Option<JoinHandle<()>>) {
        let (sender, mut receiver) = mpsc::channel::<notify::Result<notify::Event>>(256);
        let mut watcher = match notify::recommended_watcher(
            move |event: notify::Result<notify::Event>| {
                let _ = sender.try_send(event);
            },
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                tracing::warn!(task_id = %task_id, %error, "não foi possível iniciar monitoramento de arquivos");
                return (None, None);
            }
        };
        if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
            tracing::warn!(task_id = %task_id, %error, "não foi possível observar o diretório da tarefa");
            return (None, None);
        }

        let manager = self.clone();
        let handle = tokio::spawn(async move {
            while let Some(result) = receiver.recv().await {
                let Ok(event) = result else {
                    continue;
                };
                if !matches!(&event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    continue;
                }
                for path in event.paths {
                    if is_relevant_file(&root, &path) {
                        if let Ok(relative) = path.strip_prefix(&root) {
                            manager
                                .set_current_file(
                                    task_id,
                                    relative.to_string_lossy().to_string(),
                                    &sequence,
                                )
                                .await;
                        }
                    }
                }
            }
        });
        (Some(watcher), Some(handle))
    }

    async fn set_current_file(&self, task_id: TaskId, path: String, sequence: &SequenceMutex<u64>) {
        let mut tasks = self.inner.tasks.lock().await;
        if let Some(task) = tasks.get_mut(&task_id) {
            task.snapshot.current_file = Some(path.clone());
            task.snapshot.last_file_change_at = Some(Utc::now());
            self.emit(task_id, sequence, TaskEventPayload::FileChanged { path });
        }
    }

    fn spawn_output_pump<R>(
        &self,
        task_id: TaskId,
        stream: R,
        output_stream: OutputStream,
        sequence: Arc<SequenceMutex<u64>>,
    ) -> JoinHandle<()>
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
    {
        let manager = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stream).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        manager.emit(
                            task_id,
                            &sequence,
                            TaskEventPayload::Output {
                                stream: output_stream.clone(),
                                line,
                            },
                        );
                    }
                    Ok(None) => break,
                    Err(error) => {
                        manager.emit(
                            task_id,
                            &sequence,
                            TaskEventPayload::Error {
                                message: format!("falha lendo saída do processo: {error}"),
                            },
                        );
                        break;
                    }
                }
            }
        })
    }

    fn emit(&self, task_id: TaskId, sequence: &SequenceMutex<u64>, payload: TaskEventPayload) {
        // All task events (including stdout and stderr pumps) share this counter.
        let mut counter = sequence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *counter += 1;
        let current_sequence = *counter;
        let _ = self.inner.events.send(TaskEvent {
            task_id,
            sequence: current_sequence,
            emitted_at: Utc::now(),
            payload,
        });
    }

    async fn set_status(&self, task_id: TaskId, sequence: &SequenceMutex<u64>, status: TaskStatus) {
        let mut tasks = self.inner.tasks.lock().await;
        if let Some(task) = tasks.get_mut(&task_id) {
            let effective_status = if task.cancellation.is_cancelled() {
                TaskStatus::Cancelling
            } else {
                status
            };
            task.snapshot.status = effective_status;
            if effective_status == TaskStatus::Running && task.snapshot.started_at.is_none() {
                task.snapshot.started_at = Some(Utc::now());
            }
            self.emit(
                task_id,
                sequence,
                TaskEventPayload::StateChanged {
                    status: effective_status,
                },
            );
        }
    }

    async fn finish_success(
        &self,
        task_id: TaskId,
        sequence: &SequenceMutex<u64>,
        code: Option<i32>,
    ) {
        self.finish(task_id, sequence, TaskStatus::Succeeded, code, None)
            .await;
    }

    async fn finish_cancelled(
        &self,
        task_id: TaskId,
        sequence: &SequenceMutex<u64>,
        code: Option<i32>,
    ) {
        self.finish(task_id, sequence, TaskStatus::Cancelled, code, None)
            .await;
    }

    async fn finish_error(&self, task_id: TaskId, sequence: &SequenceMutex<u64>, message: String) {
        self.finish(task_id, sequence, TaskStatus::Failed, None, Some(message))
            .await;
    }

    async fn finish_error_with_code(
        &self,
        task_id: TaskId,
        sequence: &SequenceMutex<u64>,
        code: Option<i32>,
        message: String,
    ) {
        self.finish(task_id, sequence, TaskStatus::Failed, code, Some(message))
            .await;
    }

    async fn finish(
        &self,
        task_id: TaskId,
        sequence: &SequenceMutex<u64>,
        status: TaskStatus,
        code: Option<i32>,
        error: Option<String>,
    ) {
        let mut tasks = self.inner.tasks.lock().await;
        if let Some(task) = tasks.get_mut(&task_id) {
            task.snapshot.status = status;
            task.snapshot.exit_code = code;
            task.snapshot.finished_at = Some(Utc::now());
            task.snapshot.last_error = error.clone();
            // Publish the terminal state before releasing the lock, preserving
            // the same order for snapshot readers and concurrent cancellation.
            self.emit(task_id, sequence, TaskEventPayload::StateChanged { status });
            if let Some(message) = error {
                self.emit(task_id, sequence, TaskEventPayload::Error { message });
            }
            self.emit(task_id, sequence, TaskEventPayload::Exited { code });
        }
    }

    fn prune_terminal_tasks(&self, tasks: &mut HashMap<TaskId, ManagedTask>) {
        let limit = self.inner.config.max_retained_tasks.max(1);
        while tasks.len() >= limit {
            let oldest_terminal = tasks
                .iter()
                .filter(|(_, task)| task.snapshot.status.is_terminal())
                .min_by(|(_, left), (_, right)| {
                    left.snapshot.created_at.cmp(&right.snapshot.created_at)
                })
                .map(|(task_id, _)| *task_id);
            match oldest_terminal {
                Some(task_id) => {
                    tasks.remove(&task_id);
                }
                None => break, // Never evict a task that is still active or queued.
            }
        }
    }
}

fn is_relevant_file(root: &Path, path: &Path) -> bool {
    if path.strip_prefix(root).is_err() || !path.is_file() {
        return false;
    }
    let ignored = [
        ".git",
        "node_modules",
        "target",
        "dist",
        "build",
        ".next",
        "coverage",
        ".venv",
        "venv",
        "__pycache__",
    ];
    if path.components().any(|component| {
        let part = component.as_os_str().to_string_lossy();
        ignored.iter().any(|name| part.eq_ignore_ascii_case(name))
    }) {
        return false;
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    !(name.ends_with(".tmp") || name.ends_with(".swp") || name == ".DS_Store")
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new(ProcessManagerConfig::default())
    }
}
