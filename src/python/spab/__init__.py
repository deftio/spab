"""spab — Python port (skeleton, not yet implemented).

Will mirror the reference implementation (src/js/spab.js) and the frozen wire-format
spec in r_and_d/docs, with zero third-party dependencies. Planned surface:

    def encode(base_text: str, message: bytes, key: bytes | None = None,
               options: dict | None = None) -> tuple[str, dict]: ...
    def decode(marked_text: str, key: bytes | None = None,
               options: dict | None = None) -> tuple[bytes, dict]: ...
"""

__version__ = "0.1.0"


def encode(*_args, **_kwargs):
    raise NotImplementedError("spab Python port not yet implemented")


def decode(*_args, **_kwargs):
    raise NotImplementedError("spab Python port not yet implemented")
