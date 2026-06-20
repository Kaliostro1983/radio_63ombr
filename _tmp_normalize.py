import json
from app.core.db import get_conn
from app.core.analytical_intercept_parser import RE_MGRS_ANY, _normalize_mgrs


def norm(s):
    raw = str(s or "").strip()
    m = RE_MGRS_ANY.search(raw)
    if m:
        return _normalize_mgrs(m.group(1), m.group(2), m.group(3), m.group(4), m.group(5))
    return raw


with get_conn() as conn:
    rows = conn.execute(
        "SELECT id, mgrs_json FROM analytical_conclusions"
    ).fetchall()
    changed = 0
    for r in rows:
        try:
            arr = json.loads(r["mgrs_json"] or "[]")
        except Exception:
            continue
        if not isinstance(arr, list):
            continue
        new = [norm(x) for x in arr]
        if new != arr:
            conn.execute(
                "UPDATE analytical_conclusions SET mgrs_json = ? WHERE id = ?",
                (json.dumps(new, ensure_ascii=False), r["id"]),
            )
            changed += 1
    conn.commit()
    print("rows total:", len(rows), "| normalized:", changed)
