//! Prompt Forge for the image models (Illustrious, Anima, Krea2, MOSS), run
//! natively instead of through the node pack's Prompt Writer: character canon
//! from the local tables, the tag-search and guidance tools in the writing
//! loop, and the mechanical clean-up after it. Ported from PromptForge; the
//! MiniMax H3 Director Forge stays on the node pack.

pub mod appearance;
pub mod canon;
pub mod character;
pub mod clean;
pub mod segments;
pub mod tags;
