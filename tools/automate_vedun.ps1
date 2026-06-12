# Автоматизація "Ведун" через вбудований UI Automation (.NET)
# Запуск: правою кнопкою → "Виконати в PowerShell"
# Або з терміналу: powershell -ExecutionPolicy Bypass -File automate_vedun.ps1

param(
    [string]$GenFolder = "C:\Users\1028\Desktop\27.05 53 ОМБр Озерне\1 УПД\Gen",
    [string]$KeysCsv   = ""
)

if (-not $KeysCsv) { $KeysCsv = Join-Path $GenFolder "keys.csv" }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE  = [System.Windows.Automation.AutomationElement]
$TS  = [System.Windows.Automation.TreeScope]
$PC  = [System.Windows.Automation.PropertyCondition]

# ── Знаходимо вікно Ведун ──────────────────────────────────────────────────
$root  = $AE::RootElement
$vedun = $root.FindFirst($TS::Children,
    (New-Object $PC $AE::NameProperty, "Ведун"))

if (-not $vedun) {
    Write-Host "ERROR: Вікно 'Ведун' не знайдено. Відкрий застосунок і спробуй знову."
    Read-Host "Натисни Enter для виходу"
    exit 1
}

# ── Допоміжні функції ──────────────────────────────────────────────────────
function Find-Control($parent, $name) {
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name)
    return $parent.FindFirst(
        [System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Set-FieldText($ctrl, $text) {
    $vp = $ctrl.GetCurrentPattern(
        [System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($text)
}

function Set-Checkbox($parent, $label, [bool]$shouldBeChecked) {
    $ctrl = Find-Control $parent $label
    if (-not $ctrl) { Write-Host "  WARN: чекбокс '$label' не знайдено"; return }
    $tp    = $ctrl.GetCurrentPattern(
        [System.Windows.Automation.TogglePattern]::Pattern)
    $isOn  = $tp.Current.ToggleState -eq `
        [System.Windows.Automation.ToggleState]::On
    if ($shouldBeChecked -ne $isOn) { $tp.Toggle() }
}

function Click-Button($parent, $name) {
    $ctrl = Find-Control $parent $name
    if (-not $ctrl) { Write-Host "  ERROR: кнопка '$name' не знайдена"; return }
    $ip = $ctrl.GetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern)
    $ip.Invoke()
}

# ── Один раз задаємо keys.csv ──────────────────────────────────────────────
$keysField = Find-Control $vedun "Путь к файлу"
if ($keysField) {
    Set-FieldText $keysField $KeysCsv
    Write-Host "keys.csv: $KeysCsv"
} else {
    Write-Host "WARN: поле 'Путь к файлу' не знайдено — встанови вручну"
    Read-Host "Встанови keys.csv вручну і натисни Enter"
}

# ── Перебір папок ──────────────────────────────────────────────────────────
$folders = Get-ChildItem $GenFolder -Directory | Sort-Object Name
$total   = $folders.Count
$i       = 0

foreach ($folder in $folders) {
    $i++
    $name   = $folder.Name
    $digits = $name.ToCharArray() | Where-Object { $_ -ne '0' }

    if (-not $digits) {
        Write-Host "[$i/$total] $name — пропускаємо (немає цифр)"
        continue
    }

    Write-Host "[$i/$total] $name  →  чекбокси: $($digits -join ' ')"

    # Чекбокси 1–4
    foreach ($bit in @("1","2","3","4")) {
        Set-Checkbox $vedun $bit ($bit -in $digits)
    }

    # Шлях до папки
    $folderField = Find-Control $vedun "Путь к папке для новых ключей"
    if ($folderField) { Set-FieldText $folderField $folder.FullName }

    # Генерувати
    Click-Button $vedun "Сгенерировать"

    Start-Sleep -Seconds 2   # збільш якщо генерація йде довше
}

Write-Host "`nГотово! Оброблено папок: $i"
Read-Host "Натисни Enter для виходу"
