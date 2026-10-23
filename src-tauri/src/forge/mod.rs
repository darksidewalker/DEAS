//! Prompt Forge for the image models (Illustrious, Anima, Krea2, MOSS), run
//! natively instead of through the node pack's Prompt Writer: character canon
//! from the local tables, the tag-search and guidance tools in the writing
//! loop, and the mechanical clean-up after it. Ported from PromptForge; the
//! MiniMax H3 Director Forge stays on the node pack.

pub mod appearance;
pub mod canon;
pub mod character;
pub mod chat;
pub mod clean;
pub mod engine;
pub mod message;
pub mod pack;
pub mod picker;
pub mod randomizer;
pub mod refs;
pub mod segments;
pub mod tags;
pub mod tools;

pub use engine::{native_forge_revise, native_forge_targets, native_forge_write};
