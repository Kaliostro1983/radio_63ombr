"""Normalization helpers for palette point codes.

Palette point codes look like ``Т-3`` (letter + dash + digit). The letters may
be typed in either Cyrillic or Latin and the two are visually indistinguishable
for the "confusable" set (``А/A``, ``Т/T`` …). To make search розкладко- та
регістронезалежним we compute a *fold key* for every code:

1. uppercase + trim;
2. map confusable Cyrillic letters to their Latin twin (canonical class);
3. collapse internal whitespace.

Search masks use ``*`` (any run of chars) and ``%`` (exactly one char); these are
translated to SQLite ``GLOB`` wildcards (``*`` and ``?``) applied to ``code_fold``.
Since ``code_fold`` is already uppercased/folded, ``GLOB`` (case-sensitive) behaves
case-insensitively for the user.
"""

from __future__ import annotations

import re

# Розділові знаки в межах коду (між літерою та цифрою тощо), які прибираємо:
# пробіли, дефіси/тире, підкреслення, крапка, середня крапка. НЕ чіпаємо
# підстановки масок ``*``/``%`` і GLOB-спецсимволи ``[]?`` — вони потрібні
# для пошуку за маскою (mask_to_glob).
_SEP_RE = re.compile(r"[\s‐-―\-_.·]+")

# Cyrillic uppercase → visually identical Latin uppercase.
# Only includes letters that are genuine homoglyphs; non-confusable Cyrillic
# letters (Б, Г, Д, Ж …) are left as-is so they never collide with Latin codes.
_CONFUSABLE = {
    "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H",
    "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
    "І": "I", "Ї": "I", "Ј": "J", "Ѕ": "S", "Қ": "K",
    # Ukrainian / Russian extras occasionally seen in exports.
    "Ё": "E", "Й": "Y",
}

_GLOB_SPECIALS = set("*?[]")


def display_code(value: str) -> str:
    """Нормалізований *видимий* код палітри: UPPERCASE + без розділових знаків,
    зі збереженням абетки (кирилиця лишається кирилицею, латиниця — латиницею).

    Уніфікація позначень: ``г-11`` / ``г 11`` / ``Г-11`` → ``Г11``; ``z-108`` →
    ``Z108``. Конфузіблі НЕ перекладаємо (це лише для пошукового ключа fold_code).
    """
    if not value:
        return ""
    return _SEP_RE.sub("", value.strip().upper())


def fold_code(value: str) -> str:
    """Return the canonical fold key for a palette point code.

    Розкладко- та регістронезалежний ключ: UPPERCASE, конфузіблі кирилиці →
    латинські двійники, БЕЗ розділових знаків (``г-11`` ≡ ``Г 11`` ≡ ``Г11``).
    Підстановки масок ``*``/``%`` зберігаються (їх обробляє mask_to_glob).
    """
    if not value:
        return ""
    up = value.strip().upper()
    folded = "".join(_CONFUSABLE.get(ch, ch) for ch in up)
    # Прибираємо розділові знаки (між літерою та цифрою тощо).
    return _SEP_RE.sub("", folded)


def mask_to_glob(mask: str) -> str:
    """Translate a user search mask into a SQLite GLOB pattern over ``code_fold``.

    User syntax:
        ``*`` → будь-який набір символів (включно з порожнім)
        ``%`` → рівно один будь-який символ

    The mask is first folded (so ``А-3*`` and ``A-3*`` behave identically), then
    GLOB-special characters in the literal parts are neutralised so they cannot
    be interpreted as GLOB syntax.
    """
    folded = fold_code(mask)
    out = []
    for ch in folded:
        if ch == "*":
            out.append("*")
        elif ch == "%":
            out.append("?")
        elif ch in _GLOB_SPECIALS:
            # Neutralise stray GLOB metacharacters from the literal text:
            # GLOB has no escape, so match them via a single-char class.
            out.append(f"[{ch}]")
        else:
            out.append(ch)
    return "".join(out)


def is_mask(value: str) -> bool:
    """True if the query string contains mask wildcards (``*`` or ``%``)."""
    return "*" in (value or "") or "%" in (value or "")
