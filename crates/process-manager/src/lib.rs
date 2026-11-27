mod manager;
mod platform;

pub use manager::{ProcessManager, ProcessManagerConfig, ProcessManagerError};
pub use shared_protocol::{
    OutputStream, ProcessSpec, TaskEvent, TaskEventPayload, TaskId, TaskSnapshot,
};

/// Builds a provider CLI command using the same cross-platform launcher used
/// by managed tasks. On Windows this safely invokes npm `.cmd` shims through
/// an encoded PowerShell trampoline; arguments are serialized as data.
pub fn build_cli_command(
    program: &str,
    args: &[String],
    cwd: &std::path::Path,
) -> tokio::process::Command {
    #[cfg(windows)]
    let (program, args) = platform::windows_shell_invocation(program, args);
    #[cfg(not(windows))]
    let (program, args) = (program.to_string(), args.to_vec());

    let mut command = tokio::process::Command::new(program);
    command.args(args).current_dir(cwd);
    platform::configure_command(&mut command);
    command
}

/// Terminates a CLI and its descendants using the host platform's process-tree strategy.
pub async fn terminate_cli_process_tree(child: &mut tokio::process::Child) {
    platform::terminate_process_tree(child).await;
    let _ = child.wait().await;
}
