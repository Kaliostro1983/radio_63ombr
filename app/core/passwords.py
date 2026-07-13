"""Хешування паролів (Фаза 2B.2) — лише stdlib, без нових залежностей.

PBKDF2-HMAC-SHA256. Формат зберігання в `users`:
- `pw_algo`  = "pbkdf2_sha256$<iterations>"
- `pw_salt`  = hex(salt)
- `pw_hash`  = hex(derived key)

Паролі задають самі користувачі (через сторінки login/setup); у відкритому
вигляді ніде не зберігаються й не логуються.
"""

from __future__ import annotations

import hashlib
import hmac
import os

_ALGO = "pbkdf2_sha256"
_ITERATIONS = 210_000
_SALT_BYTES = 16


def hash_password(password: str) -> tuple[str, str, str]:
    """Повертає (algo, salt_hex, hash_hex) для збереження в `users`."""
    salt = os.urandom(_SALT_BYTES)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _ITERATIONS)
    return f"{_ALGO}${_ITERATIONS}", salt.hex(), dk.hex()


def verify_password(
    password: str,
    algo: str | None,
    salt_hex: str | None,
    hash_hex: str | None,
) -> bool:
    """Перевірити пароль проти збережених algo/salt/hash (constant-time)."""
    if not (algo and salt_hex and hash_hex):
        return False
    try:
        name, iters = algo.split("$", 1)
        if name != _ALGO:
            return False
        iterations = int(iters)
        salt = bytes.fromhex(salt_hex)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False
