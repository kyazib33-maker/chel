//! Makes sure every AI process Chel starts dies with Chel.
//!
//! Chel puts itself in a Windows Job Object flagged KILL_ON_JOB_CLOSE. Every
//! process it starts afterwards (PowerShell trampolines, node, claude, codex,
//! agy…) joins the same job, so when Chel exits — normally, by crash or from
//! Task Manager — Windows closes the job and terminates all of them.

#[cfg(windows)]
pub fn kill_children_on_exit() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() { tracing::warn!("não foi possível criar o Job Object"); return; }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        if ok == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            tracing::warn!("não foi possível ligar o encerramento automático dos processos filhos");
        }
        // The handle is intentionally kept open for the whole life of Chel; the OS closes it on exit.
    }
}

#[cfg(not(windows))]
pub fn kill_children_on_exit() {}

#[cfg(all(test, windows))]
mod tests {
    use std::process::Command;

    fn alive(pid: u32) -> bool {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    /// Child half: enable the job, start a long-running grandchild, print its pid and exit.
    #[test]
    #[ignore = "helper run by children_die_with_parent"]
    fn helper_spawn_and_exit() {
        if std::env::var_os("CHEL_JOB_CONTROL").is_none() { super::kill_children_on_exit(); }
        let child = Command::new("powershell").args(["-NoProfile", "-Command", "Start-Sleep -Seconds 120"]).spawn().unwrap();
        println!("GRANDCHILD={}", child.id());
        std::mem::forget(child);
    }

    #[test]
    fn children_die_with_parent() {
        let exe = std::env::current_exe().unwrap();
        let out = Command::new(exe).args(["--ignored", "--exact", "job::tests::helper_spawn_and_exit", "--nocapture"]).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let pid: u32 = text.split("GRANDCHILD=").nth(1).unwrap().split_whitespace().next().unwrap().parse().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        assert!(!alive(pid), "o processo filho {pid} sobreviveu ao pai");
    }
}
