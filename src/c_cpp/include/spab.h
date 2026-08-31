/* spab — C/C++ public header (skeleton; not yet implemented).
 *
 * Mirrors the reference implementation (src/js/spab.js) and the frozen wire-format
 * spec in r_and_d/docs. C++17, zero third-party dependencies. Planned surface:
 *
 *   int spab_encode(const char *base_text, const uint8_t *msg, size_t msg_len,
 *                   const uint8_t *key, size_t key_len,
 *                   const spab_options *opts,
 *                   char **out_text, spab_meta *out_meta);
 *   int spab_decode(const char *marked_text,
 *                   const uint8_t *key, size_t key_len,
 *                   const spab_options *opts,
 *                   uint8_t **out_msg, size_t *out_len, spab_meta *out_meta);
 */
#ifndef SPAB_H
#define SPAB_H
/* Intentionally minimal until the port is implemented and validated against the
   shared conformance test vectors. */
#endif /* SPAB_H */
