//! A tiny VT scanner over a terminal's raw output. It doesn't render anything
//! (xterm.js does); it only notices what Track cares about: the bell, desktop
//! notifications (OSC 9 / OSC 777), titles (OSC 0/2), the working directory
//! (OSC 7, OSC 9;9) and progress (OSC 9;4). A BEL that terminates an OSC
//! string is a terminator, not a bell, which is why this needs a state machine.

#[derive(Debug, Clone, PartialEq)]
pub enum ScanEvent {
    Title(String),
    Cwd(String),
    Bell,
    Notify(String),
    /// OSC 9;4: state (0 none, 1 normal, 2 error, 3 indeterminate, 4 paused) and percent.
    Progress(u8, u8),
}

#[derive(Debug, Default, Clone, Copy, PartialEq)]
enum St {
    #[default]
    Ground,
    Esc,
    Osc,
    OscEsc,
    /// DCS, APC, PM, SOS: skipped until their terminator.
    Str,
    StrEsc,
}

const MAX_OSC: usize = 8192;

#[derive(Default)]
pub struct Scanner {
    st: St,
    buf: Vec<u8>,
}

impl Scanner {
    pub fn feed(&mut self, data: &[u8]) -> Vec<ScanEvent> {
        let mut out = Vec::new();
        for &b in data {
            match self.st {
                St::Ground => match b {
                    0x1b => self.st = St::Esc,
                    0x07 => out.push(ScanEvent::Bell),
                    _ => {}
                },
                St::Esc => self.esc(b),
                St::Osc => match b {
                    0x07 => {
                        self.finish(&mut out);
                        self.st = St::Ground;
                    }
                    0x1b => self.st = St::OscEsc,
                    _ => {
                        if self.buf.len() < MAX_OSC {
                            self.buf.push(b);
                        }
                    }
                },
                St::OscEsc => {
                    if b == b'\\' {
                        self.finish(&mut out);
                        self.st = St::Ground;
                    } else {
                        self.buf.clear();
                        self.esc(b);
                    }
                }
                St::Str => match b {
                    0x07 => self.st = St::Ground,
                    0x1b => self.st = St::StrEsc,
                    _ => {}
                },
                St::StrEsc => self.st = if b == b'\\' { St::Ground } else { St::Str },
            }
        }
        out
    }

    fn esc(&mut self, b: u8) {
        self.st = match b {
            b']' => {
                self.buf.clear();
                St::Osc
            }
            b'P' | b'_' | b'^' | b'X' => St::Str,
            0x1b => St::Esc,
            _ => St::Ground,
        };
    }

    fn finish(&mut self, out: &mut Vec<ScanEvent>) {
        let text = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        let (code, rest) = text.split_once(';').unwrap_or((text.as_str(), ""));
        match code {
            "0" | "2" => out.push(ScanEvent::Title(clean(rest, 200))),
            "7" => {
                if let Some(p) = file_url_path(rest) {
                    out.push(ScanEvent::Cwd(p));
                }
            }
            "9" => {
                if let Some(path) = rest.strip_prefix("9;") {
                    if let Some(p) = normalize_path(path.trim().trim_matches('"')) {
                        out.push(ScanEvent::Cwd(p));
                    }
                } else if let Some(progress) = rest.strip_prefix("4;") {
                    let mut parts = progress.split(';');
                    let state = parts.next().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0);
                    let value = parts.next().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0).min(100);
                    out.push(ScanEvent::Progress(state.min(4), value));
                } else if !rest.is_empty() && !is_conemu_code(rest) {
                    out.push(ScanEvent::Notify(clean(rest, 300)));
                }
            }
            "777" => {
                // notify;title;body
                let mut parts = rest.splitn(3, ';');
                if parts.next() == Some("notify") {
                    let title = parts.next().unwrap_or("").trim();
                    let body = parts.next().unwrap_or("").trim();
                    let msg = match (title.is_empty(), body.is_empty()) {
                        (false, false) => format!("{title}: {body}"),
                        (false, true) => title.to_string(),
                        _ => body.to_string(),
                    };
                    out.push(ScanEvent::Notify(clean(&msg, 300)));
                }
            }
            _ => {}
        }
    }
}

/// ConEmu-style `OSC 9;<n>;...` commands (1-12) aren't notifications.
fn is_conemu_code(rest: &str) -> bool {
    let head = rest.split(';').next().unwrap_or("");
    !head.is_empty() && head.len() <= 2 && head.bytes().all(|b| b.is_ascii_digit()) && rest.contains(';')
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

fn file_url_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let path = &rest[rest.find('/')?..];
    normalize_path(&percent_decode(path))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Turns what shells report into a Windows path: `C:\x`, `/C:/x` (file URLs)
/// and `/c/x` (MSYS / Git Bash). Anything else (a WSL path) is dropped.
pub fn normalize_path(p: &str) -> Option<String> {
    let p = p.trim();
    let b = p.as_bytes();
    let win = |drive: u8, rest: &str| {
        let rest = rest.trim_start_matches(['/', '\\']).replace('/', "\\");
        Some(format!("{}:\\{}", (drive as char).to_ascii_uppercase(), rest))
    };
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return win(b[0], &p[2..]);
    }
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        return win(b[1], &p[3..]);
    }
    if b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
        return win(b[1], &p[2..]);
    }
    if p.starts_with("\\\\") {
        return Some(p.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bell_vs_osc_terminator() {
        let mut s = Scanner::default();
        let ev = s.feed(b"\x1b]0;hello\x07text\x07");
        assert_eq!(ev, vec![ScanEvent::Title("hello".into()), ScanEvent::Bell]);
    }

    #[test]
    fn split_across_chunks() {
        let mut s = Scanner::default();
        assert!(s.feed(b"\x1b]9;9;\"C:\\Us").is_empty());
        assert_eq!(s.feed(b"ers\"\x1b\\"), vec![ScanEvent::Cwd("C:\\Users".into())]);
    }

    #[test]
    fn notifications() {
        let mut s = Scanner::default();
        assert_eq!(s.feed(b"\x1b]9;Build finished\x07"), vec![ScanEvent::Notify("Build finished".into())]);
        assert_eq!(s.feed(b"\x1b]777;notify;Claude;Needs you\x1b\\"), vec![ScanEvent::Notify("Claude: Needs you".into())]);
        assert_eq!(s.feed(b"\x1b]9;4;1;42\x07"), vec![ScanEvent::Progress(1, 42)]);
    }

    #[test]
    fn dcs_bel_is_not_a_bell() {
        let mut s = Scanner::default();
        assert!(s.feed(b"\x1bPq#0\x07").is_empty());
    }

    #[test]
    fn paths() {
        assert_eq!(normalize_path("/e/GitProjects"), Some("E:\\GitProjects".into()));
        assert_eq!(normalize_path("/C:/Users/me"), Some("C:\\Users\\me".into()));
        assert_eq!(normalize_path("c:\\x"), Some("C:\\x".into()));
        assert_eq!(normalize_path("/home/me"), None);
        assert_eq!(file_url_path("file://host/C:/My%20Dir"), Some("C:\\My Dir".into()));
    }
}
