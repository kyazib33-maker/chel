use std::time::Duration;
use tokio::process::{Child, Command};

#[cfg(unix)]
pub(crate) fn configure_command(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // A separate process group lets cancellation reach the CLI and its descendants.
    command.as_std_mut().process_group(0);
}

#[cfg(windows)]
pub(crate) fn initialize_process_host() {
    use std::sync::Once;
    use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow;

    static CONSOLE_INIT: Once = Once::new();
    CONSOLE_INIT.call_once(|| unsafe {
        // Tauri is a GUI-subsystem process and normally has no console. Create
        // one hidden console so each CLI can inherit it while remaining in an
        // isolated process group for targeted CTRL+BREAK cancellation.
        if AllocConsole() != 0 {
            let window = GetConsoleWindow();
            if !window.is_null() {
                let _ = ShowWindow(window, 0); // SW_HIDE
            }
        }
    });
}

#[cfg(not(windows))]
pub(crate) fn initialize_process_host() {}

#[cfg(windows)]
pub(crate) fn configure_command(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
    command
        .as_std_mut()
        .creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn configure_command(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) async fn request_interrupt(child: &mut Child) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;

    if let Some(pid) = child.id() {
        // The process was created as a new process group (group id == pid).
        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGINT);
    }
}

#[cfg(windows)]
pub(crate) async fn request_interrupt(child: &mut Child) {
    use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};

    if let Some(pid) = child.id() {
        // All CLI processes inherit the Host's hidden console but are created
        // as separate process groups. CTRL+BREAK targets this CLI and its
        // descendants without signalling other running agents.
        unsafe {
            let _ = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid);
        }
    }
}

#[cfg(windows)]
pub(crate) async fn terminate_process_tree(child: &mut Child) {
    if let Some(pid) = child.id() {
        // taskkill /T is used only as the hard-stop fallback after a grace period.
        let _ = tokio::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    let _ = child.start_kill();
}

#[cfg(unix)]
pub(crate) async fn terminate_process_tree(child: &mut Child) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;
    if let Some(pid) = child.id() {
        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
    }
    let _ = child.start_kill();
}

#[cfg(not(any(unix, windows)))]
pub(crate) async fn terminate_process_tree(child: &mut Child) {
    let _ = child.start_kill();
}

pub(crate) async fn wait_after_interrupt(
    child: &mut Child,
    grace_period: Duration,
) -> std::io::Result<std::process::ExitStatus> {
    request_interrupt(child).await;
    match tokio::time::timeout(grace_period, child.wait()).await {
        Ok(result) => result,
        Err(_) => {
            terminate_process_tree(child).await;
            child.wait().await
        }
    }
}

/// Build a Windows PowerShell trampoline for npm-installed .cmd shims.
/// Arguments travel as base64-encoded JSON data, never as executable shell text.
#[cfg(windows)]
pub(crate) fn windows_shell_invocation(program: &str, args: &[String]) -> (String, Vec<String>) {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde_json::json;

    let payload = json!({ "program": program, "args": args });
    let json =
        serde_json::to_string(&payload).expect("serializing a process invocation cannot fail");
    let encoded_json = STANDARD.encode(json.as_bytes());
    let script = format!(
        "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')) | ConvertFrom-Json; $c=Get-Command -Name $p.program -CommandType Application -ErrorAction Stop | Select-Object -First 1; & $c.Source @($p.args); exit $LASTEXITCODE",
        encoded_json
    );
    let encoded_script = STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<u8>>(),
    );
    (
        "powershell.exe".to_string(),
        vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-EncodedCommand".into(),
            encoded_script,
        ],
    )
}
