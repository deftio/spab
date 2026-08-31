# spab — library implementations

One implementation per language, all sharing one **wire format** and validated against the same
**conformance test vectors** so they interoperate bit-for-bit. Every port is **dependency-free**
(codec, GF/ECC math, PN/LFSR, hash/KDF, and the ChaCha20-Poly1305 cipher are all hand-implemented).

| Dir | Language | Status | Package |
|-----|----------|--------|---------|
| `js/` | JavaScript (Node + browser) | **reference, baseline `0.1.0`** | npm (`package.json`) |
| `c_cpp/` | C / C++17 | skeleton | CMake |
| `rust/` | Rust | skeleton | Cargo |
| `python/` | Python | skeleton | pyproject |
| `java/` | Java / Kotlin | skeleton | Gradle |

Ports are **not yet written** — the directories hold packaging skeletons and READMEs only. The
reference implementation and the (to-be-frozen) wire-format spec in `r_and_d/docs` are the contract
each port implements. Interpreted languages (JS/Python) ship as importable libraries; compiled
languages (Rust/C/C++/Java) build static/shared libraries plus optional bindings.
