"""
Автоматизація генерації ключів у "Ведун".

Логіка назви папки → чекбокси:
  "0001" → {1}
  "0012" → {1, 2}
  "0123" → {1, 2, 3}
  "1234" → {1, 2, 3, 4}

Запуск:
  pip install pywinauto
  python automate_vedun.py "C:\\шлях\\до\\Gen" "C:\\шлях\\до\\Gen\\keys.csv"
"""

import sys
import os
import time
from pywinauto import Application

# ── Параметри (можна змінити тут або передати як аргументи) ──────────────────
GEN_FOLDER = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\1028\Desktop\27.05 53 ОМБр Озерне\1 УПД\Gen"
KEYS_CSV   = sys.argv[2] if len(sys.argv) > 2 else os.path.join(GEN_FOLDER, "keys.csv")

# Затримка після натискання "Сгенерировать" (секунди).
# Збільш, якщо генерація займає більше часу.
GENERATE_WAIT = 2.0
# ─────────────────────────────────────────────────────────────────────────────


def parse_digits(folder_name: str) -> set:
    """'0012' → {'1','2'},  '1234' → {'1','2','3','4'}"""
    return set(folder_name.replace("0", ""))


def get_subfolders(base: str) -> list:
    entries = sorted(os.listdir(base))
    return [e for e in entries if os.path.isdir(os.path.join(base, e))]


def connect_vedun():
    try:
        return Application(backend="uia").connect(title_re=".*Ведун.*", timeout=5)
    except Exception:
        print("ERROR: Вікно 'Ведун' не знайдено. Переконайся, що застосунок відкритий.")
        sys.exit(1)


def set_text_field(dlg, control_name: str, value: str):
    ctrl = dlg[control_name]
    ctrl.set_focus()
    ctrl.set_edit_text(value)


def set_checkbox(dlg, label: str, checked: bool):
    """label — назва чекбоксу, наприклад '1.' або '1'"""
    for variant in (label + ".", label, label + " ."):
        try:
            cb = dlg[variant]
            if checked:
                cb.check_by_click() if not cb.get_check_state() else None
            else:
                cb.uncheck_by_click() if cb.get_check_state() else None
            return
        except Exception:
            continue
    print(f"  WARN: чекбокс '{label}' не знайдено — пропускаємо")


def main():
    if not os.path.isfile(KEYS_CSV):
        print(f"ERROR: файл keys.csv не знайдено: {KEYS_CSV}")
        sys.exit(1)

    subfolders = get_subfolders(GEN_FOLDER)
    if not subfolders:
        print("ERROR: папок у Gen не знайдено")
        sys.exit(1)

    print(f"Знайдено {len(subfolders)} папок у {GEN_FOLDER}")
    print(f"keys.csv: {KEYS_CSV}\n")

    app = connect_vedun()
    dlg = app.top_window()

    # Один раз задаємо keys.csv
    try:
        set_text_field(dlg, "Путь к файлу", KEYS_CSV)
        print(f"keys.csv встановлено: {KEYS_CSV}")
    except Exception as e:
        print(f"WARN: не вдалося встановити keys.csv автоматично: {e}")
        print("      Встанови шлях вручну та натисни Enter тут...")
        input()

    print()

    for idx, folder_name in enumerate(subfolders, 1):
        folder_path = os.path.join(GEN_FOLDER, folder_name)
        digits = parse_digits(folder_name)

        if not digits:
            print(f"[{idx}/{len(subfolders)}] {folder_name} — пропускаємо (немає цифр)")
            continue

        print(f"[{idx}/{len(subfolders)}] {folder_name} → чекбокси: {sorted(digits)}")

        # Встановлюємо/знімаємо чекбокси 1–4
        for bit in "1234":
            set_checkbox(dlg, bit, bit in digits)

        # Задаємо папку призначення
        try:
            set_text_field(dlg, "Путь к папке для новых ключей", folder_path)
        except Exception as e:
            print(f"  WARN: не вдалося встановити шлях папки: {e}")

        # Натискаємо "Сгенерировать"
        try:
            dlg["Сгенерировать"].click()
        except Exception:
            try:
                dlg["Сгенерировать"].invoke()
            except Exception as e:
                print(f"  ERROR: не вдалося натиснути 'Сгенерировать': {e}")
                continue

        time.sleep(GENERATE_WAIT)

    print("\nГотово!")


if __name__ == "__main__":
    main()
