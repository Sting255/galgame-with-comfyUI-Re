@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "BUILD_PY=build_cache\pyinstaller-venv\Scripts\python.exe"
if not exist "%BUILD_PY%" (
  python -m venv build_cache\pyinstaller-venv
  if errorlevel 1 exit /b 1
)
"%BUILD_PY%" -m pip install -r requirements.txt pyinstaller
if errorlevel 1 exit /b 1
"%BUILD_PY%" build_launcher.py --output "..\邻舍.EXE.exe"
if errorlevel 1 exit /b 1
echo 启动器构建及窗口自检通过。
pause
