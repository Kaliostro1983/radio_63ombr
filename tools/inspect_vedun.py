"""
Запусти при відкритому "Ведун" — виведе всі назви контролів у вікні.
Потрібно один раз, щоб перевірити точні назви перед запуском автоматизації.
"""
from pywinauto import Application, findwindows

titles = findwindows.find_element_properties(title_re=".*Ведун.*")
print("Знайдені вікна:", [t.get("title") for t in titles])

app = Application(backend="uia").connect(title_re=".*Ведун.*")
dlg = app.top_window()
dlg.print_control_identifiers()
