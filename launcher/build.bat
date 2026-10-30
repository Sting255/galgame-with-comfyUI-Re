@echo off
chcp 65001 >nul
echo ========================================
echo   邻舍.EXE 打包脚本
echo ========================================
echo.

cd /d "%~dp0"

echo [1/3] 安装依赖...
pip install PySide6 psutil pyinstaller
if %errorlevel% neq 0 (
    echo [ERROR] 依赖安装失败
    exit /b 1
)

echo.
echo [2/3] PyInstaller 打包...
pyinstaller ^
  --onefile ^
  --windowed ^
  --name "邻舍.EXE" ^
  --icon "assets/icon.ico" ^
  --add-data "assets/launchHeader.jpg;assets" ^
  --add-data "assets/icon.ico;assets" ^
  --add-data "assets/navbar-title.png;assets" ^
  --add-data "assets/MiSans-Regular.ttf;assets" ^
  --hidden-import PySide6.QtCore ^
  --hidden-import PySide6.QtGui ^
  --hidden-import PySide6.QtWidgets ^
  --hidden-import PySide6.QtNetwork ^
  --clean ^
  --noconfirm ^
  main.py

if %errorlevel% neq 0 (
    echo [ERROR] 打包失败
    exit /b 1
)

echo.
echo [3/3] 复制到项目根目录...
copy /Y "dist\邻舍.EXE.exe" "..\邻舍.EXE.exe"
if %errorlevel% neq 0 (
    echo [ERROR] 复制失败
    exit /b 1
)

rem 2026-10-30：本机 python 没装 PySide6 时，PyInstaller 不报错、照样产出一个 15 MB 的空壳 exe，
rem 换台机器启动就报 "No module named 'PySide6'"。带 Qt 的正常体积在 50 MB 以上，这里按体积兜底。
for %%A in ("..\邻舍.EXE.exe") do set "LAUNCHER_SIZE=%%~zA"
if %LAUNCHER_SIZE% LSS 30000000 (
    echo [ERROR] 打出来的启动器只有 %LAUNCHER_SIZE% 字节，PySide6 没有打进去。
    echo         先执行：pip install PySide6 psutil pyinstaller
    exit /b 1
)

echo.
echo ========================================
echo   打包完成!
echo   输出: ..\邻舍.EXE.exe
echo ========================================
pause
