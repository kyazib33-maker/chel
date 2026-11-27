use process_manager::{ProcessManager, ProcessManagerConfig, ProcessSpec};
use shared_protocol::{TaskEventPayload, TaskStatus};
use std::{collections::BTreeMap, time::Duration};

fn spec(program: &str, args: &[&str]) -> ProcessSpec {
    ProcessSpec {
        provider: None,
        display_name: "process-manager smoke test".into(),
        model: None,
        effort: None,
        program: program.into(),
        args: args.iter().map(|arg| (*arg).to_string()).collect(),
        cwd: std::env::temp_dir(),
        env: BTreeMap::new(),
        timeout_seconds: Some(15),
    }
}

#[tokio::test]
async fn streams_both_channels_and_finishes_successfully() {
    let manager = ProcessManager::new(ProcessManagerConfig::default());
    let mut events = manager.subscribe();

    #[cfg(unix)]
    let task_id = manager
        .start(spec(
            "/bin/sh",
            &["-c", "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2"],
        ))
        .await
        .unwrap();
    #[cfg(windows)]
    let task_id = manager
        .start(spec(
            "cmd.exe",
            &["/C", "echo stdout-line & echo stderr-line 1>&2"],
        ))
        .await
        .unwrap();

    let mut stdout_seen = false;
    let mut stderr_seen = false;
    let mut last_sequence = 0;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.task_id != task_id {
                continue;
            }
            assert!(
                event.sequence > last_sequence,
                "per-task event sequence must be increasing"
            );
            last_sequence = event.sequence;
            if let TaskEventPayload::Output { stream, line } = event.payload {
                match stream {
                    shared_protocol::OutputStream::Stdout if line.contains("stdout-line") => {
                        stdout_seen = true
                    }
                    shared_protocol::OutputStream::Stderr if line.contains("stderr-line") => {
                        stderr_seen = true
                    }
                    _ => {}
                }
            }
            if let Some(snapshot) = manager.get_task(task_id).await {
                if snapshot.status.is_terminal() {
                    break;
                }
            }
        }
    })
    .await
    .expect("process should finish in time");

    assert!(stdout_seen, "stdout should be streamed");
    assert!(stderr_seen, "stderr should be streamed");
    assert_eq!(
        manager.get_task(task_id).await.unwrap().status,
        TaskStatus::Succeeded
    );
}

#[tokio::test]
async fn cancellation_reaches_running_process() {
    let manager = ProcessManager::new(ProcessManagerConfig::default());
    let task_id = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/sleep", &["30"])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "ping 127.0.0.1 -n 30 > nul"]))
                .await
                .unwrap()
        }
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager
                .get_task(task_id)
                .await
                .map(|task| task.status == TaskStatus::Running)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("process should enter running state");

    manager.cancel(task_id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if manager
                .get_task(task_id)
                .await
                .map(|task| task.status == TaskStatus::Cancelled)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("cancelled process should terminate");
}

#[tokio::test]
async fn queued_task_can_be_cancelled_before_a_slot_is_available() {
    let manager = ProcessManager::new(ProcessManagerConfig {
        max_parallel_processes: 1,
        ..Default::default()
    });

    let running = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/sleep", &["30"])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "ping 127.0.0.1 -n 30 > nul"]))
                .await
                .unwrap()
        }
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager
                .get_task(running)
                .await
                .map(|task| task.status == TaskStatus::Running)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("first task should occupy the only process slot");

    let queued = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/echo", &["queued"])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "echo queued"]))
                .await
                .unwrap()
        }
    };
    assert_eq!(
        manager.get_task(queued).await.unwrap().status,
        TaskStatus::Queued
    );
    manager.cancel(queued).await.unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager
                .get_task(queued)
                .await
                .map(|task| task.status == TaskStatus::Cancelled)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("queued task should cancel without acquiring a slot");

    manager.cancel(running).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if manager
                .get_task(running)
                .await
                .map(|task| task.status == TaskStatus::Cancelled)
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("running task should terminate after cancellation");
}

#[tokio::test]
async fn two_tasks_can_run_at_the_same_time() {
    let manager = ProcessManager::new(ProcessManagerConfig {
        max_parallel_processes: 2,
        ..Default::default()
    });
    let first = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/sleep", &["30"])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "ping 127.0.0.1 -n 30 > nul"]))
                .await
                .unwrap()
        }
    };
    let second = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/sleep", &["30"])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "ping 127.0.0.1 -n 30 > nul"]))
                .await
                .unwrap()
        }
    };

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let first_running = manager
                .get_task(first)
                .await
                .map(|task| task.status == TaskStatus::Running)
                .unwrap_or(false);
            let second_running = manager
                .get_task(second)
                .await
                .map(|task| task.status == TaskStatus::Running)
                .unwrap_or(false);
            if first_running && second_running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("both processes should occupy independent slots");

    manager.cancel(first).await.unwrap();
    manager.cancel(second).await.unwrap();
    for task_id in [first, second] {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if manager
                    .get_task(task_id)
                    .await
                    .map(|task| task.status == TaskStatus::Cancelled)
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("parallel task should terminate after cancellation");
    }
}

#[tokio::test]
async fn terminal_task_history_is_bounded_without_evicting_running_tasks() {
    let manager = ProcessManager::new(ProcessManagerConfig {
        max_retained_tasks: 1,
        ..Default::default()
    });
    let first = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/true", &[])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "exit 0"]))
                .await
                .unwrap()
        }
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if manager
                .get_task(first)
                .await
                .map(|task| task.status.is_terminal())
                .unwrap_or(false)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("first task should finish");

    let second = {
        #[cfg(unix)]
        {
            manager.start(spec("/bin/true", &[])).await.unwrap()
        }
        #[cfg(windows)]
        {
            manager
                .start(spec("cmd.exe", &["/C", "exit 0"]))
                .await
                .unwrap()
        }
    };
    let snapshots = manager.list_tasks().await;
    assert!(snapshots.iter().any(|task| task.task_id == second));
    assert!(!snapshots.iter().any(|task| task.task_id == first));
}

#[tokio::test]
async fn detects_the_file_most_recently_modified_by_a_task() {
    let manager = ProcessManager::new(ProcessManagerConfig::default());
    let temp = tempfile::TempDir::new().unwrap();
    let mut task_spec = spec("", &[]);
    task_spec.cwd = temp.path().to_path_buf();
    task_spec.timeout_seconds = Some(10);

    #[cfg(unix)]
    {
        task_spec.program = "/bin/sh".into();
        task_spec.args = vec![
            "-c".into(),
            "printf 'tracked' > orchestrator-watch-test.txt; sleep 2".into(),
        ];
    }
    #[cfg(windows)]
    {
        task_spec.program = "cmd.exe".into();
        task_spec.args = vec![
            "/C".into(),
            "echo tracked>orchestrator-watch-test.txt & ping 127.0.0.1 -n 3 > nul".into(),
        ];
    }

    let task_id = manager.start(task_spec).await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let snapshot = manager.get_task(task_id).await.unwrap();
            if snapshot
                .current_file
                .as_deref()
                .is_some_and(|path| path.ends_with("orchestrator-watch-test.txt"))
            {
                break;
            }
            if snapshot.status.is_terminal() {
                panic!("task finished before file notification arrived");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("filesystem watcher should publish current file activity");
}
