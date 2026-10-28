//! Custom notification sounds: files the user adds are copied into Track's
//! data folder, so a screen keeps its sound even if the original moves.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::settings::write_atomic;

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const EXTENSIONS: [&str; 5] = ["wav", "mp3", "ogg", "m4a", "flac"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSound {
    pub id: String,
    pub name: String,
    pub file: String,
}

pub struct Sounds {
    dir: PathBuf,
    index: Mutex<Vec<CustomSound>>,
}

impl Sounds {
    pub fn new(data_dir: &Path) -> Self {
        let dir = data_dir.join("sounds");
        let index = std::fs::read_to_string(dir.join("sounds.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self { dir, index: Mutex::new(index) }
    }

    pub fn list(&self) -> Vec<CustomSound> {
        self.index.lock().unwrap().clone()
    }

    fn save(&self, index: &[CustomSound]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let text = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
        write_atomic(&self.dir.join("sounds.json"), &text).map_err(|e| e.to_string())
    }

    pub fn import(&self, source: &str) -> Result<CustomSound, String> {
        let src = Path::new(source);
        let ext = src.extension().and_then(|e| e.to_str()).map(str::to_lowercase).unwrap_or_default();
        if !EXTENSIONS.contains(&ext.as_str()) {
            return Err("Pick a .wav, .mp3, .ogg, .m4a or .flac file".into());
        }
        let size = std::fs::metadata(src).map_err(|e| e.to_string())?.len();
        if size > MAX_BYTES {
            return Err("That sound is over 5 MB. Notification sounds work best short.".into());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let id: String = (0..10).map(|_| char::from(b'a' + rand::random_range(0..26u8))).collect();
        let file = format!("{id}.{ext}");
        std::fs::copy(src, self.dir.join(&file)).map_err(|e| format!("Couldn't copy the sound: {e}"))?;
        let name = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "Sound".into());
        let sound = CustomSound { id, name, file };
        let mut index = self.index.lock().unwrap();
        index.push(sound.clone());
        self.save(&index)?;
        Ok(sound)
    }

    pub fn read(&self, id: &str) -> Result<Vec<u8>, String> {
        let index = self.index.lock().unwrap();
        let sound = index.iter().find(|s| s.id == id).ok_or("Sound not found")?;
        std::fs::read(self.dir.join(&sound.file)).map_err(|e| e.to_string())
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let mut index = self.index.lock().unwrap();
        if let Some(pos) = index.iter().position(|s| s.id == id) {
            let sound = index.remove(pos);
            let _ = std::fs::remove_file(self.dir.join(&sound.file));
            self.save(&index)?;
        }
        Ok(())
    }
}
