//! The workspace: screens, their terminals and how they're laid out. The UI
//! owns its shape; Rust stores it and reads just enough of it to describe
//! Track in Holster's preview.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::Value;

use crate::settings::write_atomic;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScreenSummary {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub terminals: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TermSummary {
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Summary {
    pub screens: Vec<ScreenSummary>,
    pub terms: std::collections::HashMap<String, TermSummary>,
    pub active_screen: String,
}

impl Summary {
    pub fn screen_of(&self, term: &str) -> Option<&ScreenSummary> {
        self.screens.iter().find(|s| s.terminals.iter().any(|t| t == term))
    }
}

pub struct Store {
    path: PathBuf,
    summary: Mutex<Summary>,
}

impl Store {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("workspace.json");
        let summary = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Summary>(&t).ok())
            .unwrap_or_default();
        Self { path, summary: Mutex::new(summary) }
    }

    pub fn load(&self) -> Option<Value> {
        let text = std::fs::read_to_string(&self.path).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self, ws: Value) -> Result<(), String> {
        let summary: Summary = serde_json::from_value(ws.clone()).unwrap_or_default();
        *self.summary.lock().unwrap() = summary;
        let text = serde_json::to_string_pretty(&ws).map_err(|e| e.to_string())?;
        write_atomic(&self.path, &text).map_err(|e| format!("Couldn't save the workspace: {e}"))
    }

    pub fn summary(&self) -> Summary {
        self.summary.lock().unwrap().clone()
    }
}
