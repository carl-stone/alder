use std::io::{Read, Write};

use crate::platform::{ControlReader, ControlWriter, wait_readable};

pub const MAX_FRAME_BYTES: usize = 1_048_576;

pub struct FramedReader {
    reader: ControlReader,
}

pub struct FramedWriter {
    writer: ControlWriter,
}

impl FramedReader {
    pub fn new(reader: ControlReader) -> Self {
        Self { reader }
    }

    pub fn wait(&self, timeout_ms: u32) -> Result<bool, String> {
        wait_readable(&self.reader, timeout_ms)
    }

    pub fn next(&mut self) -> Result<Option<String>, String> {
        let mut length = [0u8; 4];
        match read_exact_or_eof(&mut self.reader, &mut length)? {
            false => return Ok(None),
            true => {}
        }
        let length = u32::from_le_bytes(length) as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(format!(
                "control frame length {length} is outside 1..={MAX_FRAME_BYTES}"
            ));
        }
        let mut bytes = vec![0u8; length];
        self.reader
            .read_exact(&mut bytes)
            .map_err(|error| format!("control frame read failed: {error}"))?;
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "control frame is not valid UTF-8".to_string())
    }
}

impl FramedWriter {
    pub fn new(writer: ControlWriter) -> Self {
        Self { writer }
    }

    pub fn send(&mut self, value: &str) -> Result<(), String> {
        let bytes = value.as_bytes();
        if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
            return Err(format!(
                "control event length {} is outside 1..={MAX_FRAME_BYTES}",
                bytes.len()
            ));
        }
        self.writer
            .write_all(&(bytes.len() as u32).to_le_bytes())
            .map_err(|error| format!("control event header failed: {error}"))?;
        self.writer
            .write_all(bytes)
            .map_err(|error| format!("control event body failed: {error}"))?;
        self.writer
            .flush()
            .map_err(|error| format!("control event flush failed: {error}"))
    }
}

fn read_exact_or_eof(reader: &mut impl Read, buffer: &mut [u8]) -> Result<bool, String> {
    let mut offset = 0usize;
    while offset < buffer.len() {
        match reader.read(&mut buffer[offset..]) {
            Ok(0) => {
                if offset == 0 {
                    return Ok(false);
                }
                return Err("control pipe closed in the middle of a frame".to_string());
            }
            Ok(bytes) => offset += bytes,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("control frame read failed: {error}")),
        }
    }
    Ok(true)
}
