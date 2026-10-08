@echo off
echo Building LibreHardwareAgent Executable...
python -m PyInstaller --name LibreHardwareAgent --onefile --add-data "static;static" --hidden-import uvicorn --hidden-import fastapi main.py
echo.
echo Build complete! The executable is located in the "dist" folder.
pause
