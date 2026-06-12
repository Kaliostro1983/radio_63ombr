#Requires AutoHotkey v2.0
#SingleInstance Force
SetWorkingDir A_ScriptDir

; ── Налаштування ────────────────────────────────────────────────────────────
GenFolder := "C:\Users\1028\Desktop\27.05 53 ОМБр Озерне\1 УПД\Gen"
KeysCsv   := GenFolder . "\keys.csv"
WaitSec   := 2000   ; мілісекунд після "Сгенерировать" (збільш якщо треба)
; ────────────────────────────────────────────────────────────────────────────

if !WinExist("Ведун") {
    MsgBox "Відкрий застосунок 'Ведун' і запусти скрипт знову.", "Помилка", 16
    ExitApp
}
WinActivate "Ведун"
WinWaitActive "Ведун"

; Один раз задаємо keys.csv
SetControlText(WinExist("Ведун"), "Путь к файлу", KeysCsv)

; Перебір папок
folders := []
Loop Files GenFolder . "\*", "D"
    folders.Push(A_LoopFileName)

total := folders.Length
i     := 0

for _, name in folders {
    i++
    ; Парсимо цифри: "0012" → ["1","2"]
    digits := Map()
    loop parse name
        if A_LoopField != "0"
            digits[A_LoopField] := true

    if digits.Count = 0 {
        ToolTip "[" i "/" total "] " name " — пропускаємо"
        continue
    }

    ToolTip "[" i "/" total "] " name

    WinActivate "Ведун"

    ; Чекбокси 1–4
    for _, bit in ["1","2","3","4"] {
        state := digits.Has(bit) ? 1 : 0
        SetCheckbox("Ведун", bit . ".", state)
    }

    ; Шлях до папки
    SetControlText(WinExist("Ведун"), "Путь к папке для новых ключей",
        GenFolder . "\" . name)

    ; Натискаємо "Сгенерировать"
    ControlClick "Сгенерировать", "Ведун"

    Sleep WaitSec
}

ToolTip
MsgBox "Готово! Оброблено: " i " папок.", "Ведун Auto", 64
ExitApp

; ── Допоміжні функції ────────────────────────────────────────────────────────
SetControlText(hwnd, ctrlName, text) {
    try ControlSetText(text, ctrlName, hwnd)
}

SetCheckbox(winTitle, ctrlName, wantChecked) {
    try {
        cur := ControlGetChecked(ctrlName, winTitle)
        if cur != wantChecked
            ControlClick ctrlName, winTitle
    }
}
