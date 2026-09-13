use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;
#[cfg(windows)]
use std::time::Duration;

pub const PROCESS_CONTAINMENT_UNAVAILABLE: &str = "process_containment_unavailable";
#[derive(Debug)]
pub enum ProcessInspection {
    Live {
        pid: u32,
        ppid: u32,
        start_identity: String,
    },
    Absent,
}

#[derive(Debug)]
enum NativeInspectionError {
    Absent,
    Failed(String),
}

impl NativeInspectionError {
    fn into_message(self) -> String {
        match self {
            Self::Absent => "process is absent".to_string(),
            Self::Failed(message) => message,
        }
    }
}
#[cfg(target_os = "linux")]
const LINUX_PROCESS_GONE_ERRNO: i32 = 3;

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub environment: BTreeMap<String, String>,
    pub stdio: String,
}

#[derive(Debug, Clone)]
pub struct ChildExit {
    pub code: Option<i32>,
    pub signal: Option<String>,
}

pub trait ManagedTarget {
    fn pid(&self) -> u32;
    fn start_identity(&self) -> &str;
    fn try_wait(&mut self) -> Result<Option<ChildExit>, String>;
    fn terminate(&mut self, grace_ms: u64, kill_ms: u64) -> Result<(), String>;
    fn handoff(&mut self) -> Result<(), String>;
    fn finish_cleanup(&mut self) -> Result<(), String>;
}

pub struct ControlReader {
    file: File,
    #[cfg(unix)]
    fd: i32,
    #[cfg(windows)]
    handle: isize,
}

pub struct ControlWriter {
    file: File,
}

impl Read for ControlReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.file.read(buffer)
    }
}

impl Write for ControlWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.file.write(buffer)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

pub fn open_control(
    in_value: Option<&str>,
    out_value: Option<&str>,
) -> Result<(ControlReader, ControlWriter), String> {
    #[cfg(unix)]
    {
        use std::os::fd::{FromRawFd, RawFd};
        let input = in_value
            .unwrap_or("3")
            .parse::<RawFd>()
            .map_err(|_| "invalid control input fd".to_string())?;
        let output = out_value
            .unwrap_or("4")
            .parse::<RawFd>()
            .map_err(|_| "invalid control output fd".to_string())?;
        if input < 0 || output < 0 || input == output {
            return Err("invalid control fd pair".to_string());
        }
        set_close_on_exec(input)?;
        set_close_on_exec(output)?;
        // SAFETY: the descriptors are inherited by this executable and ownership
        // is transferred to these File values exactly once.
        let input_file = unsafe { File::from_raw_fd(input) };
        let output_file = unsafe { File::from_raw_fd(output) };
        Ok((
            ControlReader {
                file: input_file,
                fd: input,
            },
            ControlWriter { file: output_file },
        ))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::FromRawHandle;
        // Node's extra stdio entries are inherited as CRT descriptors 3 and
        // 4. Resolve those descriptors in the native child so callers do not
        // need to discover or serialize platform-specific HANDLE values.
        // Explicit values remain accepted for low-level native probes.
        let input = windows::control_handle(in_value, 3, "input")?;
        let output = windows::control_handle(out_value, 4, "output")?;
        if input == output || input == 0 || output == 0 {
            return Err("invalid Windows control handle pair".to_string());
        }
        // SAFETY: handles are inherited by this executable and ownership is
        // transferred to these File values exactly once.
        let input_file = unsafe { File::from_raw_handle(input as *mut std::ffi::c_void) };
        let output_file = unsafe { File::from_raw_handle(output as *mut std::ffi::c_void) };
        Ok((
            ControlReader {
                file: input_file,
                handle: input as isize,
            },
            ControlWriter { file: output_file },
        ))
    }
}

pub fn wait_readable(reader: &ControlReader, timeout_ms: u32) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let mut pollfd = PollFd {
            fd: reader.fd,
            events: POLLIN | POLLHUP | POLLERR,
            revents: 0,
        };
        // SAFETY: pollfd points to one valid inherited descriptor.
        let result = unsafe { unix::poll(&mut pollfd, 1, timeout_ms as i32) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(format!("control poll failed: {error}"));
        }
        Ok(result > 0)
    }
    #[cfg(windows)]
    {
        let mut available = 0u32;
        // SAFETY: the handle is an inherited read end of an anonymous pipe.
        let result = unsafe {
            windows::PeekNamedPipe(
                reader.handle as *mut std::ffi::c_void,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if result != 0 {
            if available > 0 {
                return Ok(true);
            }
            std::thread::sleep(Duration::from_millis(u64::from(timeout_ms)));
            return Ok(false);
        }
        // A broken pipe is readable as EOF; let the frame reader observe it.
        Ok(true)
    }
}

pub fn self_pid() -> u32 {
    std::process::id()
}

pub fn self_start_identity() -> Result<String, String> {
    start_identity(self_pid())
}
pub fn inspect_process(pid: u32) -> Result<ProcessInspection, String> {
    if pid == 0 {
        return Err("inspect-process PID must be positive".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        return linux_inspect_process(pid);
    }
    #[cfg(target_os = "macos")]
    {
        return mac_inspect_process(pid);
    }
    #[cfg(windows)]
    {
        return win_inspect_process(pid);
    }
    #[allow(unreachable_code)]
    Err("unsupported process platform".to_string())
}

pub fn start_identity(pid: u32) -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        return linux_process_info(pid)
            .map(|info| info.start_identity)
            .map_err(NativeInspectionError::into_message);
    }
    #[cfg(target_os = "macos")]
    {
        return mac_start_identity(pid);
    }
    #[cfg(windows)]
    {
        return win_start_identity(pid);
    }
    #[allow(unreachable_code)]
    Err("unsupported process platform".to_string())
}

#[cfg(target_os = "linux")]
struct LinuxProcessInfo {
    ppid: u32,
    start_identity: String,
}

#[cfg(target_os = "linux")]
fn linux_process_info(pid: u32) -> Result<LinuxProcessInfo, NativeInspectionError> {
    let proc_dir = std::fs::metadata("/proc").map_err(|error| {
        NativeInspectionError::Failed(format!("could not inspect Linux process table: {error}"))
    })?;
    if !proc_dir.is_dir() {
        return Err(NativeInspectionError::Failed(
            "Linux process table is not a directory".to_string(),
        ));
    }
    std::fs::metadata("/proc/self/stat").map_err(|error| {
        NativeInspectionError::Failed(format!("could not inspect Linux process table: {error}"))
    })?;
    // A procfs race may report ESRCH instead of ENOENT while the PID exits.
    // Both outcomes mean that this process is gone; all other read failures
    // remain fatal so permission and procfs-integrity errors are not hidden.
    let contents = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(contents) => contents,
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                || error.raw_os_error() == Some(LINUX_PROCESS_GONE_ERRNO) =>
        {
            return Err(NativeInspectionError::Absent);
        }
        Err(error) => {
            return Err(NativeInspectionError::Failed(format!(
                "could not read Linux process information: {error}"
            )));
        }
    };
    let open = contents
        .find('(')
        .ok_or_else(|| NativeInspectionError::Failed("malformed /proc stat".to_string()))?;
    let close = contents
        .rfind(')')
        .ok_or_else(|| NativeInspectionError::Failed("malformed /proc stat".to_string()))?;
    if close <= open {
        return Err(NativeInspectionError::Failed(
            "malformed /proc stat".to_string(),
        ));
    }
    let stat_pid = contents[..open]
        .trim()
        .parse::<u32>()
        .map_err(|_| NativeInspectionError::Failed("invalid /proc process ID".to_string()))?;
    if stat_pid != pid {
        return Err(NativeInspectionError::Failed(
            "process ID changed while reading /proc stat".to_string(),
        ));
    }
    let mut fields = contents[close + 1..].split_whitespace();
    fields
        .next()
        .ok_or_else(|| NativeInspectionError::Failed("malformed /proc stat".to_string()))?;
    let ppid = fields
        .next()
        .ok_or_else(|| NativeInspectionError::Failed("missing process parent ID".to_string()))?
        .parse::<u32>()
        .map_err(|_| NativeInspectionError::Failed("invalid process parent ID".to_string()))?;
    // After state and ppid, starttime is the 18th remaining field (field 22).
    let ticks = fields
        .nth(17)
        .ok_or_else(|| NativeInspectionError::Failed("missing process start time".to_string()))?;
    ticks
        .parse::<u64>()
        .map_err(|_| NativeInspectionError::Failed("invalid process start time".to_string()))?;
    Ok(LinuxProcessInfo {
        ppid,
        start_identity: format!("linux:{ticks}"),
    })
}

#[cfg(target_os = "linux")]
fn linux_inspect_process(pid: u32) -> Result<ProcessInspection, String> {
    match linux_process_info(pid) {
        Ok(info) => Ok(ProcessInspection::Live {
            pid,
            ppid: info.ppid,
            start_identity: info.start_identity,
        }),
        Err(NativeInspectionError::Absent) => Ok(ProcessInspection::Absent),
        Err(error) => Err(error.into_message()),
    }
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct MacProcBsdInfo {
    flags: u32,
    status: u32,
    xstatus: u32,
    pid: u32,
    ppid: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    rfu_1: u32,
    comm: [u8; 16],
    name: [u8; 32],
    nfiles: u32,
    pgid: u32,
    pjobc: u32,
    e_tdev: u32,
    e_tpgid: u32,
    nice: i32,
    start_tvsec: u64,
    start_tvusec: u64,
}

#[cfg(target_os = "macos")]
struct MacProcessInfo {
    ppid: u32,
    start_identity: String,
}

#[cfg(target_os = "macos")]
fn mac_process_info(pid: u32) -> Result<MacProcessInfo, NativeInspectionError> {
    if pid > i32::MAX as u32 {
        return Err(NativeInspectionError::Failed(
            "macOS process ID is outside the native range".to_string(),
        ));
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: u32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }
    const PROC_PIDTBSDINFO: u32 = 3;
    let mut info = std::mem::MaybeUninit::<MacProcBsdInfo>::zeroed();
    let expected = std::mem::size_of::<MacProcBsdInfo>() as i32;
    // SAFETY: proc_pidinfo writes at most the exact buffer size supplied.
    let bytes = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            expected,
        )
    };
    if bytes != expected {
        if bytes <= 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(3) {
                return Err(NativeInspectionError::Absent);
            }
            return Err(NativeInspectionError::Failed(format!(
                "could not read macOS process information: {error}"
            )));
        }
        return Err(NativeInspectionError::Failed(format!(
            "malformed macOS process information ({bytes} bytes)"
        )));
    }
    // SAFETY: proc_pidinfo filled the complete struct above.
    let info = unsafe { info.assume_init() };
    let _ = (
        &info.flags,
        &info.status,
        &info.xstatus,
        &info.uid,
        &info.gid,
        &info.ruid,
        &info.rgid,
        &info.svuid,
        &info.svgid,
        &info.rfu_1,
        &info.comm,
        &info.name,
        &info.nfiles,
        &info.pgid,
        &info.pjobc,
        &info.e_tdev,
        &info.e_tpgid,
        &info.nice,
    );
    if info.pid != pid {
        return Err(NativeInspectionError::Failed(
            "process ID changed while reading macOS process information".to_string(),
        ));
    }
    Ok(MacProcessInfo {
        ppid: info.ppid,
        start_identity: format!("macos:{}:{}", info.start_tvsec, info.start_tvusec),
    })
}

#[cfg(target_os = "macos")]
fn mac_start_identity(pid: u32) -> Result<String, String> {
    mac_process_info(pid)
        .map(|info| info.start_identity)
        .map_err(NativeInspectionError::into_message)
}

#[cfg(target_os = "macos")]
fn mac_inspect_process(pid: u32) -> Result<ProcessInspection, String> {
    match mac_process_info(pid) {
        Ok(info) => Ok(ProcessInspection::Live {
            pid,
            ppid: info.ppid,
            start_identity: info.start_identity,
        }),
        Err(NativeInspectionError::Absent) => Ok(ProcessInspection::Absent),
        Err(error) => Err(error.into_message()),
    }
}
pub fn private_path(arguments: &[String]) -> Result<(), String> {
    #[cfg(windows)]
    {
        return windows::private_path(arguments);
    }
    #[cfg(not(windows))]
    {
        let _ = arguments;
        Err(format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: private path is only supported on Windows"))
    }
}
pub fn spawn_target(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
    validate_spec(spec)?;
    #[cfg(unix)]
    {
        return unix_spawn_target(spec);
    }
    #[cfg(windows)]
    {
        return win_spawn_target(spec);
    }
    #[allow(unreachable_code)]
    Err(PROCESS_CONTAINMENT_UNAVAILABLE.to_string())
}

pub fn spawn_detached(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
    validate_spec(spec)?;
    #[cfg(unix)]
    {
        return unix_spawn_detached(spec);
    }
    #[cfg(windows)]
    {
        return win_spawn_detached(spec);
    }
    #[allow(unreachable_code)]
    Err(PROCESS_CONTAINMENT_UNAVAILABLE.to_string())
}

pub fn close_wrapper_stdio() {
    #[cfg(unix)]
    {
        for fd in [0, 1, 2] {
            // SAFETY: closing the wrapper's inherited data-plane descriptors is
            // intentional; the target inherited them before this call.
            unsafe { unix::close(fd) };
        }
    }
    #[cfg(windows)]
    {
        for handle in [
            windows::STD_INPUT_HANDLE,
            windows::STD_OUTPUT_HANDLE,
            windows::STD_ERROR_HANDLE,
        ] {
            // SAFETY: standard handles belong to this wrapper and are no longer
            // needed after the target inherited them.
            unsafe {
                let value = windows::GetStdHandle(handle);
                if !value.is_null() && value != windows::INVALID_HANDLE_VALUE {
                    windows::CloseHandle(value);
                }
            }
        }
    }
}

fn validate_spec(spec: &SpawnSpec) -> Result<(), String> {
    if spec.executable.is_empty() || spec.executable.contains('\0') {
        return Err("executable must be nonempty and NUL-free".to_string());
    }
    if !Path::new(&spec.executable).is_absolute() {
        return Err("executable must be absolute".to_string());
    }
    if spec.cwd.is_empty() || spec.cwd.contains('\0') || !Path::new(&spec.cwd).is_absolute() {
        return Err("cwd must be an absolute path".to_string());
    }
    if !Path::new(&spec.cwd).is_dir() {
        return Err("cwd is not an existing directory".to_string());
    }
    if spec.stdio != "pipes" && spec.stdio != "ignore" {
        return Err("stdio must be pipes or ignore".to_string());
    }
    if spec.args.len() > 4096 {
        return Err("too many process arguments".to_string());
    }
    let mut bytes = spec.executable.len() + spec.cwd.len();
    for argument in &spec.args {
        if argument.contains('\0') {
            return Err("argument contains NUL".to_string());
        }
        bytes = bytes.saturating_add(argument.len());
        if bytes > 512 * 1024 {
            return Err("process arguments exceed 512 KiB".to_string());
        }
    }
    if spec.environment.len() > 4096 {
        return Err("too many environment entries".to_string());
    }
    for (key, value) in &spec.environment {
        if key.is_empty() || key.contains(['=', '\0']) || value.contains('\0') {
            return Err("invalid process environment".to_string());
        }
        bytes = bytes.saturating_add(key.len()).saturating_add(value.len());
        if bytes > 2 * 1024 * 1024 {
            return Err("process environment exceeds 2 MiB".to_string());
        }
    }
    Ok(())
}
#[cfg(any(windows, test))]
fn terminate_with_grace<Request, Wait, Escalate>(
    grace_ms: u64,
    kill_ms: u64,
    mut request_graceful: Request,
    mut wait_for_exit: Wait,
    mut escalate: Escalate,
    timeout_message: &str,
) -> Result<(), String>
where
    Request: FnMut(),
    Wait: FnMut(u64) -> Result<bool, String>,
    Escalate: FnMut() -> Result<(), String>,
{
    request_graceful();
    if wait_for_exit(grace_ms)? {
        return Ok(());
    }
    escalate()?;
    if wait_for_exit(kill_ms)? {
        return Ok(());
    }
    Err(timeout_message.to_string())
}
#[cfg(test)]
mod tests {
    use super::terminate_with_grace;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[test]
    fn graceful_shutdown_waits_before_hard_escalation() {
        let events: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let request_events = Rc::clone(&events);
        let wait_events = Rc::clone(&events);
        let escalate_events = Rc::clone(&events);
        let mut waits = 0;
        let result = terminate_with_grace(
            25,
            50,
            move || request_events.borrow_mut().push("request".to_string()),
            move |timeout| {
                wait_events.borrow_mut().push(timeout.to_string());
                waits += 1;
                Ok(waits == 2)
            },
            move || {
                escalate_events.borrow_mut().push("escalate".to_string());
                Ok(())
            },
            "timed out",
        );
        assert_eq!(result, Ok(()));
        assert_eq!(
            *events.borrow(),
            vec!["request", "25", "escalate", "50"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn graceful_shutdown_does_not_escalate_after_group_drains() {
        let events: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));
        let request_events = Rc::clone(&events);
        let wait_events = Rc::clone(&events);
        let escalate_events = Rc::clone(&events);
        let result = terminate_with_grace(
            25,
            50,
            move || request_events.borrow_mut().push("request".to_string()),
            move |timeout| {
                wait_events.borrow_mut().push(timeout.to_string());
                Ok(true)
            },
            move || {
                escalate_events.borrow_mut().push("escalate".to_string());
                Ok(())
            },
            "timed out",
        );
        assert_eq!(result, Ok(()));
        assert_eq!(
            *events.borrow(),
            vec!["request", "25"]
                .into_iter()
                .map(String::from)
                .collect::<Vec<_>>()
        );
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::ffi::{c_long, c_void};
    use std::io::{ErrorKind, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    const SIGTERM: i32 = 15;
    const SIGKILL: i32 = 9;
    #[cfg(target_os = "macos")]
    const SIGCHLD: i32 = 20;
    #[cfg(not(target_os = "macos"))]
    const SIGCHLD: i32 = 17;
    const PR_SET_PDEATHSIG: i32 = 1;
    #[cfg(target_os = "linux")]
    const PR_SET_CHILD_SUBREAPER: i32 = 36;
    const PRIVATE_MAX_STRING: u32 = 2 * 1024 * 1024;
    const PRIVATE_MAX_ITEMS: u32 = 65_536;
    const F_GETFD: i32 = 1;
    const F_SETFD: i32 = 2;
    const FD_CLOEXEC: i32 = 1;
    pub(super) const POLLIN: i16 = 1;
    pub(super) const POLLERR: i16 = 8;
    pub(super) const POLLHUP: i16 = 16;
    const ESRCH: i32 = 3;
    #[cfg(target_os = "linux")]
    const ECHILD: i32 = 10;
    const MONITOR_GRACE_MS: u64 = 1_000;
    const MONITOR_KILL_MS: u64 = 2_000;

    #[repr(C)]
    pub(super) struct PollFd {
        pub(super) fd: RawFd,
        pub(super) events: i16,
        pub(super) revents: i16,
    }

    #[cfg(target_os = "linux")]
    #[repr(C, align(8))]
    struct LinuxSigInfo {
        si_signo: i32,
        si_errno: i32,
        si_code: i32,
        _pad: i32,
        si_pid: i32,
        si_uid: u32,
        si_status: i32,
        _rest: [u8; 100],
    }

    #[cfg(target_os = "macos")]
    #[repr(C, align(8))]
    struct DarwinSigInfo {
        si_signo: i32,
        si_errno: i32,
        si_code: i32,
        si_pid: i32,
        si_uid: u32,
        si_status: i32,
        si_addr: *mut c_void,
        si_value: [u8; 8],
        si_band: i64,
        _pad: [u64; 7],
    }

    #[cfg(target_os = "linux")]
    const WAITID_P_ALL: i32 = 0;
    #[cfg(target_os = "linux")]
    const WAITID_WNOWAIT: i32 = 0x0100_0000;
    #[cfg(target_os = "macos")]
    const WAITID_WNOWAIT: i32 = 0x0000_0020;
    const WAITID_WEXITED: i32 = 0x0000_0004;
    const WAITID_WNOHANG: i32 = 0x0000_0001;
    const WAITID_P_PID: i32 = 1;
    const CLD_EXITED: i32 = 1;
    const CLD_KILLED: i32 = 2;
    const CLD_DUMPED: i32 = 3;

    unsafe extern "C" {
        pub(super) fn close(fd: i32) -> i32;
        fn fcntl(fd: RawFd, command: i32, ...) -> i32;
        fn getpgid(pid: i32) -> i32;
        fn getsid(pid: i32) -> i32;
        fn getppid() -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
        fn pipe(fds: *mut RawFd) -> i32;
        pub(super) fn poll(fds: *mut PollFd, count: usize, timeout: i32) -> i32;
        fn setsid() -> i32;
        fn signal(signal: i32, handler: *mut c_void) -> *mut c_void;
        #[cfg(target_os = "linux")]
        fn prctl(option: i32, ...) -> i32;
    }

    #[cfg(target_os = "linux")]
    unsafe extern "C" {
        fn syscall(number: c_long, ...) -> c_long;
        fn waitid(id_type: i32, id: u32, info: *mut LinuxSigInfo, options: i32) -> i32;
    }

    #[cfg(target_os = "macos")]
    unsafe extern "C" {
        fn waitid(id_type: i32, id: u32, info: *mut DarwinSigInfo, options: i32) -> i32;
    }

    #[cfg(target_os = "macos")]
    #[link(name = "proc")]
    unsafe extern "C" {
        fn proc_listpids(
            process_type: u32,
            type_info: u32,
            buffer: *mut c_void,
            buffer_size: i32,
        ) -> i32;
    }

    struct Monitor {
        child: Child,
        lifetime: Option<File>,
        exit_reader: File,
        pid: u32,
        identity: String,
    }

    struct MonitorStartup {
        target_pid: u32,
        target_identity: String,
        target_pgid: i32,
        target_sid: i32,
        monitor_pid: u32,
        monitor_identity: String,
        monitor_pgid: i32,
        monitor_sid: i32,
    }

    const LIFETIME_HANDOFF: u8 = 1;
    const EXIT_HANDOFF_COMMITTED: u8 = 3;

    enum LifetimeEvent {
        Open,
        Closed,
        Handoff,
    }

    enum MonitorEvent {
        Exit(ChildExit),
        HandoffCommitted,
    }

    struct GroupMember {
        pid: u32,
    }

    pub(super) struct UnixTarget {
        monitor: Monitor,
        pid: u32,
        pgid: i32,
        sid: i32,
        identity: String,
        exited: Option<ChildExit>,
        cleaned: bool,
    }

    pub(super) fn spawn_target(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
        spawn_monitored(spec)
    }

    pub(super) fn spawn_detached(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
        spawn_monitored(spec)
    }

    fn command_for_spec(spec: &SpawnSpec) -> Command {
        let mut command = Command::new(&spec.executable);
        command
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.environment.iter())
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        command
    }

    fn spawn_monitored(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
        let (spec_read, mut spec_write) = private_pipe()?;
        let (mut startup_read, startup_write) = private_pipe()?;
        let (exit_read, exit_write) = private_pipe()?;
        let (lifetime_read, lifetime_write) = private_pipe()?;

        let spec_fd = spec_read.as_raw_fd();
        let startup_fd = startup_write.as_raw_fd();
        let exit_fd = exit_write.as_raw_fd();
        let lifetime_fd = lifetime_read.as_raw_fd();
        set_close_on_exec(spec_write.as_raw_fd())?;
        clear_close_on_exec(spec_read.as_raw_fd())?;
        set_close_on_exec(startup_read.as_raw_fd())?;
        clear_close_on_exec(startup_write.as_raw_fd())?;
        set_close_on_exec(exit_read.as_raw_fd())?;
        clear_close_on_exec(exit_write.as_raw_fd())?;
        set_close_on_exec(lifetime_write.as_raw_fd())?;
        clear_close_on_exec(lifetime_read.as_raw_fd())?;

        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        #[cfg(test)]
        let executable = executable
            .parent()
            .and_then(Path::parent)
            .map(|directory| directory.join("alder-process-supervisor"))
            .filter(|candidate| candidate.is_file())
            .unwrap_or(executable);
        let mut monitor_child = Command::new(executable)
            .arg("--anchor")
            .arg(spec_fd.to_string())
            .arg(startup_fd.to_string())
            .arg(exit_fd.to_string())
            .arg(lifetime_fd.to_string())
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: monitor failed: {error}")
            })?;

        drop(spec_read);
        drop(startup_write);
        drop(exit_write);
        drop(lifetime_read);
        if let Err(error) = write_spawn_spec(&mut spec_write, spec) {
            drop(lifetime_write);
            let _ = monitor_child.wait();
            return Err(format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: {error}"));
        }
        drop(spec_write);
        let startup = match read_startup(&mut startup_read) {
            Ok(startup) => startup,
            Err(error) => {
                drop(lifetime_write);
                let _ = monitor_child.wait();
                return Err(format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: {error}"));
            }
        };
        drop(startup_read);
        let monitor_pid = monitor_child.id();
        if startup.monitor_pid != monitor_pid {
            drop(lifetime_write);
            let _ = monitor_child.wait();
            return Err(format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: monitor PID changed during startup"
            ));
        }
        let monitor_pgid = startup.monitor_pgid;
        let monitor_sid = startup.monitor_sid;
        let mut target = UnixTarget {
            monitor: Monitor {
                child: monitor_child,
                lifetime: Some(lifetime_write),
                exit_reader: exit_read,
                pid: startup.monitor_pid,
                identity: startup.monitor_identity,
            },
            pid: startup.target_pid,
            pgid: startup.target_pgid,
            sid: startup.target_sid,
            identity: startup.target_identity,
            exited: None,
            cleaned: false,
        };
        if let Err(error) = verify_monitored_target(&target, monitor_pgid, monitor_sid) {
            let cleanup_error = target.finish_cleanup().err();
            return Err(cleanup_error.map_or_else(
                || format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: {error}"),
                |cleanup| {
                    format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: {error}; cleanup failed: {cleanup}")
                },
            ));
        }
        Ok(Box::new(target))
    }

    fn process_group_ids(pid: u32) -> Result<(i32, i32), String> {
        let pgid = unsafe { getpgid(pid as i32) };
        if pgid < 0 {
            return Err(format!(
                "could not inspect process group: {}",
                std::io::Error::last_os_error()
            ));
        }
        let sid = unsafe { getsid(pid as i32) };
        if sid < 0 {
            return Err(format!(
                "could not inspect process session: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok((pgid, sid))
    }

    fn verify_monitored_target(
        target: &UnixTarget,
        monitor_pgid: i32,
        monitor_sid: i32,
    ) -> Result<(), String> {
        let monitor = &target.monitor;
        if target.pid == 0 || target.pgid != target.pid as i32 || target.sid != target.pid as i32 {
            return Err("monitor reported an invalid target session topology".to_string());
        }
        if monitor.pid == 0 || monitor.pid == target.pid {
            return Err("monitor reported an invalid monitor identity".to_string());
        }
        if monitor_pgid <= 0
            || monitor_sid <= 0
            || monitor_pgid == target.pgid
            || monitor_sid == target.sid
        {
            return Err("monitor is not outside the target session".to_string());
        }
        verify_identity(monitor.pid, &monitor.identity, "monitor")?;
        let (actual_monitor_pgid, actual_monitor_sid) = process_group_ids(monitor.pid)?;
        if actual_monitor_pgid != monitor_pgid || actual_monitor_sid != monitor_sid {
            return Err("monitor process session changed during startup".to_string());
        }
        verify_identity(target.pid, &target.identity, "target")?;
        let (pgid, sid) = process_group_ids(target.pid)?;
        if pgid != target.pgid || sid != target.sid {
            return Err("target process session changed during startup".to_string());
        }
        let monitor_pid = monitor.pid;
        match inspect_process(target.pid)? {
            ProcessInspection::Live {
                ppid,
                start_identity,
                ..
            } if ppid == monitor_pid && start_identity == target.identity => Ok(()),
            ProcessInspection::Live { ppid, .. } => Err(format!(
                "target is not the monitor's direct child (parent {ppid})"
            )),
            ProcessInspection::Absent => Err("target disappeared during startup".to_string()),
        }
    }

    fn libc_esrch() -> i32 {
        ESRCH
    }

    fn reset_sigchld() -> Result<(), String> {
        // SAFETY: SIG_DFL is represented by a null handler on Unix.
        let previous = unsafe { signal(SIGCHLD, std::ptr::null_mut()) };
        if previous == (-1isize as *mut c_void) {
            return Err(format!(
                "could not reset SIGCHLD disposition: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn private_pipe() -> Result<(File, File), String> {
        let mut fds = [-1, -1];
        // SAFETY: fds points to two writable RawFd slots.
        if unsafe { pipe(fds.as_mut_ptr()) } < 0 {
            return Err(format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: private pipe failed"
            ));
        }
        // SAFETY: each descriptor is transferred to exactly one File value.
        Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
    }

    pub(super) fn set_close_on_exec(fd: RawFd) -> Result<(), String> {
        let flags = unsafe { fcntl(fd, F_GETFD) };
        if flags < 0 || unsafe { fcntl(fd, F_SETFD, flags | FD_CLOEXEC) } < 0 {
            return Err(format!(
                "could not set close-on-exec on fd {fd}: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn clear_close_on_exec(fd: RawFd) -> Result<(), String> {
        let flags = unsafe { fcntl(fd, F_GETFD) };
        if flags < 0 || unsafe { fcntl(fd, F_SETFD, flags & !FD_CLOEXEC) } < 0 {
            return Err(format!(
                "could not clear close-on-exec on fd {fd}: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn write_u32(writer: &mut File, value: u32) -> Result<(), String> {
        writer
            .write_all(&value.to_le_bytes())
            .map_err(|error| format!("private frame write failed: {error}"))
    }

    fn read_u32(reader: &mut File) -> Result<u32, String> {
        let mut bytes = [0u8; 4];
        reader
            .read_exact(&mut bytes)
            .map_err(|error| format!("private frame read failed: {error}"))?;
        Ok(u32::from_le_bytes(bytes))
    }

    fn write_i32(writer: &mut File, value: i32) -> Result<(), String> {
        writer
            .write_all(&value.to_le_bytes())
            .map_err(|error| format!("private frame write failed: {error}"))
    }

    fn read_i32(reader: &mut File) -> Result<i32, String> {
        let mut bytes = [0u8; 4];
        reader
            .read_exact(&mut bytes)
            .map_err(|error| format!("private frame read failed: {error}"))?;
        Ok(i32::from_le_bytes(bytes))
    }

    fn write_string(writer: &mut File, value: &str) -> Result<(), String> {
        let bytes = value.as_bytes();
        if bytes.len() > PRIVATE_MAX_STRING as usize {
            return Err("private frame string exceeds 2 MiB".to_string());
        }
        write_u32(writer, bytes.len() as u32)?;
        writer
            .write_all(bytes)
            .map_err(|error| format!("private frame write failed: {error}"))
    }

    fn read_string(reader: &mut File) -> Result<String, String> {
        let length = read_u32(reader)?;
        if length > PRIVATE_MAX_STRING {
            return Err("private frame string exceeds 2 MiB".to_string());
        }
        let mut bytes = vec![0u8; length as usize];
        reader
            .read_exact(&mut bytes)
            .map_err(|error| format!("private frame read failed: {error}"))?;
        String::from_utf8(bytes).map_err(|_| "private frame contained invalid UTF-8".to_string())
    }

    fn write_spawn_spec(writer: &mut File, spec: &SpawnSpec) -> Result<(), String> {
        write_string(writer, &spec.executable)?;
        write_string(writer, &spec.cwd)?;
        write_string(writer, &spec.stdio)?;
        if spec.args.len() > PRIVATE_MAX_ITEMS as usize {
            return Err("private frame argument count exceeds limit".to_string());
        }
        write_u32(writer, spec.args.len() as u32)?;
        for argument in &spec.args {
            write_string(writer, argument)?;
        }
        if spec.environment.len() > PRIVATE_MAX_ITEMS as usize {
            return Err("private frame environment count exceeds limit".to_string());
        }
        write_u32(writer, spec.environment.len() as u32)?;
        for (key, value) in &spec.environment {
            write_string(writer, key)?;
            write_string(writer, value)?;
        }
        Ok(())
    }

    fn read_spawn_spec(reader: &mut File) -> Result<SpawnSpec, String> {
        let executable = read_string(reader)?;
        let cwd = read_string(reader)?;
        let stdio = read_string(reader)?;
        let argument_count = read_u32(reader)?;
        if argument_count > PRIVATE_MAX_ITEMS {
            return Err("private frame argument count exceeds limit".to_string());
        }
        let mut args = Vec::with_capacity(argument_count as usize);
        for _ in 0..argument_count {
            args.push(read_string(reader)?);
        }
        let environment_count = read_u32(reader)?;
        if environment_count > PRIVATE_MAX_ITEMS {
            return Err("private frame environment count exceeds limit".to_string());
        }
        let mut environment = BTreeMap::new();
        for _ in 0..environment_count {
            environment.insert(read_string(reader)?, read_string(reader)?);
        }
        let spec = SpawnSpec {
            executable,
            args,
            cwd,
            environment,
            stdio,
        };
        validate_spec(&spec)?;
        Ok(spec)
    }

    fn write_startup_error(writer: &mut File, error: &str) -> Result<(), String> {
        writer
            .write_all(&[0])
            .map_err(|write_error| format!("private startup write failed: {write_error}"))?;
        write_string(writer, error)
    }

    fn write_startup_success(
        writer: &mut File,
        target_pid: u32,
        target_identity: &str,
        target_pgid: i32,
        target_sid: i32,
        monitor_pid: u32,
        monitor_identity: &str,
        monitor_pgid: i32,
        monitor_sid: i32,
    ) -> Result<(), String> {
        writer
            .write_all(&[1])
            .map_err(|error| format!("private startup write failed: {error}"))?;
        write_u32(writer, target_pid)?;
        write_i32(writer, target_pgid)?;
        write_i32(writer, target_sid)?;
        write_u32(writer, monitor_pid)?;
        write_i32(writer, monitor_pgid)?;
        write_i32(writer, monitor_sid)?;
        write_string(writer, target_identity)?;
        write_string(writer, monitor_identity)
    }

    fn read_startup(reader: &mut File) -> Result<MonitorStartup, String> {
        let mut kind = [0u8; 1];
        reader
            .read_exact(&mut kind)
            .map_err(|error| format!("private startup read failed: {error}"))?;
        match kind[0] {
            0 => Err(read_string(reader)?),
            1 => Ok(MonitorStartup {
                target_pid: read_u32(reader)?,
                target_pgid: read_i32(reader)?,
                target_sid: read_i32(reader)?,
                monitor_pid: read_u32(reader)?,
                monitor_pgid: read_i32(reader)?,
                monitor_sid: read_i32(reader)?,
                target_identity: read_string(reader)?,
                monitor_identity: read_string(reader)?,
            }),
            _ => Err("private startup frame had an unknown kind".to_string()),
        }
    }

    fn write_exit(writer: &mut File, exit: &ChildExit) -> Result<(), String> {
        match (exit.code, exit.signal.as_deref()) {
            (Some(code), None) => {
                writer
                    .write_all(&[0])
                    .map_err(|error| format!("private exit write failed: {error}"))?;
                write_i32(writer, code)
            }
            (None, Some(signal)) => {
                let value = signal
                    .strip_prefix("SIG")
                    .ok_or_else(|| "private exit signal had an invalid name".to_string())?
                    .parse::<i32>()
                    .map_err(|_| "private exit signal had an invalid number".to_string())?;
                writer
                    .write_all(&[1])
                    .map_err(|error| format!("private exit write failed: {error}"))?;
                write_i32(writer, value)
            }
            (None, None) => {
                writer
                    .write_all(&[2])
                    .map_err(|error| format!("private exit write failed: {error}"))?;
                write_i32(writer, 0)
            }
            _ => Err("private exit frame had an invalid status".to_string()),
        }
    }

    fn write_handoff_ack(writer: &mut File) -> Result<(), String> {
        writer
            .write_all(&[EXIT_HANDOFF_COMMITTED])
            .map_err(|error| format!("private handoff write failed: {error}"))?;
        write_i32(writer, 0)
    }

    fn read_monitor_event(reader: &mut File) -> Result<MonitorEvent, String> {
        let mut kind = [0u8; 1];
        reader
            .read_exact(&mut kind)
            .map_err(|error| format!("private exit read failed: {error}"))?;
        let value = read_i32(reader)?;
        match kind[0] {
            0 => Ok(MonitorEvent::Exit(ChildExit {
                code: Some(value),
                signal: None,
            })),
            1 if value > 0 => Ok(MonitorEvent::Exit(ChildExit {
                code: None,
                signal: Some(format!("SIG{value}")),
            })),
            2 => Ok(MonitorEvent::Exit(ChildExit {
                code: None,
                signal: None,
            })),
            EXIT_HANDOFF_COMMITTED if value == 0 => Ok(MonitorEvent::HandoffCommitted),
            _ => Err("private exit frame had an unknown status".to_string()),
        }
    }

    fn read_exit(reader: &mut File) -> Result<ChildExit, String> {
        match read_monitor_event(reader)? {
            MonitorEvent::Exit(exit) => Ok(exit),
            MonitorEvent::HandoffCommitted => {
                Err("private exit frame reported an unexpected handoff".to_string())
            }
        }
    }

    fn wait_fd(fd: RawFd, timeout_ms: u32) -> Result<bool, String> {
        let mut pollfd = PollFd {
            fd,
            events: POLLIN | POLLHUP | POLLERR,
            revents: 0,
        };
        // SAFETY: pollfd points to one valid inherited descriptor.
        let result = unsafe { poll(&mut pollfd, 1, timeout_ms as i32) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                return Ok(false);
            }
            return Err(format!("private poll failed: {error}"));
        }
        Ok(result > 0)
    }

    fn drain_lifetime(reader: &mut File) -> Result<LifetimeEvent, String> {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte) {
            Ok(0) => Ok(LifetimeEvent::Closed),
            Ok(_) if byte[0] == LIFETIME_HANDOFF => Ok(LifetimeEvent::Handoff),
            Ok(_) => Err("lifetime pipe had an unknown signal".to_string()),
            Err(error) if error.kind() == ErrorKind::Interrupted => Ok(LifetimeEvent::Open),
            Err(error) => Err(format!("lifetime pipe read failed: {error}")),
        }
    }

    fn verify_identity(pid: u32, expected: &str, label: &str) -> Result<(), String> {
        match inspect_process(pid)? {
            ProcessInspection::Live { start_identity, .. } if start_identity == expected => Ok(()),
            ProcessInspection::Live { .. } => Err(format!(
                "owned {label} identity changed; refusing unrelated process"
            )),
            ProcessInspection::Absent => Err(format!("owned {label} disappeared")),
        }
    }

    fn group_members(pgid: i32, sid: i32) -> Result<Vec<GroupMember>, String> {
        if pgid <= 0 || sid <= 0 {
            return Err("invalid owned process group/session".to_string());
        }
        #[cfg(target_os = "macos")]
        {
            let mut pids = vec![0i32; 1024];
            loop {
                let bytes = unsafe {
                    proc_listpids(
                        1,
                        0,
                        pids.as_mut_ptr() as *mut c_void,
                        (pids.len() * std::mem::size_of::<i32>()) as i32,
                    )
                };
                if bytes < 0 {
                    return Err(format!(
                        "could not inspect macOS process table: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                let bytes = bytes as usize;
                if bytes % std::mem::size_of::<i32>() != 0 {
                    return Err("malformed macOS process table result".to_string());
                }
                let count = bytes / std::mem::size_of::<i32>();
                if count > pids.len() {
                    return Err("macOS process table result exceeded buffer".to_string());
                }
                if count == pids.len() {
                    if pids.len() > 1_000_000 {
                        return Err("macOS process table is too large".to_string());
                    }
                    pids.resize(pids.len() * 2, 0);
                    continue;
                }
                let mut members = Vec::new();
                for &raw_pid in &pids[..count] {
                    if raw_pid <= 0 {
                        continue;
                    }
                    let pid = raw_pid as u32;
                    let current_pgid = unsafe { getpgid(raw_pid) };
                    if current_pgid < 0 {
                        let error = std::io::Error::last_os_error();
                        if error.raw_os_error() == Some(ESRCH) {
                            continue;
                        }
                        return Err(format!("could not inspect macOS process group: {error}"));
                    }
                    let current_sid = unsafe { getsid(raw_pid) };
                    if current_sid < 0 {
                        let error = std::io::Error::last_os_error();
                        if error.raw_os_error() == Some(ESRCH) {
                            continue;
                        }
                        return Err(format!("could not inspect macOS process session: {error}"));
                    }
                    if current_pgid != pgid || current_sid != sid {
                        continue;
                    }
                    members.push(GroupMember { pid });
                }
                return Ok(members);
            }
        }
        #[cfg(target_os = "linux")]
        {
            std::fs::metadata("/proc/self/stat")
                .map_err(|error| format!("could not inspect Unix process table: {error}"))?;
            let entries = std::fs::read_dir("/proc")
                .map_err(|error| format!("could not inspect Unix process table: {error}"))?;
            let mut members = Vec::new();
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!("could not inspect Unix process table entry: {error}")
                })?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.bytes().all(|byte| byte.is_ascii_digit()) {
                    continue;
                }
                let pid = match name.parse::<u32>() {
                    Ok(pid) if pid > 0 => pid,
                    _ => return Err("invalid Unix process ID in process table".to_string()),
                };
                let contents = match std::fs::read_to_string(entry.path().join("stat")) {
                    Ok(contents) => contents,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(format!("could not read Unix process information: {error}"));
                    }
                };
                let open = contents
                    .find('(')
                    .ok_or_else(|| "malformed Unix process stat".to_string())?;
                let close = contents
                    .rfind(')')
                    .ok_or_else(|| "malformed Unix process stat".to_string())?;
                if close <= open {
                    return Err("malformed Unix process stat".to_string());
                }
                let stat_pid = contents[..open]
                    .trim()
                    .parse::<u32>()
                    .map_err(|_| "invalid Unix process ID".to_string())?;
                if stat_pid != pid {
                    return Err("process ID changed while reading Unix process stat".to_string());
                }
                let mut fields = contents[close + 1..].split_whitespace();
                fields
                    .next()
                    .ok_or_else(|| "malformed Unix process stat".to_string())?;
                fields
                    .next()
                    .ok_or_else(|| "missing Unix process parent ID".to_string())?;
                let current_pgid = fields
                    .next()
                    .ok_or_else(|| "missing Unix process group".to_string())?
                    .parse::<i32>()
                    .map_err(|_| "invalid Unix process group".to_string())?;
                let current_sid = fields
                    .next()
                    .ok_or_else(|| "missing Unix process session".to_string())?
                    .parse::<i32>()
                    .map_err(|_| "invalid Unix process session".to_string())?;
                if current_pgid != pgid || current_sid != sid {
                    continue;
                }
                members.push(GroupMember { pid });
            }
            Ok(members)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (pgid, sid);
            Err("unsupported Unix process membership inspection".to_string())
        }
    }

    fn group_has_members(pgid: i32, sid: i32, excluded_pid: Option<u32>) -> Result<bool, String> {
        Ok(group_members(pgid, sid)?
            .into_iter()
            .any(|member| Some(member.pid) != excluded_pid))
    }

    fn owned_group_empty(
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        target_exited: bool,
    ) -> Result<bool, String> {
        if !target_exited {
            verify_identity(target_pid, target_identity, "target")?;
            let (current_pgid, current_sid) = process_group_ids(target_pid)?;
            if current_pgid != pgid || current_sid != sid {
                return Err("owned target process session changed".to_string());
            }
        }
        Ok(!group_has_members(pgid, sid, Some(target_pid))?)
    }

    fn signal_group(
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        target_exited: bool,
        signal: i32,
    ) -> Result<(), String> {
        if !target_exited {
            verify_identity(target_pid, target_identity, "target")?;
            let (current_pgid, current_sid) = process_group_ids(target_pid)?;
            if current_pgid != pgid || current_sid != sid {
                return Err("owned target process session changed; refusing signal".to_string());
            }
        }
        let members = group_members(pgid, sid)?;
        if !target_exited && !members.iter().any(|member| member.pid == target_pid) {
            return Err("owned target is missing from its process group".to_string());
        }
        // SAFETY: the negative PGID targets exactly the private session created
        // by the target. The monitor is in a separate process group/session.
        if unsafe { kill(-pgid, signal) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ESRCH)
                && owned_group_empty(pgid, sid, target_pid, target_identity, target_exited)?
            {
                return Ok(());
            }
            return Err(format!("could not signal owned process group: {error}"));
        }
        Ok(())
    }
    #[cfg(target_os = "linux")]
    #[derive(Clone)]
    struct LinuxDirectChild {
        pid: u32,
        identity: String,
    }

    #[cfg(target_os = "linux")]
    const SYS_PIDFD_SEND_SIGNAL: c_long = 424;
    #[cfg(target_os = "linux")]
    const SYS_PIDFD_OPEN: c_long = 434;
    #[cfg(target_os = "linux")]
    const LINUX_EINVAL: i32 = 22;
    #[cfg(target_os = "linux")]
    const LINUX_ENOSYS: i32 = 38;

    #[cfg(target_os = "linux")]
    fn linux_pidfd_signal(
        pid: u32,
        expected_identity: &str,
        signal: i32,
    ) -> Result<Option<bool>, String> {
        // Open the pidfd first, then revalidate procfs identity and parent
        // while that descriptor pins the process. This closes the PID-reuse
        // window between the initial scan and pidfd_send_signal.
        let pidfd = unsafe { syscall(SYS_PIDFD_OPEN, pid as c_long, 0) };
        if pidfd < 0 {
            let error = std::io::Error::last_os_error();
            return match error.raw_os_error() {
                Some(LINUX_EINVAL | LINUX_ENOSYS) => Ok(None),
                Some(ESRCH) => Ok(Some(false)),
                _ => Err(format!("could not open process handle for {pid}: {error}")),
            };
        }
        let info = match super::linux_process_info(pid) {
            Ok(info) => info,
            Err(NativeInspectionError::Absent) => {
                unsafe { close(pidfd as RawFd) };
                return Ok(Some(false));
            }
            Err(error) => {
                unsafe { close(pidfd as RawFd) };
                return Err(error.into_message());
            }
        };
        if info.ppid != self_pid() || info.start_identity != expected_identity {
            unsafe { close(pidfd as RawFd) };
            return Ok(Some(false));
        }
        let result = unsafe {
            syscall(
                SYS_PIDFD_SEND_SIGNAL,
                pidfd,
                signal as c_long,
                std::ptr::null_mut::<c_void>(),
                0,
            )
        };
        let error = if result < 0 {
            Some(std::io::Error::last_os_error())
        } else {
            None
        };
        // SAFETY: pidfd is the descriptor returned by pidfd_open above.
        unsafe { close(pidfd as RawFd) };
        match error {
            None => Ok(Some(true)),
            Some(error) => match error.raw_os_error() {
                Some(LINUX_EINVAL | LINUX_ENOSYS) => Ok(None),
                Some(ESRCH) => Ok(Some(false)),
                _ => Err(format!("could not signal process handle for {pid}: {error}")),
            },
        }
    }

    #[cfg(target_os = "linux")]
    fn linux_direct_children() -> Result<Vec<LinuxDirectChild>, String> {
        let monitor_pid = self_pid();
        let entries = std::fs::read_dir("/proc")
            .map_err(|error| format!("could not inspect Linux process table: {error}"))?;
        let mut children = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("could not inspect Linux process table entry: {error}"))?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.bytes().all(|byte| byte.is_ascii_digit()) {
                continue;
            }
            let Ok(pid) = name.parse::<u32>() else { continue };
            if pid == 0 || pid == monitor_pid {
                continue;
            }
            match super::linux_process_info(pid) {
                Ok(info) if info.ppid == monitor_pid => children.push(LinuxDirectChild {
                    pid,
                    identity: info.start_identity,
                }),
                Ok(_) | Err(NativeInspectionError::Absent) => {}
                Err(error) => return Err(error.into_message()),
            }
        }
        Ok(children)
    }

    #[cfg(target_os = "linux")]
    fn linux_signal_direct_child(child: &LinuxDirectChild, signal: i32) -> Result<(), String> {
        let monitor_pid = self_pid();
        let info = match super::linux_process_info(child.pid) {
            Ok(info) => info,
            Err(NativeInspectionError::Absent) => return Ok(()),
            Err(error) => return Err(error.into_message()),
        };
        // Revalidate the exact start identity and parent immediately before
        // signaling. If pidfds are unavailable this closes the PID-reuse gap
        // as far as procfs permits.
        if info.ppid != monitor_pid || info.start_identity != child.identity {
            return Ok(());
        }
        match linux_pidfd_signal(child.pid, &child.identity, signal)? {
            Some(_) => Ok(()),
            None => {
                let info = match super::linux_process_info(child.pid) {
                    Ok(info) => info,
                    Err(NativeInspectionError::Absent) => return Ok(()),
                    Err(error) => return Err(error.into_message()),
                };
                if info.ppid != monitor_pid || info.start_identity != child.identity {
                    return Ok(());
                }
                // SAFETY: the identity and direct-child relationship were
                // revalidated immediately before this fallback signal.
                if unsafe { kill(child.pid as i32, signal) } < 0 {
                    let error = std::io::Error::last_os_error();
                    if error.raw_os_error() == Some(ESRCH) {
                        return Ok(());
                    }
                    return Err(format!("could not signal owned child {}: {error}", child.pid));
                }
                Ok(())
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn linux_signal_direct_children(signal: i32) -> Result<(), String> {
        for child in linux_direct_children()? {
            linux_signal_direct_child(&child, signal)?;
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn linux_waitable_child(
        target_pid: u32,
        observed: &mut Option<ChildExit>,
    ) -> Result<bool, String> {
        loop {
            let mut info = LinuxSigInfo {
                si_signo: 0,
                si_errno: 0,
                si_code: 0,
                _pad: 0,
                si_pid: 0,
                si_uid: 0,
                si_status: 0,
                _rest: [0; 100],
            };
            let result = unsafe {
                waitid(
                    WAITID_P_ALL,
                    0,
                    &mut info,
                    WAITID_WEXITED | WAITID_WNOHANG | WAITID_WNOWAIT,
                )
            };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                if error.raw_os_error() == Some(ECHILD) {
                    return Ok(false);
                }
                return Err(format!("waitid child scan failed: {error}"));
            }
            if info.si_pid == 0 {
                return Ok(false);
            }
            let pid = info.si_pid as u32;
            if pid == target_pid && observed.is_none() {
                *observed = Some(
                    decode_wait_status(info.si_code, info.si_status)?
                        .ok_or_else(|| "waitid returned no target status".to_string())?,
                );
            }
            // Reap this one exited direct child. All children adopted by the
            // Linux subreaper belong to the application tree.
            reap_waitid(pid)?;
            return Ok(true);
        }
    }

    #[cfg(target_os = "linux")]
    fn linux_children_empty() -> Result<bool, String> {
        if !linux_direct_children()?.is_empty() {
            return Ok(false);
        }
        let mut info = LinuxSigInfo {
            si_signo: 0,
            si_errno: 0,
            si_code: 0,
            _pad: 0,
            si_pid: 0,
            si_uid: 0,
            si_status: 0,
            _rest: [0; 100],
        };
        loop {
            let result = unsafe {
                waitid(
                    WAITID_P_ALL,
                    0,
                    &mut info,
                    WAITID_WEXITED | WAITID_WNOHANG | WAITID_WNOWAIT,
                )
            };
            if result == 0 && info.si_pid == 0 {
                return Ok(false);
            }
            if result == 0 {
                return Ok(false);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }
            if error.raw_os_error() == Some(ECHILD) {
                return Ok(true);
            }
            return Err(format!("waitid child ownership check failed: {error}"));
        }
    }

    #[cfg(target_os = "linux")]
    fn wait_linux_tree(
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        observed: &mut Option<ChildExit>,
        signal: i32,
        timeout_ms: u64,
    ) -> Result<bool, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
        loop {
            if observed.is_none() {
                *observed = observe_target(target_pid)?;
            }
            // Descendants that escaped the private group can become direct
            // children only after the root exits. Sweep every iteration so a
            // TERM-resistant root cannot create a KILL-resistant orphan gap.
            linux_signal_direct_children(signal)?;
            while linux_waitable_child(target_pid, observed)? {}
            let group_empty = owned_group_empty(
                pgid,
                sid,
                target_pid,
                target_identity,
                observed.is_some(),
            )?;
            if observed.is_some() && group_empty && linux_children_empty()? {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(target_os = "linux")]
    fn monitor_cleanup_linux(
        child: &mut Child,
        exit_writer: &mut File,
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        observed: &mut Option<ChildExit>,
        exit_sent: bool,
        prior_error: Option<String>,
    ) -> Result<(), String> {
        let mut failure = prior_error;
        let target_exited = observed.is_some();
        let group_empty = match owned_group_empty(pgid, sid, target_pid, target_identity, target_exited) {
            Ok(empty) => empty,
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error);
                }
                false
            }
        };
        if !group_empty || !target_exited {
            if let Err(error) = signal_group(
                pgid,
                sid,
                target_pid,
                target_identity,
                target_exited,
                SIGTERM,
            ) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        if let Err(error) = linux_signal_direct_children(SIGTERM) {
            if failure.is_none() {
                failure = Some(error);
            }
        }
        let mut done = match wait_linux_tree(
            pgid,
            sid,
            target_pid,
            target_identity,
            observed,
            SIGTERM,
            MONITOR_GRACE_MS,
        ) {
            Ok(done) => done,
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error);
                }
                false
            }
        };
        if !done || observed.is_none() {
            if let Err(error) = signal_group(
                pgid,
                sid,
                target_pid,
                target_identity,
                observed.is_some(),
                SIGKILL,
            ) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
            if let Err(error) = linux_signal_direct_children(SIGKILL) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
            done = match wait_linux_tree(
                pgid,
                sid,
                target_pid,
                target_identity,
                observed,
                SIGKILL,
                MONITOR_KILL_MS,
            ) {
                Ok(done) => done,
                Err(error) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                    false
                }
            };
        }
        if observed.is_none() && failure.is_none() {
            failure = Some("target did not report an exit status".to_string());
        }
        if !done && failure.is_none() {
            failure = Some(format!("owned process tree rooted at {target_pid} did not exit"));
        }
        if failure.is_none() && !exit_sent {
            if let Some(exit) = observed.as_ref() {
                if let Err(error) = write_exit(exit_writer, exit) {
                    failure = Some(error);
                }
            }
        }
        // child is retained so the monitor's owning Child remains valid;
        // waitid above reaped every application-owned direct child, including
        // the root, before this monitor exits.
        let _ = child.id();
        match failure {
            Some(error) => Err(error),
            None if done => Ok(()),
            None => Err("Linux process-tree cleanup did not complete".to_string()),
        }
    }


    #[cfg(target_os = "linux")]
    fn observe_target(pid: u32) -> Result<Option<ChildExit>, String> {
        loop {
            let mut info = LinuxSigInfo {
                si_signo: 0,
                si_errno: 0,
                si_code: 0,
                _pad: 0,
                si_pid: 0,
                si_uid: 0,
                si_status: 0,
                _rest: [0; 100],
            };
            // SAFETY: info is a correctly sized Linux siginfo_t-compatible
            // buffer, and pid is the monitor's direct child.
            let result = unsafe {
                waitid(
                    WAITID_P_PID,
                    pid,
                    &mut info,
                    WAITID_WEXITED | WAITID_WNOHANG | WAITID_WNOWAIT,
                )
            };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("waitid failed: {error}"));
            }
            if info.si_pid == 0 {
                return Ok(None);
            }
            if info.si_pid != pid as i32 {
                return Err("waitid returned an unexpected child".to_string());
            }
            return decode_wait_status(info.si_code, info.si_status);
        }
    }
    #[cfg(target_os = "macos")]
    fn observe_target(pid: u32) -> Result<Option<ChildExit>, String> {
        loop {
            let mut info = DarwinSigInfo {
                si_signo: 0,
                si_errno: 0,
                si_code: 0,
                si_pid: 0,
                si_uid: 0,
                si_status: 0,
                si_addr: std::ptr::null_mut(),
                si_value: [0; 8],
                si_band: 0,
                _pad: [0; 7],
            };
            // SAFETY: info is a correctly sized Darwin siginfo_t-compatible
            // buffer, and pid is the monitor's direct child.
            let result = unsafe {
                waitid(
                    WAITID_P_PID,
                    pid,
                    &mut info,
                    WAITID_WEXITED | WAITID_WNOHANG | WAITID_WNOWAIT,
                )
            };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("waitid failed: {error}"));
            }
            if info.si_pid == 0 {
                return Ok(None);
            }
            if info.si_pid != pid as i32 {
                return Err("waitid returned an unexpected child".to_string());
            }
            return decode_wait_status(info.si_code, info.si_status);
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn observe_target(_pid: u32) -> Result<Option<ChildExit>, String> {
        Err("unsupported Unix waitid ABI".to_string())
    }

    fn decode_wait_status(code: i32, status: i32) -> Result<Option<ChildExit>, String> {
        match code {
            CLD_EXITED => Ok(Some(ChildExit {
                code: Some(status),
                signal: None,
            })),
            CLD_KILLED | CLD_DUMPED if status > 0 => Ok(Some(ChildExit {
                code: None,
                signal: Some(format!("SIG{status}")),
            })),
            0 => Ok(None),
            _ => Err(format!(
                "waitid returned unexpected child status code {code}"
            )),
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn wait_monitor_group(
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        observed: &mut Option<ChildExit>,
        timeout_ms: u64,
    ) -> Result<bool, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
        loop {
            if observed.is_none() {
                *observed = observe_target(target_pid)?;
            }
            if observed.is_some()
                && owned_group_empty(pgid, sid, target_pid, target_identity, true)?
            {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(target_os = "linux")]
    fn reap_waitid(pid: u32) -> Result<ChildExit, String> {
        loop {
            let mut info = LinuxSigInfo {
                si_signo: 0,
                si_errno: 0,
                si_code: 0,
                _pad: 0,
                si_pid: 0,
                si_uid: 0,
                si_status: 0,
                _rest: [0; 100],
            };
            // SAFETY: info is a correctly sized Linux siginfo_t-compatible
            // buffer; this waitid call intentionally reaps only after cleanup.
            let result = unsafe { waitid(WAITID_P_PID, pid, &mut info, WAITID_WEXITED) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("final waitid failed: {error}"));
            }
            if info.si_pid != pid as i32 {
                return Err("final waitid returned an unexpected child".to_string());
            }
            return decode_wait_status(info.si_code, info.si_status)?
                .ok_or_else(|| "final waitid returned no child status".to_string());
        }
    }

    #[cfg(target_os = "macos")]
    fn reap_waitid(pid: u32) -> Result<ChildExit, String> {
        loop {
            let mut info = DarwinSigInfo {
                si_signo: 0,
                si_errno: 0,
                si_code: 0,
                si_pid: 0,
                si_uid: 0,
                si_status: 0,
                si_addr: std::ptr::null_mut(),
                si_value: [0; 8],
                si_band: 0,
                _pad: [0; 7],
            };
            // SAFETY: info is a correctly sized Darwin siginfo_t-compatible
            // buffer; this waitid call intentionally reaps only after cleanup.
            let result = unsafe { waitid(WAITID_P_PID, pid, &mut info, WAITID_WEXITED) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("final waitid failed: {error}"));
            }
            if info.si_pid != pid as i32 {
                return Err("final waitid returned an unexpected child".to_string());
            }
            return decode_wait_status(info.si_code, info.si_status)?
                .ok_or_else(|| "final waitid returned no child status".to_string());
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn reap_waitid(_pid: u32) -> Result<ChildExit, String> {
        Err("unsupported Unix waitid ABI".to_string())
    }

    fn reap_target(child: &mut Child, _observed: &ChildExit) -> Result<(), String> {
        // The first WNOWAIT frame is authoritative. Darwin may report only
        // low exit bits on a later reap, so this call only drops the zombie.
        let _ = reap_waitid(child.id())?;
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    fn monitor_cleanup(
        child: &mut Child,
        exit_writer: &mut File,
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        observed: &mut Option<ChildExit>,
        mut exit_sent: bool,
        prior_error: Option<String>,
    ) -> Result<(), String> {
        let mut failure = prior_error;
        let mut empty =
            match owned_group_empty(pgid, sid, target_pid, target_identity, observed.is_some()) {
                Ok(empty) => empty,
                Err(error) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                    false
                }
            };
        if !empty || observed.is_none() {
            if let Err(error) = signal_group(
                pgid,
                sid,
                target_pid,
                target_identity,
                observed.is_some(),
                SIGTERM,
            ) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        match wait_monitor_group(
            pgid,
            sid,
            target_pid,
            target_identity,
            observed,
            MONITOR_GRACE_MS,
        ) {
            Ok(done) => empty = done,
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error);
                }
                empty = false;
            }
        }
        if !empty || observed.is_none() {
            if let Err(error) = signal_group(
                pgid,
                sid,
                target_pid,
                target_identity,
                observed.is_some(),
                SIGKILL,
            ) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
            if let Err(error) = wait_monitor_group(
                pgid,
                sid,
                target_pid,
                target_identity,
                observed,
                MONITOR_KILL_MS,
            ) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        let final_empty =
            match owned_group_empty(pgid, sid, target_pid, target_identity, observed.is_some()) {
                Ok(empty) => empty,
                Err(error) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                    false
                }
            };
        empty = final_empty;
        if !empty && failure.is_none() {
            failure = Some(format!("owned process group {pgid} did not exit"));
        }
        if observed.is_none() && failure.is_none() {
            failure = Some("target did not report an exit status".to_string());
        }
        // A prior channel error is reported after cleanup, but the pinned child
        // may still be reaped once the group is known to be drained and a
        // WNOWAIT status was cached.
        if empty {
            if let Some(observed) = observed.as_ref() {
                if let Err(error) = reap_target(child, observed) {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        if failure.is_none() && !exit_sent {
            if let Some(observed) = observed.as_ref() {
                if let Err(error) = write_exit(exit_writer, observed) {
                    failure = Some(error);
                } else {
                    exit_sent = true;
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None if exit_sent => Ok(()),
            None => Err("monitor completed without an exit frame".to_string()),
        }
    }
    #[cfg(target_os = "linux")]
    fn monitor_cleanup(
        child: &mut Child,
        exit_writer: &mut File,
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: &str,
        observed: &mut Option<ChildExit>,
        exit_sent: bool,
        prior_error: Option<String>,
    ) -> Result<(), String> {
        monitor_cleanup_linux(
            child,
            exit_writer,
            pgid,
            sid,
            target_pid,
            target_identity,
            observed,
            exit_sent,
            prior_error,
        )
    }

    fn cleanup_unidentified_private_target(
        child: &mut Child,
        pgid: i32,
        sid: i32,
        target_pid: u32,
    ) -> Result<(), String> {
        if target_pid == 0 || pgid != target_pid as i32 || sid != target_pid as i32 {
            return Err("target private session was not verified".to_string());
        }
        let mut observed = observe_target(target_pid)?;
        let mut empty = !group_has_members(pgid, sid, Some(target_pid))?;
        let mut failure = None;
        if !empty || observed.is_none() {
            if let Err(error) = signal_private_group(pgid, sid, target_pid, SIGTERM) {
                failure = Some(error);
            }
        }
        let mut done = false;
        let deadline = Instant::now() + Duration::from_millis(MONITOR_GRACE_MS);
        loop {
            if observed.is_none() {
                observed = observe_target(target_pid)?;
            }
            empty = !group_has_members(pgid, sid, Some(target_pid))?;
            if observed.is_some() && empty {
                done = true;
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !done {
            if let Err(error) = signal_private_group(pgid, sid, target_pid, SIGKILL) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
            let deadline = Instant::now() + Duration::from_millis(MONITOR_KILL_MS);
            loop {
                if observed.is_none() {
                    observed = observe_target(target_pid)?;
                }
                empty = !group_has_members(pgid, sid, Some(target_pid))?;
                if observed.is_some() && empty {
                    done = true;
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        empty = !group_has_members(pgid, sid, Some(target_pid))?;
        if !empty && failure.is_none() {
            failure = Some(format!("owned process group {pgid} did not exit"));
        }
        if observed.is_none() && failure.is_none() {
            failure = Some("target did not report an exit status".to_string());
        }
        if done && empty {
            if let Some(observed) = observed.as_ref() {
                if let Err(error) = reap_target(child, observed) {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None if done => Ok(()),
            None => Err("target private group cleanup did not complete".to_string()),
        }
    }

    fn signal_private_group(
        pgid: i32,
        sid: i32,
        target_pid: u32,
        signal: i32,
    ) -> Result<(), String> {
        if target_pid == 0 || pgid != target_pid as i32 || sid != target_pid as i32 {
            return Err("target private session was not verified".to_string());
        }
        // SAFETY: the target established a private PGID/SID equal to its PID.
        if unsafe { kill(-pgid, signal) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ESRCH) && !group_has_members(pgid, sid, None)? {
                return Ok(());
            }
            return Err(format!("could not signal target private group: {error}"));
        }
        Ok(())
    }

    fn monitor_loop(
        mut target: Child,
        mut lifetime_reader: File,
        mut exit_writer: File,
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: String,
    ) -> Result<(), String> {
        let mut observed = None;
        let mut exit_sent = false;
        loop {
            if observed.is_none() {
                match observe_target(target_pid) {
                    Ok(Some(exit)) => {
                        #[cfg(target_os = "linux")]
                        {
                            // Linux cleanup owns the exit notification until
                            // the subreaper has drained every tree child.
                            observed = Some(exit);
                            drop(lifetime_reader);
                            return monitor_cleanup(
                                &mut target,
                                &mut exit_writer,
                                pgid,
                                sid,
                                target_pid,
                                &target_identity,
                                &mut observed,
                                false,
                                None,
                            );
                        }
                        #[cfg(not(target_os = "linux"))]
                        {
                            if let Err(error) = write_exit(&mut exit_writer, &exit) {
                                drop(lifetime_reader);
                                let mut failed_observed = Some(exit);
                                return monitor_cleanup(
                                    &mut target,
                                    &mut exit_writer,
                                    pgid,
                                    sid,
                                    target_pid,
                                    &target_identity,
                                    &mut failed_observed,
                                    false,
                                    Some(error),
                                );
                            }
                            observed = Some(exit);
                            exit_sent = true;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        return monitor_cleanup(
                            &mut target,
                            &mut exit_writer,
                            pgid,
                            sid,
                            target_pid,
                            &target_identity,
                            &mut observed,
                            exit_sent,
                            Some(error),
                        );
                    }
                }
            }
            match wait_fd(lifetime_reader.as_raw_fd(), 50) {
                Ok(true) => match drain_lifetime(&mut lifetime_reader) {
                    Ok(LifetimeEvent::Closed) => {
                        return monitor_cleanup(
                            &mut target,
                            &mut exit_writer,
                            pgid,
                            sid,
                            target_pid,
                            &target_identity,
                            &mut observed,
                            exit_sent,
                            None,
                        );
                    }
                    Ok(LifetimeEvent::Handoff) => {
                        if observed.is_some() {
                            return monitor_cleanup(
                                &mut target,
                                &mut exit_writer,
                                pgid,
                                sid,
                                target_pid,
                                &target_identity,
                                &mut observed,
                                exit_sent,
                                Some("target exited before handoff".to_string()),
                            );
                        }
                        match observe_target(target_pid) {
                            Ok(Some(exit)) => {
                                if let Err(error) = write_exit(&mut exit_writer, &exit) {
                                    let mut failed_observed = Some(exit);
                                    return monitor_cleanup(
                                        &mut target,
                                        &mut exit_writer,
                                        pgid,
                                        sid,
                                        target_pid,
                                        &target_identity,
                                        &mut failed_observed,
                                        false,
                                        Some(error),
                                    );
                                }
                                observed = Some(exit);
                                exit_sent = true;
                                return monitor_cleanup(
                                    &mut target,
                                    &mut exit_writer,
                                    pgid,
                                    sid,
                                    target_pid,
                                    &target_identity,
                                    &mut observed,
                                    exit_sent,
                                    Some("target exited before handoff".to_string()),
                                );
                            }
                            Ok(None) => {}
                            Err(error) => {
                                return monitor_cleanup(
                                    &mut target,
                                    &mut exit_writer,
                                    pgid,
                                    sid,
                                    target_pid,
                                    &target_identity,
                                    &mut observed,
                                    exit_sent,
                                    Some(error),
                                );
                            }
                        }
                        if let Err(error) = write_handoff_ack(&mut exit_writer) {
                            return monitor_cleanup(
                                &mut target,
                                &mut exit_writer,
                                pgid,
                                sid,
                                target_pid,
                                &target_identity,
                                &mut observed,
                                exit_sent,
                                Some(error),
                            );
                        }
                        drop(lifetime_reader);
                        return monitor_adopted(
                            target,
                            exit_writer,
                            pgid,
                            sid,
                            target_pid,
                            target_identity,
                        );
                    }
                    Ok(LifetimeEvent::Open) => {}
                    Err(error) => {
                        return monitor_cleanup(
                            &mut target,
                            &mut exit_writer,
                            pgid,
                            sid,
                            target_pid,
                            &target_identity,
                            &mut observed,
                            exit_sent,
                            Some(error),
                        );
                    }
                },
                Ok(false) => {}
                Err(error) => {
                    return monitor_cleanup(
                        &mut target,
                        &mut exit_writer,
                        pgid,
                        sid,
                        target_pid,
                        &target_identity,
                        &mut observed,
                        exit_sent,
                        Some(error),
                    );
                }
            }
        }
    }

    fn monitor_adopted(
        mut target: Child,
        mut exit_writer: File,
        pgid: i32,
        sid: i32,
        target_pid: u32,
        target_identity: String,
    ) -> Result<(), String> {
        let mut observed = loop {
            if let Some(exit) = observe_target(target_pid)? {
                break Some(exit);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        monitor_cleanup(
            &mut target,
            &mut exit_writer,
            pgid,
            sid,
            target_pid,
            &target_identity,
            &mut observed,
            true,
            None,
        )
    }

    #[cfg(not(target_os = "linux"))]
    fn wait_for_group(target: &mut UnixTarget, timeout_ms: u64) -> Result<bool, String> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
        loop {
            let _ = target.try_wait()?;
            let empty = owned_group_empty(
                target.pgid,
                target.sid,
                target.pid,
                &target.identity,
                target.exited.is_some(),
            )?;
            if target.exited.is_some() && empty {
                return Ok(true);
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    impl ManagedTarget for UnixTarget {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn start_identity(&self) -> &str {
            &self.identity
        }

        fn try_wait(&mut self) -> Result<Option<ChildExit>, String> {
            if let Some(exit) = &self.exited {
                return Ok(Some(exit.clone()));
            }
            let monitor = &mut self.monitor;
            if !wait_fd(monitor.exit_reader.as_raw_fd(), 0)? {
                return Ok(None);
            }
            match read_exit(&mut monitor.exit_reader) {
                Ok(exit) => {
                    self.exited = Some(exit.clone());
                    Ok(Some(exit))
                }
                Err(error) => {
                    let recovery = self.recover_monitor_failure();
                    match recovery {
                        Ok(()) => Err(error),
                        Err(cleanup) => Err(format!("{error}; cleanup failed: {cleanup}")),
                    }
                }
            }
        }

        fn handoff(&mut self) -> Result<(), String> {
            {
                let monitor = &mut self.monitor;
                {
                    let lifetime = monitor
                        .lifetime
                        .as_mut()
                        .ok_or_else(|| "lifecycle monitor handoff is unavailable".to_string())?;
                    lifetime
                        .write_all(&[LIFETIME_HANDOFF])
                        .map_err(|error| format!("lifecycle handoff write failed: {error}"))?;
                }
                monitor.lifetime.take();
            }

            let deadline = Instant::now() + Duration::from_millis(MONITOR_KILL_MS.max(1));
            loop {
                let now = Instant::now();
                if now >= deadline {
                    return Err("lifecycle handoff acknowledgement timed out".to_string());
                }
                let wait_ms = deadline
                    .duration_since(now)
                    .as_millis()
                    .min(u128::from(u32::MAX)) as u32;
                let event = {
                    let monitor = &mut self.monitor;
                    if !wait_fd(monitor.exit_reader.as_raw_fd(), wait_ms.max(1))? {
                        None
                    } else {
                        Some(read_monitor_event(&mut monitor.exit_reader)?)
                    }
                };
                let Some(event) = event else {
                    continue;
                };
                match event {
                    MonitorEvent::HandoffCommitted => return Ok(()),
                    MonitorEvent::Exit(exit) => {
                        self.exited = Some(exit);
                        return Err("target exited before handoff".to_string());
                    }
                }
            }
        }

        fn terminate(&mut self, grace_ms: u64, kill_ms: u64) -> Result<(), String> {
            if self.cleaned {
                return Ok(());
            }
            #[cfg(target_os = "linux")]
            {
                // Linux cleanup is owned by the subreaper monitor. Closing
                // the lifetime pipe lets it sweep both the private group and
                // every adopted direct child without racing a root zombie.
                self.drop_lifetime();
                self.wait_monitor(
                    grace_ms
                        .saturating_add(kill_ms)
                        .max(MONITOR_GRACE_MS + MONITOR_KILL_MS),
                )?;
                self.cleaned = true;
                return Ok(());
            }
            #[cfg(not(target_os = "linux"))]
            {
                let empty = owned_group_empty(
                    self.pgid,
                    self.sid,
                    self.pid,
                    &self.identity,
                    self.exited.is_some(),
                )?;
                if !empty || self.exited.is_none() {
                    signal_group(
                        self.pgid,
                        self.sid,
                        self.pid,
                        &self.identity,
                        self.exited.is_some(),
                        SIGTERM,
                    )?;
                }
                let mut done = wait_for_group(self, grace_ms)?;
                if !done {
                    signal_group(
                        self.pgid,
                        self.sid,
                        self.pid,
                        &self.identity,
                        self.exited.is_some(),
                        SIGKILL,
                    )?;
                    done = wait_for_group(self, kill_ms)?;
                }
                self.drop_lifetime();
                let monitor_result = self.wait_monitor(kill_ms.max(MONITOR_KILL_MS));
                if let Err(error) = monitor_result {
                    return Err(error);
                }
                if !done {
                    return Err(format!("owned process group {} did not exit", self.pgid));
                }
                self.cleaned = true;
                Ok(())
            }
        }

        fn finish_cleanup(&mut self) -> Result<(), String> {
            if self.cleaned {
                return Ok(());
            }
            #[cfg(target_os = "linux")]
            {
                self.drop_lifetime();
                self.wait_monitor(MONITOR_GRACE_MS + MONITOR_KILL_MS)?;
                let _ = self.try_wait()?;
                self.cleaned = true;
                return Ok(());
            }
            #[cfg(not(target_os = "linux"))]
            {
                let empty = owned_group_empty(
                    self.pgid,
                    self.sid,
                    self.pid,
                    &self.identity,
                    self.exited.is_some(),
                )?;
                let mut done = self.exited.is_some() && empty;
                if !done {
                    signal_group(
                        self.pgid,
                        self.sid,
                        self.pid,
                        &self.identity,
                        self.exited.is_some(),
                        SIGKILL,
                    )?;
                    done = wait_for_group(self, MONITOR_KILL_MS)?;
                }
                self.drop_lifetime();
                self.wait_monitor(MONITOR_KILL_MS)?;
                if !done {
                    return Err(format!("owned process group {} did not exit", self.pgid));
                }
                let _ = self.try_wait()?;
                self.cleaned = true;
                Ok(())
            }
        }

    }

    impl UnixTarget {
        fn drop_lifetime(&mut self) {
            self.monitor.lifetime.take();
        }

        fn wait_monitor(&mut self, timeout_ms: u64) -> Result<(), String> {
            let monitor = &mut self.monitor;
            let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(1));
            loop {
                if let Some(status) = monitor
                    .child
                    .try_wait()
                    .map_err(|error| format!("lifecycle monitor wait failed: {error}"))?
                {
                    if status.success() {
                        return Ok(());
                    }
                    return Err(format!("lifecycle monitor exited with {status}"));
                }
                if Instant::now() >= deadline {
                    return Err("lifecycle monitor did not exit".to_string());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn recover_monitor_failure(&mut self) -> Result<(), String> {
            let reason = "lifecycle monitor exited before reporting target status";
            verify_identity(self.pid, &self.identity, "target")?;
            let (pgid, sid) = process_group_ids(self.pid)?;
            if pgid != self.pgid || sid != self.sid {
                return Err(format!("{reason}: target process session changed"));
            }
            signal_group(
                self.pgid,
                self.sid,
                self.pid,
                &self.identity,
                self.exited.is_some(),
                SIGTERM,
            )?;
            let deadline = Instant::now() + Duration::from_millis(MONITOR_GRACE_MS);
            while !owned_group_empty(
                self.pgid,
                self.sid,
                self.pid,
                &self.identity,
                self.exited.is_some(),
            )? {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            signal_group(
                self.pgid,
                self.sid,
                self.pid,
                &self.identity,
                self.exited.is_some(),
                SIGKILL,
            )?;
            let deadline = Instant::now() + Duration::from_millis(MONITOR_KILL_MS);
            while !owned_group_empty(
                self.pgid,
                self.sid,
                self.pid,
                &self.identity,
                self.exited.is_some(),
            )? {
                if Instant::now() >= deadline {
                    return Err(format!("{reason}: owned process group did not drain"));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(reason.to_string())
        }
    }

    pub(super) fn run_anchor(arguments: &[String]) -> Result<(), String> {
        if arguments.len() != 5 {
            return Err("anchor requires four private file descriptors".to_string());
        }
        let spec_fd = parse_private_fd(&arguments[1])?;
        let startup_fd = parse_private_fd(&arguments[2])?;
        let exit_fd = parse_private_fd(&arguments[3])?;
        let lifetime_fd = parse_private_fd(&arguments[4])?;
        let fds = [spec_fd, startup_fd, exit_fd, lifetime_fd];
        for (index, fd) in fds.iter().enumerate() {
            if *fd < 0 || fds[..index].contains(fd) {
                return Err("anchor received duplicate private descriptors".to_string());
            }
        }
        // SAFETY: these descriptors are inherited from spawn_monitored and are
        // each transferred to exactly one File value.
        let mut spec_reader = unsafe { File::from_raw_fd(spec_fd) };
        let mut startup_writer = unsafe { File::from_raw_fd(startup_fd) };
        let mut exit_writer = unsafe { File::from_raw_fd(exit_fd) };
        let lifetime_reader = unsafe { File::from_raw_fd(lifetime_fd) };
        let spec = match read_spawn_spec(&mut spec_reader) {
            Ok(spec) => spec,
            Err(error) => {
                let _ = write_startup_error(&mut startup_writer, &error);
                return Err(error);
            }
        };
        drop(spec_reader);
        for fd in [startup_fd, exit_fd, lifetime_fd] {
            set_close_on_exec(fd)?;
        }
        if unsafe { setsid() } < 0 {
            let error = format!(
                "could not establish monitor session: {}",
                std::io::Error::last_os_error()
            );
            let _ = write_startup_error(&mut startup_writer, &error);
            return Err(error);
        }
        reset_sigchld()?;
        #[cfg(target_os = "linux")]
        if unsafe { prctl(PR_SET_CHILD_SUBREAPER, 1) } < 0 {
            let error = format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: could not establish Linux child subreaper: {}",
                std::io::Error::last_os_error()
            );
            let _ = write_startup_error(&mut startup_writer, &error);
            return Err(error);
        }
        let monitor_pid = std::process::id();
        let monitor_identity = match start_identity(monitor_pid) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = write_startup_error(&mut startup_writer, &error);
                return Err(error);
            }
        };
        let (monitor_pgid, monitor_sid) = process_group_ids(monitor_pid)?;
        if monitor_pgid != monitor_pid as i32 || monitor_sid != monitor_pid as i32 {
            let error = "monitor did not establish a private session".to_string();
            let _ = write_startup_error(&mut startup_writer, &error);
            return Err(error);
        }
        let mut target_command = command_for_spec(&spec);
        let monitor_parent = monitor_pid as i32;
        // SAFETY: pre_exec runs between fork and exec and invokes only process
        // session and parent-death primitives.
        unsafe {
            target_command.pre_exec(move || {
                if setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                {
                    if prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if getppid() != monitor_parent {
                    return Err(std::io::Error::from_raw_os_error(libc_esrch()));
                }
                Ok(())
            });
        }
        let mut target = match target_command.spawn() {
            Ok(target) => target,
            Err(error) => {
                let message = format!("could not start target: {error}");
                let _ = write_startup_error(&mut startup_writer, &message);
                return Err(message);
            }
        };
        let target_pid = target.id();
        let target_identity = match start_identity(target_pid) {
            Ok(identity) => identity,
            Err(error) => {
                let _ = write_startup_error(&mut startup_writer, &error);
                drop(lifetime_reader);
                let cleanup = match process_group_ids(target_pid) {
                    Ok((pgid, sid)) if pgid == target_pid as i32 && sid == target_pid as i32 => {
                        cleanup_unidentified_private_target(&mut target, pgid, sid, target_pid)
                    }
                    Ok((pgid, sid)) => Err(format!(
                        "target did not establish a private session (pgid {pgid}, sid {sid})"
                    )),
                    Err(group_error) => Err(group_error),
                };
                if let Err(cleanup_error) = cleanup {
                    let _ = target.kill();
                    let _ = target.wait();
                    return Err(format!("{error}; cleanup failed: {cleanup_error}"));
                }
                return Err(error);
            }
        };
        let (target_pgid, target_sid) = match process_group_ids(target_pid) {
            Ok(ids) => ids,
            Err(error) => {
                let _ = target.kill();
                let _ = target.wait();
                let _ = write_startup_error(&mut startup_writer, &error);
                return Err(error);
            }
        };
        if target_pgid != target_pid as i32 || target_sid != target_pid as i32 {
            let error = "target did not establish a private session".to_string();
            let _ = target.kill();
            let _ = target.wait();
            let _ = write_startup_error(&mut startup_writer, &error);
            return Err(error);
        }
        let topology_error = match inspect_process(target_pid) {
            Ok(ProcessInspection::Live {
                ppid,
                start_identity,
                ..
            }) if ppid == monitor_pid && start_identity == target_identity => None,
            Ok(ProcessInspection::Live { ppid, .. }) => Some(format!(
                "target is not monitor's direct child (parent {ppid})"
            )),
            Ok(ProcessInspection::Absent) => Some("target disappeared during startup".to_string()),
            Err(error) => Some(error),
        };
        if let Some(error) = topology_error {
            let _ = write_startup_error(&mut startup_writer, &error);
            drop(lifetime_reader);
            let mut failed_observed = None;
            return monitor_cleanup(
                &mut target,
                &mut exit_writer,
                target_pgid,
                target_sid,
                target_pid,
                &target_identity,
                &mut failed_observed,
                false,
                Some(error),
            );
        }
        if let Err(error) = write_startup_success(
            &mut startup_writer,
            target_pid,
            &target_identity,
            target_pgid,
            target_sid,
            monitor_pid,
            &monitor_identity,
            monitor_pgid,
            monitor_sid,
        ) {
            drop(lifetime_reader);
            let mut failed_observed = None;
            return monitor_cleanup(
                &mut target,
                &mut exit_writer,
                target_pgid,
                target_sid,
                target_pid,
                &target_identity,
                &mut failed_observed,
                false,
                Some(error),
            );
        }
        drop(startup_writer);
        close_wrapper_stdio();
        monitor_loop(
            target,
            lifetime_reader,
            exit_writer,
            target_pgid,
            target_sid,
            target_pid,
            target_identity,
        )
    }

    #[cfg(all(test, target_os = "linux"))]
    mod linux_tree_tests {
        use super::*;
        use std::path::{Path, PathBuf};
        use std::sync::atomic::{AtomicU64, Ordering};

        static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

        fn pid_file(label: &str) -> PathBuf {
            let id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
            std::env::temp_dir().join(format!(
                "alder-process-supervisor-{label}-{}-{id}.pid",
                std::process::id()
            ))
        }

        fn spec(path: &Path, natural_exit: bool, ignore_root_term: bool) -> SpawnSpec {
            let root = if natural_exit {
                "exit 0"
            } else if ignore_root_term {
                "trap \"\" TERM; while :; do /usr/bin/sleep 1; done"
            } else {
                "while :; do /usr/bin/sleep 1; done"
            };
            let script = format!(
                "/usr/bin/setsid /usr/bin/sh -c 'trap \"\" TERM; while :; do /usr/bin/sleep 1; done' & child=$!; printf '%s' \"$child\" > {}; {}",
                path.display(),
                root
            );
            SpawnSpec {
                executable: "/usr/bin/sh".to_string(),
                args: vec!["-c".to_string(), script],
                cwd: "/".to_string(),
                environment: BTreeMap::new(),
                stdio: "ignore".to_string(),
            }
        }

        fn read_pid(path: &Path) -> u32 {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if let Ok(value) = std::fs::read_to_string(path) {
                    if let Ok(pid) = value.parse::<u32>() {
                        return pid;
                    }
                }
                assert!(Instant::now() < deadline, "escaped child did not publish its PID");
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        fn assert_absent(pid: u32) {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match inspect_process(pid).expect("inspect escaped child") {
                    ProcessInspection::Absent => return,
                    ProcessInspection::Live { .. } => {
                        assert!(Instant::now() < deadline, "escaped child {pid} survived cleanup");
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        }

        #[test]
        fn linux_escaped_setsid_child_is_gone_after_termination() {
            let path = pid_file("terminate");
            let mut target = spawn_target(&spec(&path, false, true)).expect("spawn target");
            let escaped_pid = read_pid(&path);
            target.terminate(50, 500).expect("terminate target tree");
            assert_absent(escaped_pid);
            let _ = std::fs::remove_file(path);
        }

        #[test]
        fn linux_escaped_setsid_child_is_gone_before_natural_exit_is_reported() {
            let path = pid_file("natural");
            let mut target = spawn_target(&spec(&path, true, false)).expect("spawn target");
            let escaped_pid = read_pid(&path);
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                if target.try_wait().expect("wait for natural exit").is_some() {
                    break;
                }
                assert!(Instant::now() < deadline, "natural root exit was not reported");
                std::thread::sleep(Duration::from_millis(10));
            }
            assert_absent(escaped_pid);
            target.finish_cleanup().expect("finish natural cleanup");
            let _ = std::fs::remove_file(path);
        }

        #[test]
        fn linux_escaped_setsid_child_is_gone_when_lifetime_closes() {
            let path = pid_file("lifetime");
            let mut target = spawn_target(&spec(&path, false, false)).expect("spawn target");
            let escaped_pid = read_pid(&path);
            target.finish_cleanup().expect("close target lifetime");
            assert_absent(escaped_pid);
            let _ = std::fs::remove_file(path);
        }
    }

    fn parse_private_fd(value: &str) -> Result<RawFd, String> {
        value
            .parse::<RawFd>()
            .map_err(|_| "invalid private file descriptor".to_string())
    }
}

#[cfg(unix)]
use unix::{spawn_detached as unix_spawn_detached, spawn_target as unix_spawn_target};
#[cfg(unix)]
pub fn run_anchor(arguments: &[String]) -> Result<(), String> {
    unix::run_anchor(arguments)
}
#[cfg(unix)]
use unix::PollFd;
#[cfg(unix)]
use unix::set_close_on_exec;
#[cfg(unix)]
use unix::{POLLERR, POLLHUP, POLLIN};

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr::null_mut;
    use std::time::Instant;

    type Handle = *mut std::ffi::c_void;
    type Dword = u32;
    type Bool = i32;
    const TRUE: Bool = 1;
    const FALSE: Bool = 0;
    pub(super) const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const WAIT_OBJECT_0: Dword = 0;
    const WAIT_TIMEOUT: Dword = 258;
    const INFINITE: Dword = 0xffff_ffff;
    const CREATE_SUSPENDED: Dword = 0x0000_0004;
    const CREATE_NEW_PROCESS_GROUP: Dword = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: Dword = 0x0100_0000;
    const CREATE_UNICODE_ENVIRONMENT: Dword = 0x0000_0400;
    const STARTF_USESTDHANDLES: Dword = 0x0000_0100;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: Dword = 0x0000_2000;
    const DUPLICATE_SAME_ACCESS: Dword = 0x0000_0002;
    const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION: Dword = 1;
    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: Dword = 9;
    const PROCESS_QUERY_LIMITED_INFORMATION: Dword = 0x1000;
    const SYNCHRONIZE: Dword = 0x0010_0000;
    const PROCESS_TERMINATE: Dword = 0x0001;
    const TH32CS_SNAPPROCESS: Dword = 0x0000_0002;
    const ERROR_INVALID_PARAMETER: Dword = 87;
    const ERROR_NO_MORE_FILES: Dword = 18;
    pub(super) const STD_INPUT_HANDLE: Dword = (-10i32) as Dword;
    pub(super) const STD_OUTPUT_HANDLE: Dword = (-11i32) as Dword;
    pub(super) const STD_ERROR_HANDLE: Dword = (-12i32) as Dword;
    const CTRL_BREAK_EVENT: Dword = 1;
    const FILE_ATTRIBUTE_DIRECTORY: Dword = 0x0000_0010;
    const FILE_ATTRIBUTE_REPARSE_POINT: Dword = 0x0000_0400;
    const INVALID_FILE_ATTRIBUTES: Dword = 0xffff_ffff;
    const FILE_FLAG_OPEN_REPARSE_POINT: Dword = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: Dword = 0x0200_0000;
    const GENERIC_READ: Dword = 0x8000_0000;
    const GENERIC_WRITE: Dword = 0x4000_0000;
    const READ_CONTROL: Dword = 0x0002_0000;
    const WRITE_DAC: Dword = 0x0004_0000;
    const FILE_SHARE_READ: Dword = 0x0000_0001;
    const FILE_SHARE_WRITE: Dword = 0x0000_0002;
    const FILE_SHARE_DELETE: Dword = 0x0000_0004;
    const OPEN_EXISTING: Dword = 3;
    const FILE_ATTRIBUTE_NORMAL: Dword = 0x0000_0080;
    const FILE_READ_ATTRIBUTES: Dword = 0x0000_0080;
    const FILE_TYPE_DISK: Dword = 1;
    const FILE_ATTRIBUTE_TAG_INFO_CLASS: Dword = 9;
    const HANDLE_FLAG_INHERIT: Dword = 1;
    const ERROR_INSUFFICIENT_BUFFER: Dword = 122;
    const SE_FILE_OBJECT: Dword = 1;
    const OWNER_SECURITY_INFORMATION: Dword = 0x0000_0001;
    const DACL_SECURITY_INFORMATION: Dword = 0x0000_0004;
    const PROTECTED_DACL_SECURITY_INFORMATION: Dword = 0x8000_0000;
    const SE_DACL_PRESENT: u16 = 0x0004;
    const SE_DACL_PROTECTED: u16 = 0x1000;
    const ACL_REVISION: Dword = 2;
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const INHERITED_ACE: u8 = 0x10;
    const OBJECT_INHERIT_ACE: u8 = 0x01;
    const CONTAINER_INHERIT_ACE: u8 = 0x02;
    const FILE_ALL_ACCESS: Dword = 0x001f_01ff;
    const TOKEN_QUERY: Dword = 0x0000_0008;
    const TOKEN_USER_CLASS: Dword = 1;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct FileTime {
        low: Dword,
        high: Dword,
    }
    #[repr(C)]
    struct StartupInfo {
        cb: Dword,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: Dword,
        y: Dword,
        x_size: Dword,
        y_size: Dword,
        x_count: Dword,
        y_count: Dword,
        fill: Dword,
        flags: Dword,
        show: u16,
        reserved2: u16,
        reserved2_ptr: *mut u8,
        stdin: Handle,
        stdout: Handle,
        stderr: Handle,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: Handle,
        thread: Handle,
        pid: Dword,
        tid: Dword,
    }
    #[repr(C)]
    struct BasicAccountingInformation {
        total_user_time: i64,
        total_kernel_time: i64,
        this_period_total_user_time: i64,
        this_period_total_kernel_time: i64,
        total_page_fault_count: Dword,
        total_processes: Dword,
        active_processes: Dword,
        total_terminated_processes: Dword,
    }
    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: Dword,
        cnt_usage: Dword,
        process_id: Dword,
        default_heap_id: usize,
        module_id: Dword,
        thread_count: Dword,
        parent_process_id: Dword,
        priority_class_base: i32,
        flags: Dword,
        exe_file: [u16; 260],
    }

    #[repr(C)]
    struct BasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        flags: Dword,
        minimum_working_set: usize,
        maximum_working_set: usize,
        active_process_limit: Dword,
        affinity: usize,
        priority: Dword,
        scheduling: Dword,
    }
    #[repr(C)]
    struct IoCounters {
        read: u64,
        written: u64,
        other: u64,
        read_bytes: u64,
        written_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct ExtendedLimitInformation {
        basic: BasicLimitInformation,
        io: IoCounters,
        process_memory: usize,
        job_memory: usize,
        peak_process_memory: usize,
        peak_job_memory: usize,
    }
    #[repr(C)]
    struct Acl {
        revision: u8,
        sbz1: u8,
        size: u16,
        ace_count: u16,
        sbz2: u16,
    }
    #[repr(C)]
    struct AceHeader {
        ace_type: u8,
        ace_flags: u8,
        ace_size: u16,
        access_mask: Dword,
    }
    #[repr(C)]
    struct FileAttributeTagInfo {
        file_attributes: Dword,
        reparse_tag: Dword,
    }
    #[repr(C)]
    struct TokenUser {
        sid: Handle,
        attributes: Dword,
    }

    #[link(name = "msvcrt")]
    unsafe extern "C" {
        fn _get_osfhandle(fd: i32) -> isize;
    }

    pub(super) fn control_handle(
        value: Option<&str>,
        descriptor: i32,
        name: &str,
    ) -> Result<usize, String> {
        let handle = if let Some(value) = value {
            value
                .parse::<usize>()
                .map_err(|_| format!("invalid Windows control {name} handle"))?
        } else {
            // SAFETY: the child inherited the descriptor from Node; this only
            // queries the process-local CRT descriptor table.
            let handle = unsafe { _get_osfhandle(descriptor) };
            if handle <= 0 || handle == -1 {
                return Err(format!(
                    "Windows control {name} descriptor {descriptor} unavailable"
                ));
            }
            handle as usize
        };
        if handle == 0 || handle == usize::MAX {
            return Err(format!("invalid Windows control {name} handle"));
        }
        Ok(handle as usize)
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool;
        pub(super) fn CloseHandle(handle: Handle) -> Bool;
        fn CreateToolhelp32Snapshot(flags: Dword, process_id: Dword) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry32W) -> Bool;
        fn CreateJobObjectW(attributes: *mut std::ffi::c_void, name: *const u16) -> Handle;
        fn DuplicateHandle(
            source_process: Handle,
            source_handle: Handle,
            target_process: Handle,
            target_handle: *mut Handle,
            desired_access: Dword,
            inherit_handle: Bool,
            options: Dword,
        ) -> Bool;
        fn GetCurrentProcess() -> Handle;
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *mut std::ffi::c_void,
            thread_attributes: *mut std::ffi::c_void,
            inherit_handles: Bool,
            flags: Dword,
            environment: *mut u16,
            current_directory: *const u16,
            startup_info: *mut StartupInfo,
            process_info: *mut ProcessInformation,
        ) -> Bool;
        fn GetExitCodeProcess(process: Handle, code: *mut Dword) -> Bool;
        fn GetLastError() -> Dword;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> Bool;
        pub(super) fn GetStdHandle(which: Dword) -> Handle;
        fn GetCurrentProcessId() -> Dword;
        fn OpenProcess(access: Dword, inherit: Bool, pid: Dword) -> Handle;
        fn ResumeThread(thread: Handle) -> Dword;
        fn SetInformationJobObject(
            job: Handle,
            class: Dword,
            info: *mut std::ffi::c_void,
            length: Dword,
        ) -> Bool;
        fn QueryInformationJobObject(
            job: Handle,
            class: Dword,
            info: *mut std::ffi::c_void,
            length: Dword,
            return_length: *mut Dword,
        ) -> Bool;
        fn TerminateJobObject(job: Handle, code: Dword) -> Bool;
        fn TerminateProcess(process: Handle, code: Dword) -> Bool;
        fn WaitForSingleObject(handle: Handle, milliseconds: Dword) -> Dword;
        pub(super) fn PeekNamedPipe(
            handle: Handle,
            buffer: *mut u8,
            length: Dword,
            read: *mut Dword,
            available: *mut Dword,
            left: *mut Dword,
        ) -> Bool;
        fn CreateFileW(
            name: *const u16,
            desired_access: Dword,
            share_mode: Dword,
            security_attributes: *mut std::ffi::c_void,
            creation_disposition: Dword,
            flags_and_attributes: Dword,
            template: Handle,
        ) -> Handle;
        fn GetFileAttributesW(name: *const u16) -> Dword;
        fn GetFileInformationByHandleEx(
            handle: Handle,
            info_class: Dword,
            info: *mut std::ffi::c_void,
            size: Dword,
        ) -> Bool;
        fn GetFileType(handle: Handle) -> Dword;
        fn GenerateConsoleCtrlEvent(event: Dword, process_group_id: Dword) -> Bool;
        fn SetHandleInformation(handle: Handle, mask: Dword, flags: Dword) -> Bool;
        fn LocalFree(memory: Handle) -> Handle;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn GetSecurityInfo(
            handle: Handle,
            object_type: Dword,
            security_info: Dword,
            owner: *mut Handle,
            group: *mut Handle,
            dacl: *mut *mut Acl,
            sacl: *mut Handle,
            descriptor: *mut *mut std::ffi::c_void,
        ) -> Dword;
        fn GetSecurityDescriptorControl(
            descriptor: *mut std::ffi::c_void,
            control: *mut u16,
            revision: *mut Dword,
        ) -> Bool;
        fn GetAce(acl: *mut Acl, index: Dword, ace: *mut *mut std::ffi::c_void) -> Bool;
        fn GetLengthSid(sid: Handle) -> Dword;
        fn EqualSid(left: Handle, right: Handle) -> Bool;
        fn IsValidSid(sid: Handle) -> Bool;
        fn OpenProcessToken(process: Handle, desired_access: Dword, token: *mut Handle) -> Bool;
        fn GetTokenInformation(
            token: Handle,
            info_class: Dword,
            info: *mut std::ffi::c_void,
            info_length: Dword,
            return_length: *mut Dword,
        ) -> Bool;
        fn InitializeAcl(acl: *mut Acl, size: Dword, revision: Dword) -> Bool;
        fn AddAccessAllowedAceEx(
            acl: *mut Acl,
            revision: Dword,
            ace_flags: Dword,
            access_mask: Dword,
            sid: Handle,
        ) -> Bool;
        fn SetSecurityInfo(
            handle: Handle,
            object_type: Dword,
            security_info: Dword,
            owner: Handle,
            group: Handle,
            dacl: *mut Acl,
            sacl: Handle,
        ) -> Dword;
    }

    pub(super) struct WindowsTarget {
        process: Handle,
        thread: Handle,
        job: Handle,
        pid: u32,
        identity: String,
        exited: Option<ChildExit>,
        detached: bool,
    }

    pub(super) fn spawn_target(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
        spawn(spec, false)
    }

    pub(super) fn spawn_detached(spec: &SpawnSpec) -> Result<Box<dyn ManagedTarget>, String> {
        spawn(spec, true)
    }
    fn stdio_handles(stdio: &str) -> Result<(Handle, Handle, Handle, Vec<Handle>), String> {
        if stdio == "pipes" {
            let handles = [
                unsafe { GetStdHandle(STD_INPUT_HANDLE) },
                unsafe { GetStdHandle(STD_OUTPUT_HANDLE) },
                unsafe { GetStdHandle(STD_ERROR_HANDLE) },
            ];
            if handles
                .iter()
                .any(|handle| handle.is_null() || *handle == INVALID_HANDLE_VALUE)
            {
                return Err(format!(
                    "{PROCESS_CONTAINMENT_UNAVAILABLE}: direct stdio handles unavailable"
                ));
            }
            return Ok((handles[0], handles[1], handles[2], Vec::new()));
        }

        let mut owned = Vec::with_capacity(3);
        for access in [GENERIC_READ, GENERIC_WRITE, GENERIC_WRITE] {
            let name = wide("NUL");
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    access,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null_mut(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                close_handles(&owned);
                return Err(format!(
                    "{PROCESS_CONTAINMENT_UNAVAILABLE}: NUL stdio handle unavailable ({})",
                    unsafe { GetLastError() }
                ));
            }
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                let error = unsafe { GetLastError() };
                unsafe {
                    CloseHandle(handle);
                }
                close_handles(&owned);
                return Err(format!(
                    "{PROCESS_CONTAINMENT_UNAVAILABLE}: NUL stdio handle inheritance failed ({error})"
                ));
            }
            owned.push(handle);
        }
        Ok((owned[0], owned[1], owned[2], owned))
    }

    fn close_handles(handles: &[Handle]) {
        for &handle in handles {
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                unsafe {
                    CloseHandle(handle);
                }
            }
        }
    }

    fn spawn(spec: &SpawnSpec, detached: bool) -> Result<Box<dyn ManagedTarget>, String> {
        let job = unsafe { CreateJobObjectW(null_mut(), std::ptr::null()) };
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            return Err(format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: CreateJobObject failed ({})",
                unsafe { GetLastError() }
            ));
        }
        if set_job_kill_on_close(job) == 0 {
            unsafe {
                CloseHandle(job);
            }
            return Err(format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: Job Object policy failed ({})",
                unsafe { GetLastError() }
            ));
        }
        let mut command = quote_command_line(&spec.executable, &spec.args);
        let mut application = wide(&spec.executable);
        let mut cwd = wide(&spec.cwd);
        let mut environment = environment_block(&spec.environment);
        let (stdin, stdout, stderr, owned_stdio) = match stdio_handles(&spec.stdio) {
            Ok(handles) => handles,
            Err(error) => {
                unsafe {
                    CloseHandle(job);
                }
                return Err(error);
            }
        };
        let mut startup = StartupInfo {
            cb: std::mem::size_of::<StartupInfo>() as Dword,
            reserved: null_mut(),
            desktop: null_mut(),
            title: null_mut(),
            x: 0,
            y: 0,
            x_size: 0,
            y_size: 0,
            x_count: 0,
            y_count: 0,
            fill: 0,
            flags: STARTF_USESTDHANDLES,
            show: 0,
            reserved2: 0,
            reserved2_ptr: null_mut(),
            stdin,
            stdout,
            stderr,
        };
        let mut info = ProcessInformation {
            process: null_mut(),
            thread: null_mut(),
            pid: 0,
            tid: 0,
        };
        let mut flags = CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
        if detached {
            flags |= CREATE_BREAKAWAY_FROM_JOB;
        }
        let created = unsafe {
            CreateProcessW(
                application.as_mut_ptr(),
                command.as_mut_ptr(),
                null_mut(),
                null_mut(),
                TRUE,
                flags,
                environment.as_mut_ptr(),
                cwd.as_mut_ptr(),
                &mut startup,
                &mut info,
            )
        };
        close_handles(&owned_stdio);
        if created == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                CloseHandle(job);
            }
            return Err(if detached || error == 5 {
                format!(
                    "{PROCESS_CONTAINMENT_UNAVAILABLE}: CreateProcess breakaway failed ({error})"
                )
            } else {
                format!("could not start process ({error})")
            });
        }
        if unsafe { AssignProcessToJobObject(job, info.process) } == 0 {
            unsafe {
                TerminateProcess(info.process, 1);
                CloseHandle(info.thread);
                CloseHandle(info.process);
                CloseHandle(job);
            }
            return Err(format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: assigning process failed ({})",
                unsafe { GetLastError() }
            ));
        }
        if unsafe { ResumeThread(info.thread) } == u32::MAX {
            unsafe {
                TerminateJobObject(job, 1);
                CloseHandle(info.thread);
                CloseHandle(info.process);
                CloseHandle(job);
            }
            return Err(format!(
                "{PROCESS_CONTAINMENT_UNAVAILABLE}: resuming process failed ({})",
                unsafe { GetLastError() }
            ));
        }
        let identity = match identity_from_handle(info.process) {
            Ok(identity) => identity,
            Err(error) => {
                unsafe {
                    TerminateJobObject(job, 1);
                    CloseHandle(info.thread);
                    CloseHandle(info.process);
                    CloseHandle(job);
                }
                return Err(format!("{PROCESS_CONTAINMENT_UNAVAILABLE}: {error}"));
            }
        };
        Ok(Box::new(WindowsTarget {
            process: info.process,
            thread: info.thread,
            job,
            pid: info.pid,
            identity,
            exited: None,
            detached,
        }))
    }
    fn set_job_kill_on_close(job: Handle) -> Bool {
        let mut limits = ExtendedLimitInformation {
            basic: BasicLimitInformation {
                per_process_user_time_limit: 0,
                per_job_user_time_limit: 0,
                flags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                minimum_working_set: 0,
                maximum_working_set: 0,
                active_process_limit: 0,
                affinity: 0,
                priority: 0,
                scheduling: 0,
            },
            io: IoCounters {
                read: 0,
                written: 0,
                other: 0,
                read_bytes: 0,
                written_bytes: 0,
                other_bytes: 0,
            },
            process_memory: 0,
            job_memory: 0,
            peak_process_memory: 0,
            peak_job_memory: 0,
        };
        unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                (&mut limits as *mut _) as *mut _,
                std::mem::size_of::<ExtendedLimitInformation>() as Dword,
            )
        }
    }
    fn job_active_processes(job: Handle) -> Result<Dword, String> {
        let mut accounting = BasicAccountingInformation {
            total_user_time: 0,
            total_kernel_time: 0,
            this_period_total_user_time: 0,
            this_period_total_kernel_time: 0,
            total_page_fault_count: 0,
            total_processes: 0,
            active_processes: 0,
            total_terminated_processes: 0,
        };
        if unsafe {
            QueryInformationJobObject(
                job,
                JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                (&mut accounting as *mut _) as *mut _,
                std::mem::size_of::<BasicAccountingInformation>() as Dword,
                null_mut(),
            )
        } == 0
        {
            return Err(format!("QueryInformationJobObject failed ({})", unsafe {
                GetLastError()
            }));
        }
        Ok(accounting.active_processes)
    }
    impl WindowsTarget {
        fn wait_for_job(&mut self, timeout_ms: u64) -> Result<bool, String> {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms);
            loop {
                let root_exited = self.try_wait()?.is_some();
                let active_processes = job_active_processes(self.job)?;
                if root_exited && active_processes == 0 {
                    return Ok(true);
                }
                if Instant::now() >= deadline {
                    return Ok(false);
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                std::thread::sleep(if remaining < Duration::from_millis(10) {
                    remaining
                } else {
                    Duration::from_millis(10)
                });
            }
        }
    }

    impl ManagedTarget for WindowsTarget {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn start_identity(&self) -> &str {
            &self.identity
        }

        fn try_wait(&mut self) -> Result<Option<ChildExit>, String> {
            if let Some(exit) = &self.exited {
                return Ok(Some(exit.clone()));
            }
            let status = unsafe { WaitForSingleObject(self.process, 0) };
            if status == WAIT_TIMEOUT {
                return Ok(None);
            }
            if status != WAIT_OBJECT_0 {
                return Err(format!("WaitForSingleObject failed ({status})"));
            }
            let mut code = 1;
            if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
                return Err(format!("GetExitCodeProcess failed ({})", unsafe {
                    GetLastError()
                }));
            }
            let exit = ChildExit {
                code: Some(code as i32),
                signal: None,
            };
            self.exited = Some(exit.clone());
            Ok(Some(exit))
        }

        fn handoff(&mut self) -> Result<(), String> {
            if !self.detached {
                return Err("Windows handoff requested for an attached target".to_string());
            }
            if self.try_wait()?.is_some() {
                return Err("target exited before handoff".to_string());
            }
            let job = self.job;
            let mut transferred = null_mut();
            if unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    job,
                    self.process,
                    &mut transferred,
                    0,
                    FALSE,
                    DUPLICATE_SAME_ACCESS,
                )
            } == 0
                || transferred.is_null()
            {
                return Err(format!(
                    "Windows handoff could not transfer Job Object ({})",
                    unsafe { GetLastError() }
                ));
            }
            if self.try_wait()?.is_some() {
                if unsafe { TerminateJobObject(job, 1) } == 0 {
                    return Err(format!(
                        "target exited before handoff; Windows cleanup failed ({})",
                        unsafe { GetLastError() }
                    ));
                }
                return Err("target exited before handoff".to_string());
            }
            Ok(())
        }


        fn terminate(&mut self, grace_ms: u64, kill_ms: u64) -> Result<(), String> {
            let process_group = self.pid;
            let request_graceful = self.exited.is_none();
            let job = self.job;
            terminate_with_grace(
                grace_ms,
                kill_ms,
                move || {
                    if request_graceful {
                        unsafe {
                            let _ = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, process_group);
                        }
                    }
                },
                |timeout| self.wait_for_job(timeout),
                move || {
                    if unsafe { TerminateJobObject(job, 1) } == 0 {
                        return Err(format!(
                            "Windows termination failed ({})",
                            unsafe { GetLastError() }
                        ));
                    }
                    Ok(())
                },
                "owned Windows process group did not exit",
            )
        }

        fn finish_cleanup(&mut self) -> Result<(), String> {
            self.terminate(0, 1_000)
        }
    }

    impl Drop for WindowsTarget {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.job);
                if !self.thread.is_null() {
                    CloseHandle(self.thread);
                }
                if !self.process.is_null() {
                    CloseHandle(self.process);
                }
            }
        }
    }

    fn identity_from_handle(handle: Handle) -> Result<String, String> {
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0
        {
            return Err(format!(
                "could not read process start identity ({})",
                unsafe { GetLastError() }
            ));
        }
        let ticks = (u64::from(creation.high) << 32) | u64::from(creation.low);
        Ok(format!("windows:{ticks}"))
    }

    pub(super) fn start_identity(pid: u32) -> Result<String, String> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(format!("could not open process ({})", unsafe {
                GetLastError()
            }));
        }
        let result = identity_from_handle(handle);
        unsafe {
            CloseHandle(handle);
        }
        result
    }
    pub(super) fn inspect_process(pid: u32) -> Result<ProcessInspection, String> {
        let handle =
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            let error = unsafe { GetLastError() };
            if error == ERROR_INVALID_PARAMETER {
                return Ok(ProcessInspection::Absent);
            }
            return Err(format!("could not open process ({error})"));
        }
        let result = (|| {
            let identity = identity_from_handle(handle)?;
            if !process_is_live(handle)? {
                return Ok(ProcessInspection::Absent);
            }
            let Some(ppid) = parent_process_id(pid)? else {
                if !process_is_live(handle)? {
                    return Ok(ProcessInspection::Absent);
                }
                return Err("live process is missing from the Windows process snapshot".to_string());
            };
            if !process_is_live(handle)? {
                return Ok(ProcessInspection::Absent);
            }
            Ok(ProcessInspection::Live {
                pid,
                ppid,
                start_identity: identity,
            })
        })();
        unsafe {
            CloseHandle(handle);
        }
        result
    }

    fn process_is_live(handle: Handle) -> Result<bool, String> {
        let status = unsafe { WaitForSingleObject(handle, 0) };
        if status == WAIT_TIMEOUT {
            return Ok(true);
        }
        if status == WAIT_OBJECT_0 {
            return Ok(false);
        }
        Err(format!("WaitForSingleObject failed ({status})"))
    }

    fn parent_process_id(pid: u32) -> Result<Option<u32>, String> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
            return Err(format!("CreateToolhelp32Snapshot failed ({})", unsafe {
                GetLastError()
            }));
        }
        let mut entry = ProcessEntry32W {
            dw_size: std::mem::size_of::<ProcessEntry32W>() as Dword,
            cnt_usage: 0,
            process_id: 0,
            default_heap_id: 0,
            module_id: 0,
            thread_count: 0,
            parent_process_id: 0,
            priority_class_base: 0,
            flags: 0,
            exe_file: [0; 260],
        };
        if unsafe { Process32FirstW(snapshot, &mut entry) } == 0 {
            let error = unsafe { GetLastError() };
            unsafe {
                CloseHandle(snapshot);
            }
            if error == ERROR_NO_MORE_FILES {
                return Ok(None);
            }
            return Err(format!("Process32FirstW failed ({error})"));
        }
        loop {
            if entry.process_id == pid {
                let ppid = entry.parent_process_id;
                unsafe {
                    CloseHandle(snapshot);
                }
                return Ok(Some(ppid));
            }
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                let error = unsafe { GetLastError() };
                unsafe {
                    CloseHandle(snapshot);
                }
                if error == ERROR_NO_MORE_FILES {
                    return Ok(None);
                }
                return Err(format!("Process32NextW failed ({error})"));
            }
        }
    }
    #[derive(Clone, Copy)]
    enum PrivatePathKind {
        File,
        Directory,
    }

    pub(super) fn private_path(arguments: &[String]) -> Result<(), String> {
        match arguments {
            [operation, kind, path] if matches!(operation.as_str(), "verify" | "secure") => {
                let kind = parse_private_kind(kind)?;
                let path = std::path::Path::new(path);
                verify_or_secure_private_path(path, kind, operation == "secure")
            }
            [operation, path] if operation == "read" => {
                read_private_file(std::path::Path::new(path))
            }
            _ => Err(
                "--private-path expects verify|secure file|directory PATH or read PATH"
                    .to_string(),
            ),
        }
    }

    fn parse_private_kind(value: &str) -> Result<PrivatePathKind, String> {
        match value {
            "file" => Ok(PrivatePathKind::File),
            "directory" => Ok(PrivatePathKind::Directory),
            _ => Err("private path kind must be file or directory".to_string()),
        }
    }

    fn verify_or_secure_private_path(
        path: &std::path::Path,
        kind: PrivatePathKind,
        secure: bool,
    ) -> Result<(), String> {
        validate_private_prefixes(path)?;
        let sid = current_user_sid()?;
        let handle = open_private_target(path, kind, secure)?;
        let result = (|| {
            validate_private_type(handle, kind)?;
            validate_private_prefixes(path)?;
            if secure {
                validate_private_owner(handle, &sid)?;
                set_private_acl(handle, &sid, kind)?;
                validate_private_prefixes(path)?;
                validate_private_type(handle, kind)?;
            }
            validate_private_acl(handle, &sid, kind)
        })();
        unsafe {
            CloseHandle(handle);
        }
        result
    }

    fn read_private_file(path: &std::path::Path) -> Result<(), String> {
        validate_private_prefixes(path)?;
        let sid = current_user_sid()?;
        let handle = open_private_target(path, PrivatePathKind::File, false)?;
        let mut file = unsafe { File::from_raw_handle(handle) };
        let result = (|| {
            let handle = file.as_raw_handle();
            validate_private_type(handle, PrivatePathKind::File)?;
            validate_private_prefixes(path)?;
            validate_private_acl(handle, &sid, PrivatePathKind::File)?;
            let mut stdout = std::io::stdout().lock();
            std::io::copy(&mut file, &mut stdout)
                .map_err(|error| format!("could not read private file: {error}"))?;
            stdout
                .flush()
                .map_err(|error| format!("could not write private file: {error}"))?;
            Ok(())
        })();
        drop(file);
        result
    }

    fn validate_private_prefixes(path: &std::path::Path) -> Result<(), String> {
        let prefixes = private_path_prefixes(path)?;
        for (index, prefix) in prefixes.iter().enumerate() {
            let name = wide_path(prefix)?;
            let attributes = unsafe { GetFileAttributesW(name.as_ptr()) };
            if attributes == INVALID_FILE_ATTRIBUTES {
                return Err(format!(
                    "private path component is unavailable ({})",
                    unsafe { GetLastError() }
                ));
            }
            if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err("private path contains a reparse point".to_string());
            }
            if index + 1 < prefixes.len() && attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err("private path component is not a directory".to_string());
            }
        }
        Ok(())
    }

    fn private_path_prefixes(path: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
        if path.as_os_str().is_empty() || !path.is_absolute() {
            return Err("private path must be an absolute path".to_string());
        }
        let mut current = std::path::PathBuf::new();
        let mut prefixes = Vec::new();
        for component in path.components() {
            match component {
                std::path::Component::Prefix(_) => {
                    current.push(component.as_os_str());
                }
                std::path::Component::RootDir => {
                    current.push(component.as_os_str());
                    prefixes.push(current.clone());
                }
                std::path::Component::Normal(value) => {
                    current.push(value);
                    prefixes.push(current.clone());
                }
                std::path::Component::CurDir | std::path::Component::ParentDir => {
                    return Err("private path cannot contain . or .. components".to_string());
                }
            }
        }
        if prefixes.is_empty() {
            return Err("private path must name an existing path".to_string());
        }
        Ok(prefixes)
    }

    fn wide_path(path: &std::path::Path) -> Result<Vec<u16>, String> {
        let mut result = Vec::new();
        for value in path.as_os_str().encode_wide() {
            if value == 0 {
                return Err("private path contains NUL".to_string());
            }
            result.push(value);
        }
        result.push(0);
        Ok(result)
    }

    fn open_private_target(
        path: &std::path::Path,
        kind: PrivatePathKind,
        secure: bool,
    ) -> Result<Handle, String> {
        let name = wide_path(path)?;
        let desired_access = if secure {
            FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC
        } else {
            GENERIC_READ | READ_CONTROL
        };
        let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
        if matches!(kind, PrivatePathKind::Directory) {
            flags |= FILE_FLAG_BACKUP_SEMANTICS;
        }
        let handle = unsafe {
            CreateFileW(
                name.as_ptr(),
                desired_access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null_mut(),
                OPEN_EXISTING,
                flags,
                null_mut(),
            )
        };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "could not open private path ({})",
                unsafe { GetLastError() }
            ));
        }
        Ok(handle)
    }

    fn validate_private_type(handle: Handle, kind: PrivatePathKind) -> Result<(), String> {
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
            return Err("private path is not a regular disk object".to_string());
        }
        let mut info = FileAttributeTagInfo {
            file_attributes: 0,
            reparse_tag: 0,
        };
        if unsafe {
            GetFileInformationByHandleEx(
                handle,
                FILE_ATTRIBUTE_TAG_INFO_CLASS,
                &mut info as *mut _ as *mut std::ffi::c_void,
                std::mem::size_of::<FileAttributeTagInfo>() as Dword,
            )
        } == 0
        {
            return Err(format!(
                "could not inspect private path ({})",
                unsafe { GetLastError() }
            ));
        }
        if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("private path target is a reparse point".to_string());
        }
        let is_directory = info.file_attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if is_directory != matches!(kind, PrivatePathKind::Directory) {
            return Err("private path target has the wrong type".to_string());
        }
        Ok(())
    }

    fn current_user_sid() -> Result<Vec<u8>, String> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(format!(
                "could not open current-user token ({})",
                unsafe { GetLastError() }
            ));
        }
        let result = (|| {
            let mut needed = 0;
            let first = unsafe {
                GetTokenInformation(
                    token,
                    TOKEN_USER_CLASS,
                    null_mut(),
                    0,
                    &mut needed,
                )
            };
            let first_error = unsafe { GetLastError() };
            if first != 0 || needed == 0 || first_error != ERROR_INSUFFICIENT_BUFFER {
                return Err("could not size current-user token information".to_string());
            }
            let mut data = vec![0u8; needed as usize];
            if unsafe {
                GetTokenInformation(
                    token,
                    TOKEN_USER_CLASS,
                    data.as_mut_ptr() as *mut std::ffi::c_void,
                    needed,
                    &mut needed,
                )
            } == 0
            {
                return Err(format!(
                    "could not read current-user token ({})",
                    unsafe { GetLastError() }
                ));
            }
            if data.len() < std::mem::size_of::<TokenUser>() {
                return Err("current-user token information is truncated".to_string());
            }
            let user = unsafe { std::ptr::read_unaligned(data.as_ptr() as *const TokenUser) };
            if user.sid.is_null() || unsafe { IsValidSid(user.sid) } == 0 {
                return Err("current-user token has an invalid SID".to_string());
            }
            let length = unsafe { GetLengthSid(user.sid) } as usize;
            if length == 0 {
                return Err("current-user token has an empty SID".to_string());
            }
            let mut sid = vec![0u8; length];
            unsafe {
                std::ptr::copy_nonoverlapping(
                    user.sid as *const u8,
                    sid.as_mut_ptr(),
                    length,
                );
            }
            Ok(sid)
        })();
        unsafe {
            CloseHandle(token);
        }
        result
    }

    fn validate_private_owner(handle: Handle, sid: &[u8]) -> Result<(), String> {
        let mut owner = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(format!("could not read private path owner ({status})"));
        }
        let result = if owner.is_null()
            || unsafe { IsValidSid(owner) } == 0
            || unsafe { EqualSid(owner, sid.as_ptr() as Handle) } == 0
        {
            Err("private path owner is not the current user".to_string())
        } else {
            Ok(())
        };
        if !descriptor.is_null() {
            unsafe {
                LocalFree(descriptor);
            }
        }
        result
    }

    fn validate_private_acl(
        handle: Handle,
        sid: &[u8],
        kind: PrivatePathKind,
    ) -> Result<(), String> {
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        let status = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut descriptor,
            )
        };
        if status != 0 {
            return Err(format!("could not read private path ACL ({status})"));
        }
        let result = (|| {
            if owner.is_null()
                || unsafe { IsValidSid(owner) } == 0
                || unsafe { EqualSid(owner, sid.as_ptr() as Handle) } == 0
            {
                return Err("private path owner is not the current user".to_string());
            }
            if dacl.is_null() {
                return Err("private path has no DACL".to_string());
            }
            if descriptor.is_null() {
                return Err("private path security descriptor is missing".to_string());
            }
            let mut control = 0u16;
            let mut revision = 0u32;
            if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0
            {
                return Err(format!(
                    "could not inspect private path DACL ({})",
                    unsafe { GetLastError() }
                ));
            }
            if control & SE_DACL_PRESENT == 0 || control & SE_DACL_PROTECTED == 0 {
                return Err("private path DACL is not protected".to_string());
            }
            let ace_count = unsafe { (*dacl).ace_count };
            if ace_count != 1 {
                return Err("private path DACL is not current-user-only".to_string());
            }
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, 0, &mut ace) } == 0 || ace.is_null() {
                return Err(format!(
                    "could not inspect private path ACE ({})",
                    unsafe { GetLastError() }
                ));
            }
            let header = ace as *const AceHeader;
            let expected_flags = match kind {
                PrivatePathKind::File => 0,
                PrivatePathKind::Directory => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            };
            if unsafe { (*header).ace_type } != ACCESS_ALLOWED_ACE_TYPE
                || unsafe { (*header).ace_flags } & INHERITED_ACE != 0
                || unsafe { (*header).ace_flags } != expected_flags
            {
                return Err("private path DACL ACE is not current-user-only".to_string());
            }
            let header_size = std::mem::size_of::<AceHeader>();
            let ace_size = unsafe { (*header).ace_size } as usize;
            if ace_size < header_size {
                return Err("private path DACL ACE is truncated".to_string());
            }
            let ace_sid = unsafe { (ace as *const u8).add(header_size) as Handle };
            if unsafe { IsValidSid(ace_sid) } == 0 {
                return Err("private path DACL ACE has an invalid SID".to_string());
            }
            let ace_sid_length = unsafe { GetLengthSid(ace_sid) } as usize;
            if ace_sid_length == 0 || ace_size < header_size + ace_sid_length {
                return Err("private path DACL ACE is truncated".to_string());
            }
            if unsafe { EqualSid(ace_sid, sid.as_ptr() as Handle) } == 0 {
                return Err("private path DACL contains an unexpected SID".to_string());
            }
            if unsafe { (*header).access_mask } == 0 {
                return Err("private path DACL grants no access".to_string());
            }
            Ok(())
        })();
        if !descriptor.is_null() {
            unsafe {
                LocalFree(descriptor);
            }
        }
        result
    }

    fn set_private_acl(
        handle: Handle,
        sid: &[u8],
        kind: PrivatePathKind,
    ) -> Result<(), String> {
        let header_size = std::mem::size_of::<Acl>();
        let ace_size = std::mem::size_of::<AceHeader>() + sid.len();
        let byte_size = header_size
            .checked_add(ace_size)
            .ok_or_else(|| "private path ACL is too large".to_string())?;
        let word_count = byte_size.div_ceil(std::mem::size_of::<u32>());
        let mut storage = vec![0u32; word_count];
        let acl = storage.as_mut_ptr() as *mut Acl;
        if unsafe {
            InitializeAcl(acl, (storage.len() * std::mem::size_of::<u32>()) as Dword, ACL_REVISION)
        } == 0
        {
            return Err(format!(
                "could not initialize private path ACL ({})",
                unsafe { GetLastError() }
            ));
        }
        let ace_flags = match kind {
            PrivatePathKind::File => 0,
            PrivatePathKind::Directory => OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
        };
        if unsafe {
            AddAccessAllowedAceEx(
                acl,
                ACL_REVISION,
                Dword::from(ace_flags),
                FILE_ALL_ACCESS,
                sid.as_ptr() as Handle,
            )
        } == 0
        {
            return Err(format!(
                "could not create private path ACL ({})",
                unsafe { GetLastError() }
            ));
        }
        let status = unsafe {
            SetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null_mut(),
            )
        };
        if status != 0 {
            return Err(format!("could not secure private path ACL ({status})"));
        }
        Ok(())
    }

    pub(super) fn run_anchor(_arguments: &[String]) -> Result<(), String> {
        Err(PROCESS_CONTAINMENT_UNAVAILABLE.to_string())
    }

    pub(super) fn set_close_on_exec(_fd: i32) -> Result<(), String> {
        Ok(())
    }

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn environment_block(environment: &BTreeMap<String, String>) -> Vec<u16> {
        let mut result = Vec::new();
        for (key, value) in environment {
            result.extend(std::ffi::OsStr::new(&format!("{key}={value}")).encode_wide());
            result.push(0);
        }
        result.push(0);
        result
    }

    fn quote_command_line(executable: &str, args: &[String]) -> Vec<u16> {
        let mut result = quote_windows(executable);
        for arg in args {
            result.push(' ');
            result.push_str(&quote_windows(arg));
        }
        wide(&result)
    }

    fn quote_windows(value: &str) -> String {
        if !value.is_empty() && value.bytes().all(|byte| !b" \t\n\r\"".contains(&byte)) {
            return value.to_string();
        }
        let mut result = String::from("\"");
        let mut slashes = 0usize;
        for character in value.chars() {
            if character == '\\' {
                slashes += 1;
                continue;
            }
            if character == '"' {
                result.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                result.push('"');
                slashes = 0;
            } else {
                result.extend(std::iter::repeat_n('\\', slashes));
                result.push(character);
                slashes = 0;
            }
        }
        result.extend(std::iter::repeat_n('\\', slashes * 2));
        result.push('"');
        result
    }
}

#[cfg(windows)]
use windows::{spawn_detached as win_spawn_detached, spawn_target as win_spawn_target};
#[cfg(windows)]
pub fn run_anchor(arguments: &[String]) -> Result<(), String> {
    windows::run_anchor(arguments)
}
#[cfg(windows)]
use windows::{inspect_process as win_inspect_process, start_identity as win_start_identity};

#[cfg(not(any(unix, windows)))]
fn run_anchor(_arguments: &[String]) -> Result<(), String> {
    Err(PROCESS_CONTAINMENT_UNAVAILABLE.to_string())
}
