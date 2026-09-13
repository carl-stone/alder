use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub enum Value {
    Null,
    Bool,
    Number(String),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    pub fn object(&self) -> Result<&BTreeMap<String, Value>, String> {
        match self {
            Self::Object(value) => Ok(value),
            _ => Err("expected JSON object".to_string()),
        }
    }

    pub fn string(&self) -> Result<&str, String> {
        match self {
            Self::String(value) => Ok(value),
            _ => Err("expected JSON string".to_string()),
        }
    }

    pub fn u64(&self, name: &str) -> Result<u64, String> {
        let value = match self {
            Self::Number(value) => value,
            _ => return Err(format!("{name} must be an integer")),
        };
        if value.is_empty() || value.starts_with('-') || value.contains(['.', 'e', 'E']) {
            return Err(format!("{name} must be a nonnegative integer"));
        }
        value
            .parse::<u64>()
            .map_err(|_| format!("{name} is out of range"))
    }

    pub fn optional<'a>(object: &'a BTreeMap<String, Value>, name: &str) -> Option<&'a Value> {
        object.get(name)
    }

    pub fn required<'a>(
        object: &'a BTreeMap<String, Value>,
        name: &str,
    ) -> Result<&'a Value, String> {
        object.get(name).ok_or_else(|| format!("missing {name}"))
    }

    pub fn string_array(&self, name: &str) -> Result<Vec<String>, String> {
        let values = match self {
            Self::Array(values) => values,
            _ => return Err(format!("{name} must be an array")),
        };
        let mut result = Vec::with_capacity(values.len());
        for value in values {
            result.push(value.string()?.to_string());
        }
        Ok(result)
    }

    pub fn string_map(&self, name: &str) -> Result<BTreeMap<String, String>, String> {
        let values = self.object()?;
        let mut result = BTreeMap::new();
        for (key, value) in values {
            if key.is_empty() || key.contains('\0') {
                return Err(format!("{name} contains an invalid key"));
            }
            result.insert(key.clone(), value.string()?.to_string());
        }
        Ok(result)
    }
}

pub fn parse(input: &str) -> Result<Value, String> {
    let mut parser = Parser { input, position: 0 };
    let value = parser.value()?;
    parser.whitespace();
    if parser.position != input.len() {
        return Err("trailing bytes after JSON value".to_string());
    }
    Ok(value)
}

struct Parser<'a> {
    input: &'a str,
    position: usize,
}

impl<'a> Parser<'a> {
    fn value(&mut self) -> Result<Value, String> {
        self.whitespace();
        match self.peek() {
            Some(b'n') => self.literal(b"null", Value::Null),
            Some(b't') => self.literal(b"true", Value::Bool),
            Some(b'f') => self.literal(b"false", Value::Bool),
            Some(b'"') => self.string().map(Value::String),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(format!("invalid JSON at byte {}", self.position)),
        }
    }

    fn literal(&mut self, literal: &[u8], value: Value) -> Result<Value, String> {
        if self
            .bytes()
            .get(self.position..self.position + literal.len())
            != Some(literal)
        {
            return Err(format!("invalid JSON at byte {}", self.position));
        }
        self.position += literal.len();
        Ok(value)
    }

    fn string(&mut self) -> Result<String, String> {
        if self.take() != Some(b'"') {
            return Err(format!("expected string at byte {}", self.position));
        }
        let mut result = String::new();
        loop {
            let byte = self
                .take()
                .ok_or_else(|| "unterminated JSON string".to_string())?;
            match byte {
                b'"' => return Ok(result),
                b'\\' => {
                    let escaped = self
                        .take()
                        .ok_or_else(|| "unterminated JSON escape".to_string())?;
                    match escaped {
                        b'"' => result.push('"'),
                        b'\\' => result.push('\\'),
                        b'/' => result.push('/'),
                        b'b' => result.push('\u{0008}'),
                        b'f' => result.push('\u{000c}'),
                        b'n' => result.push('\n'),
                        b'r' => result.push('\r'),
                        b't' => result.push('\t'),
                        b'u' => {
                            let first = self.hex4()?;
                            let codepoint = if (0xD800..=0xDBFF).contains(&first) {
                                let save = self.position;
                                if self.take() != Some(b'\\') || self.take() != Some(b'u') {
                                    self.position = save;
                                    return Err("unpaired UTF-16 high surrogate".to_string());
                                }
                                let second = self.hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&second) {
                                    return Err("invalid UTF-16 surrogate pair".to_string());
                                }
                                0x1_0000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                            } else {
                                if (0xDC00..=0xDFFF).contains(&first) {
                                    return Err("unpaired UTF-16 low surrogate".to_string());
                                }
                                first
                            };
                            let character = char::from_u32(codepoint)
                                .ok_or_else(|| "invalid Unicode scalar value".to_string())?;
                            result.push(character);
                        }
                        _ => {
                            return Err(format!(
                                "invalid JSON escape at byte {}",
                                self.position - 1
                            ));
                        }
                    }
                }
                byte if byte < 0x20 => return Err("control byte in JSON string".to_string()),
                byte if byte < 0x80 => result.push(byte as char),
                _ => {
                    let start = self.position - 1;
                    let width = utf8_width(byte)
                        .ok_or_else(|| "invalid UTF-8 in JSON string".to_string())?;
                    let end = start + width;
                    if end > self.bytes().len()
                        || std::str::from_utf8(&self.bytes()[start..end]).is_err()
                    {
                        return Err("invalid UTF-8 in JSON string".to_string());
                    }
                    result.push_str(&self.input[start..end]);
                    self.position = end;
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let byte = self
                .take()
                .ok_or_else(|| "truncated Unicode escape".to_string())?;
            value = (value << 4)
                | match byte {
                    b'0'..=b'9' => u32::from(byte - b'0'),
                    b'a'..=b'f' => u32::from(byte - b'a' + 10),
                    b'A'..=b'F' => u32::from(byte - b'A' + 10),
                    _ => return Err("invalid Unicode escape".to_string()),
                };
        }
        Ok(value)
    }

    fn array(&mut self) -> Result<Value, String> {
        self.take();
        let mut values = Vec::new();
        self.whitespace();
        if self.peek() == Some(b']') {
            self.take();
            return Ok(Value::Array(values));
        }
        loop {
            values.push(self.value()?);
            self.whitespace();
            match self.take() {
                Some(b',') => {
                    self.whitespace();
                    if self.peek() == Some(b']') {
                        return Err("trailing comma in JSON array".to_string());
                    }
                }
                Some(b']') => return Ok(Value::Array(values)),
                _ => return Err(format!("expected ',' or ']' at byte {}", self.position)),
            }
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.take();
        let mut values = BTreeMap::new();
        self.whitespace();
        if self.peek() == Some(b'}') {
            self.take();
            return Ok(Value::Object(values));
        }
        loop {
            self.whitespace();
            let key = self.string()?;
            self.whitespace();
            if self.take() != Some(b':') {
                return Err(format!("expected ':' at byte {}", self.position));
            }
            let value = self.value()?;
            if values.insert(key, value).is_some() {
                return Err("duplicate JSON object key".to_string());
            }
            self.whitespace();
            match self.take() {
                Some(b',') => {
                    self.whitespace();
                    if self.peek() == Some(b'}') {
                        return Err("trailing comma in JSON object".to_string());
                    }
                }
                Some(b'}') => return Ok(Value::Object(values)),
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.position)),
            }
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.position;
        if self.peek() == Some(b'-') {
            self.take();
        }
        match self.peek() {
            Some(b'0') => {
                self.take();
                if matches!(self.peek(), Some(b'0'..=b'9')) {
                    return Err("leading zero in JSON number".to_string());
                }
            }
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.take();
                }
            }
            _ => return Err(format!("invalid JSON number at byte {start}")),
        }
        if self.peek() == Some(b'.') {
            self.take();
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("fraction requires digits".to_string());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.take();
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.take();
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.take();
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err("exponent requires digits".to_string());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.take();
            }
        }
        Ok(Value::Number(self.input[start..self.position].to_string()))
    }

    fn whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.position += 1;
        }
    }

    fn bytes(&self) -> &[u8] {
        self.input.as_bytes()
    }

    fn peek(&self) -> Option<u8> {
        self.bytes().get(self.position).copied()
    }

    fn take(&mut self) -> Option<u8> {
        let value = self.peek()?;
        self.position += 1;
        Some(value)
    }
}

fn utf8_width(first: u8) -> Option<usize> {
    match first {
        0xC2..=0xDF => Some(2),
        0xE0..=0xEF => Some(3),
        0xF0..=0xF4 => Some(4),
        _ => None,
    }
}

pub fn string(value: &str) -> String {
    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');
    for character in value.chars() {
        match character {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\u{08}' => result.push_str("\\b"),
            '\u{0c}' => result.push_str("\\f"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            character if character < '\u{20}' => {
                result.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => result.push(character),
        }
    }
    result.push('"');
    result
}
