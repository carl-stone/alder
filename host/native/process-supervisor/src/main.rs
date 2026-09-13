mod json;
mod platform;
mod protocol;
use std::collections::BTreeMap;
use std::env;

use json::Value;
use platform::{
    ChildExit, ManagedTarget, PROCESS_CONTAINMENT_UNAVAILABLE, ProcessInspection, SpawnSpec,
};
use protocol::{FramedReader, FramedWriter};

const PROTOCOL_VERSION: u64 = 1;
const DEFAULT_GRACE_MS: u64 = 1_000;
const DEFAULT_KILL_MS: u64 = 2_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

fn main() {
    let arguments: Vec<String> = env::args().collect();
    let result = match arguments.get(1).map(String::as_str) {
        Some("--anchor") => platform::run_anchor(&arguments[1..]),
        Some("--inspect-process") => run_inspect_process(&arguments[2..]),
        Some("--private-path") => platform::private_path(&arguments[2..]),
        Some("--detached-host") => run_detached(&arguments[2..]),
        Some("--child") | None => run_child(&arguments[2..]),
        Some(_) => Err("unknown supervisor mode".to_string()),
    };
    if let Err(error) = result {
        // Inspector and private-path modes have no target data plane, so
        // preserve their native diagnostic for callers.
        match arguments.get(1).map(String::as_str) {
            Some("--inspect-process") => {
                eprintln!("process supervisor inspection failed: {error}");
            }
            Some("--private-path") => {
                eprintln!("process supervisor private path failed: {error}");
            }
            _ => {}
        }
        std::process::exit(1);
    }
}

fn run_inspect_process(arguments: &[String]) -> Result<(), String> {
    let [value] = arguments else {
        return Err("inspect-process requires exactly one PID".to_string());
    };
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("inspect-process PID must be a decimal integer".to_string());
    }
    let pid = value
        .parse::<u32>()
        .map_err(|_| "inspect-process PID is outside the supported range".to_string())?;
    if pid == 0 {
        return Err("inspect-process PID must be positive".to_string());
    }
    match platform::inspect_process(pid)? {
        ProcessInspection::Live {
            pid,
            ppid,
            start_identity,
        } => {
            println!(
                r#"{{"pid":{pid},"ppid":{ppid},"startIdentity":{}}}"#,
                json::string(&start_identity),
            );
        }
        ProcessInspection::Absent => println!("null"),
    }
    Ok(())
}

fn run_child(arguments: &[String]) -> Result<(), String> {
    run_supervised(arguments, false)
}

fn run_detached(arguments: &[String]) -> Result<(), String> {
    run_supervised(arguments, true)
}

fn run_supervised(arguments: &[String], detached: bool) -> Result<(), String> {
    let (input, output) = control_values(arguments);
    let (reader, writer) = platform::open_control(input.as_deref(), output.as_deref())?;
    let mut reader = FramedReader::new(reader);
    let mut writer = FramedWriter::new(writer);
    let supervisor_identity = platform::self_start_identity()?;
    writer.send(&format!(
        "{{\"v\":{PROTOCOL_VERSION},\"type\":\"hello\",\"pid\":{},\"startIdentity\":{},\"platform\":{},\"features\":[\"direct-stdio\",\"lifecycle-fd\",\"identity\"]}}",
        platform::self_pid(),
        json::string(&supervisor_identity),
        json::string(platform_name()),
    ))?;

    let mut target: Option<Box<dyn ManagedTarget>> = None;
    let mut target_request_id: Option<u64> = None;
    let mut target_exit: Option<ChildExit> = None;
    let mut target_exit_sent = false;
    let mut closing = false;

    loop {
        if let Some(process) = target.as_mut() {
            if target_exit.is_none() {
                if let Some(exit) = process.try_wait()? {
                    if !target_exit_sent {
                        send_exited(&mut writer, target_request_id, process.as_ref(), &exit)?;
                        target_exit_sent = true;
                    }
                    target_exit = Some(exit);
                }
            }
        }

        if closing {
            if let Some(process) = target.as_mut() {
                process.finish_cleanup()?;
                if target_exit.is_none() {
                    target_exit = process.try_wait()?;
                }
                let exit = target_exit
                    .as_ref()
                    .ok_or_else(|| "owned target did not report exit after cleanup".to_string())?;
                if !target_exit_sent {
                    send_exited(&mut writer, target_request_id, process.as_ref(), exit)?;
                }
            }
            writer.send(&format!(
                "{{\"v\":{PROTOCOL_VERSION},\"type\":\"closed\",\"id\":{}}}",
                target_request_id.unwrap_or(0),
            ))?;
            return Ok(());
        }

        if !reader.wait(50)? {
            continue;
        }
        let Some(frame) = reader.next()? else {
            if let Some(process) = target.as_mut() {
                process.finish_cleanup()?;
            }
            return Ok(());
        };
        let value = match json::parse(&frame) {
            Ok(value) => value,
            Err(error) => {
                send_error(&mut writer, None, "invalid_control", &error)?;
                if let Some(process) = target.as_mut() {
                    process.finish_cleanup()?;
                }
                return Err(error);
            }
        };
        let object = match value.object() {
            Ok(object) => object,
            Err(error) => {
                send_error(&mut writer, None, "invalid_control", &error)?;
                continue;
            }
        };
        let version = match required(object, "v").and_then(|value| value.u64("v")) {
            Ok(version) => version,
            Err(error) => {
                send_error(&mut writer, None, "invalid_control", &error)?;
                continue;
            }
        };
        if version != PROTOCOL_VERSION {
            send_error(
                &mut writer,
                None,
                "invalid_control",
                "unsupported protocol version",
            )?;
            continue;
        }
        let operation = match required(object, "op").and_then(Value::string) {
            Ok(operation) => operation,
            Err(error) => {
                send_error(&mut writer, None, "invalid_control", &error)?;
                continue;
            }
        };
        let request_id = optional_u64(object, "id")?;
        match operation {
            "spawn" => {
                if target.is_some() {
                    send_error(
                        &mut writer,
                        request_id,
                        "already_spawned",
                        "wrapper accepts one target",
                    )?;
                    continue;
                }
                let spec = match parse_spawn(object) {
                    Ok(spec) => spec,
                    Err(error) => {
                        send_error(&mut writer, request_id, "invalid_spawn", &error)?;
                        continue;
                    }
                };
                let spawned = if detached {
                    platform::spawn_detached(&spec)
                } else {
                    platform::spawn_target(&spec)
                };
                match spawned {
                    Ok(process) => {
                        target_request_id = request_id;
                        let pid = process.pid();
                        let identity = process.start_identity().to_string();
                        target = Some(process);
                        writer.send(&format!(
                            "{{\"v\":{PROTOCOL_VERSION},\"type\":\"spawned\",\"id\":{},\"pid\":{pid},\"startIdentity\":{}}}",
                            request_id.unwrap_or(0),
                            json::string(&identity),
                        ))?;
                        // Keep target data streams alive while readiness is
                        // authenticated; handoff releases supervisor control.
                        platform::close_wrapper_stdio();
                    }
                    Err(error) => {
                        let code = if error.contains(PROCESS_CONTAINMENT_UNAVAILABLE) {
                            PROCESS_CONTAINMENT_UNAVAILABLE
                        } else {
                            "spawn_failed"
                        };
                        send_error(&mut writer, request_id, code, &error)?;
                    }
                }
            }
            "handoff" => {
                if !detached {
                    send_error(
                        &mut writer,
                        request_id,
                        "invalid_control",
                        "handoff requires detached mode",
                    )?;
                    continue;
                }
                if target.is_none() {
                    send_error(&mut writer, request_id, "not_spawned", "no owned target")?;
                    continue;
                }
                if target_exit.is_some() {
                    send_error(
                        &mut writer,
                        request_id,
                        "target_exited",
                        "target exited before handoff",
                    )?;
                    continue;
                }
                let handoff_result = match target.as_mut() {
                    Some(process) => process.handoff(),
                    None => {
                        send_error(&mut writer, request_id, "not_spawned", "no owned target")?;
                        continue;
                    }
                };
                if let Err(error) = handoff_result {
                    let code = if error.contains("target exited before handoff") {
                        "target_exited"
                    } else {
                        "handoff_failed"
                    };
                    send_error(&mut writer, request_id, code, &error)?;
                    continue;
                }
                target.take();
                writer.send(&format!(
                    "{{\"v\":{PROTOCOL_VERSION},\"type\":\"closed\",\"id\":{}}}",
                    request_id.unwrap_or(0),
                ))?;
                return Ok(());
            }
            "terminate" => {
                let Some(process) = target.as_mut() else {
                    send_error(&mut writer, request_id, "not_spawned", "no owned target")?;
                    continue;
                };
                let grace = bounded_timeout(object, "graceMs", DEFAULT_GRACE_MS)?;
                let kill = bounded_timeout(object, "killMs", DEFAULT_KILL_MS)?;
                process.terminate(grace, kill)?;
            }
            "close" => {
                closing = true;
            }
            _ => send_error(
                &mut writer,
                request_id,
                "invalid_control",
                "unknown operation",
            )?,
        }
    }
}

fn control_values(arguments: &[String]) -> (Option<String>, Option<String>) {
    let mut input = None;
    let mut output = None;
    for argument in arguments {
        if let Some(value) = argument.strip_prefix("--control-in=") {
            input = Some(value.to_string());
        } else if let Some(value) = argument.strip_prefix("--control-out=") {
            output = Some(value.to_string());
        }
    }
    (input, output)
}

fn parse_spawn(object: &BTreeMap<String, Value>) -> Result<SpawnSpec, String> {
    let executable = required(object, "executable")?.string()?.to_string();
    let args = required(object, "args")?.string_array("args")?;
    let cwd = required(object, "cwd")?.string()?.to_string();
    let environment = required(object, "environment")?.string_map("environment")?;
    let stdio = required(object, "stdio")?.string()?.to_string();
    Ok(SpawnSpec {
        executable,
        args,
        cwd,
        environment,
        stdio,
    })
}

fn required<'a>(object: &'a BTreeMap<String, Value>, name: &str) -> Result<&'a Value, String> {
    Value::required(object, name)
}

fn optional_u64(object: &BTreeMap<String, Value>, name: &str) -> Result<Option<u64>, String> {
    match Value::optional(object, name) {
        Some(value) => Ok(Some(value.u64(name)?)),
        None => Ok(None),
    }
}

fn bounded_timeout(
    object: &BTreeMap<String, Value>,
    name: &str,
    default: u64,
) -> Result<u64, String> {
    let timeout = optional_u64(object, name)?.unwrap_or(default);
    if timeout > MAX_TIMEOUT_MS {
        return Err(format!("{name} exceeds {MAX_TIMEOUT_MS} ms"));
    }
    Ok(timeout)
}

fn send_error(
    writer: &mut FramedWriter,
    request_id: Option<u64>,
    code: &str,
    message: &str,
) -> Result<(), String> {
    let request = request_id.map_or_else(|| "null".to_string(), |id| id.to_string());
    writer.send(&format!(
        "{{\"v\":{PROTOCOL_VERSION},\"type\":\"error\",\"requestId\":{request},\"code\":{},\"message\":{}}}",
        json::string(code),
        json::string(message),
    ))
}

fn send_exited(
    writer: &mut FramedWriter,
    request_id: Option<u64>,
    process: &dyn ManagedTarget,
    exit: &ChildExit,
) -> Result<(), String> {
    let id = request_id.unwrap_or(0);
    let code = exit
        .code
        .map_or_else(|| "null".to_string(), |code| code.to_string());
    let signal = exit
        .signal
        .as_deref()
        .map_or_else(|| "null".to_string(), json::string);
    writer.send(&format!(
        "{{\"v\":{PROTOCOL_VERSION},\"type\":\"exited\",\"id\":{id},\"pid\":{},\"startIdentity\":{},\"code\":{code},\"signal\":{signal}}}",
        process.pid(),
        json::string(process.start_identity()),
    ))
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unix"
    }
}
