// spab — Swift port (skeleton, not yet implemented).
//
// Will mirror the reference implementation (src/js/spab.js) and the frozen wire-format
// spec in r_and_d/docs, with zero third-party dependencies. Planned surface:
//
//   public func encode(_ baseText: String, _ message: [UInt8], key: [UInt8]?, options: Options)
//       throws -> (text: String, meta: Meta)
//   public func decode(_ markedText: String, key: [UInt8]?, options: Options)
//       throws -> (message: [UInt8], meta: Meta)
//
// Intentionally empty until the port is implemented and validated against the shared
// conformance test vectors.
