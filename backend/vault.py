"""
Ironclad Vault — encrypts secrets (API keys, the Tradovate password) at
rest in settings.json, so a copy of that file on disk or in a backup is
useless without the local key file it never travels with.

Not a DPAPI equivalent (DPAPI is Windows-only and ties a secret to the
signed-in Windows user — this backend runs cross-platform), so this uses a
locally-generated symmetric key instead: Fernet (AES-128-CBC + HMAC, via the
`cryptography` package) with the key stored in its own file, chmod'd to
owner-only where the OS supports it, and gitignored — the same trust model
DPAPI has in practice (secrecy of the local machine), without the
Windows-only API.
"""
from __future__ import annotations

import os
import stat

from cryptography.fernet import Fernet, InvalidToken

_VAULT_KEY_FILE = os.path.join(os.path.dirname(__file__), ".vault_key")
_ENC_PREFIX = "enc:v1:"

_fernet: Fernet | None = None


def _load_or_create_key() -> bytes:
    if os.path.exists(_VAULT_KEY_FILE):
        with open(_VAULT_KEY_FILE, "rb") as f:
            return f.read().strip()
    key = Fernet.generate_key()
    # Create with owner-only permissions from the start rather than
    # chmod-ing after the fact, which would leave a window where the key is
    # world-readable on a multi-user machine.
    fd = os.open(_VAULT_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IRUSR | stat.S_IWUSR)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
    return key


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt(plaintext: str) -> str:
    """Encrypts a non-empty secret for storage. Empty strings pass through
    unchanged (nothing to protect, and keeps settings.json's "unset" fields
    reading as plain empty strings rather than an encrypted-empty-string)."""
    if not plaintext:
        return plaintext
    token = _get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")
    return _ENC_PREFIX + token


def decrypt(value: str) -> str:
    """Decrypts a value produced by encrypt(). A value with no enc:v1:
    prefix is treated as legacy plaintext (from before the vault existed, or
    a value that failed to decrypt) and returned as-is — load_settings()
    must never raise or silently blank out a secret the user already
    configured just because it predates encryption."""
    if not value or not value.startswith(_ENC_PREFIX):
        return value
    token = value[len(_ENC_PREFIX):]
    try:
        return _get_fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        # Corrupt entry or a key file that no longer matches (e.g. restored
        # settings.json without its matching .vault_key) — surfacing this as
        # an empty secret (forcing re-entry) is safer than crashing every
        # endpoint that calls load_settings().
        return ""


def is_encrypted(value: str) -> bool:
    return bool(value) and value.startswith(_ENC_PREFIX)
