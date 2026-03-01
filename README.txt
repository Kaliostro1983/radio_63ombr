Radio networks status service (MVP)

Run (Windows):
1) Put Frequencies_63.xlsx next to start.bat (or set FREQ_XLSX in config.env).
2) Double-click start.bat
3) The app runs on http://127.0.0.1:8000

Tailscale access (recommended):
- Keep the app bound to localhost, then expose via:
  tailscale serve reset
  tailscale serve http://127.0.0.1:8000

You can then open it from other tailnet devices via the Serve name in the Tailscale admin/CLI.
(We’ll use APP_NAME=63ombr as the friendly name in UI, but Tailscale “serve name” is controlled by Tailscale.)

Backups:
- On each startup, if a daily backup wasn't made in the last 24h, the DB is copied to backups/.
- Keeps BACKUP_KEEP last files.

Notes:
- Light/Dark toggle is in the left menu and stored in the browser (localStorage).



PS D:\Armor\radio_63ombr> .\.venv\Scripts\Activate.ps1
(.venv) PS D:\Armor\radio_63ombr> uvicorn app.main:app --reload
INFO:     Will watch for changes in these directories: ['D:\\Armor\\radio_63ombr']
ERROR:    [WinError 10013] An attempt was made to access a socket in a way forbidden by its access permissions
(.venv) PS D:\Armor\radio_63ombr> uvicorn app.main:app --reload --port 8010
