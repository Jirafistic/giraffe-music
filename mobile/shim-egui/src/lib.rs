//! `model.rs` de ytm-rs usa `egui::Rect` en una función de dibujo; acá alcanza con el tipo.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pos2 {
    pub x: f32,
    pub y: f32,
}

pub fn pos2(x: f32, y: f32) -> Pos2 {
    Pos2 { x, y }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub min: Pos2,
    pub max: Pos2,
}

impl Rect {
    pub fn from_min_max(min: Pos2, max: Pos2) -> Self {
        Rect { min, max }
    }
}
