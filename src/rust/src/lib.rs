//! spab — Rust port (skeleton, not yet implemented).
//!
//! Will mirror the reference implementation (`src/js/spab.js`) and the frozen wire-format
//! spec in `r_and_d/docs`, with zero third-party dependencies. Public surface (planned):
//!
//!   pub fn encode(base_text: &str, message: &[u8], key: Option<&[u8]>, options: &Options)
//!        -> Result<(String, Meta), Error>;
//!   pub fn decode(marked_text: &str, key: Option<&[u8]>, options: &Options)
//!        -> Result<(Vec<u8>, Meta), Error>;

// Intentionally empty until the port is implemented and validated against the
// shared conformance test vectors.
