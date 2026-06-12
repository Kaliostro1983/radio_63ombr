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


def fold_code(value: str) -> str:
    """Return the canonical fold key for a palette point code.

    Розкладко- та регістронезалежний ключ: UPPERCASE, конфузіблі кирилиці →
    латинські двійники, схлопнуті пробіли.
    """
    if not value:
        return ""
    up = value.strip().upper()
    out = []
    for ch in up:
        out.append(_CONFUSABLE.get(ch, ch))
    folded = "".join(out)
    # Collapse any internal whitespace runs to a single space.
    return " ".join(folded.split())


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
