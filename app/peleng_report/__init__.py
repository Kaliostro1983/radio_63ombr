"""Peleng report generation subsystem.

This package contains the parsing and DOCX generation logic used to build
peleng (direction finding) reports:

- `parser.py` parses WhatsApp/exported text into structured records;
- `report.py` renders records into a DOCX document;
- `runner.py` provides a script-style entrypoint for local/offline use;
- `mgrs.py` contains small MGRS validation helpers.

The web application uses this package via service/router layers.
"""

# app/peleng_report/__init__.py
# Peleng report package