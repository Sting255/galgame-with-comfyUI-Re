"""Build and accept the launcher before replacing any usable executable."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def build_environment(source=None):
    env = dict(os.environ if source is None else source)
    windows = Path(env.get('SystemRoot', r'C:\Windows'))
    # PyInstaller resolves native dependencies from PATH. Poppler/Java/Conda
    # can supply an incompatible ICU or CRT under the same filename.
    env['PATH'] = os.pathsep.join(map(str, [Path(sys.executable).parent,
        Path(sys.base_prefix), windows / 'System32', windows, windows / 'System32/Wbem']))
    for key in list(env):
        if key.upper() in {'PYTHONPATH', 'PYTHONHOME', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH'}:
            del env[key]
    env['PYTHONUTF8'] = '1'
    return env


def normalize_executable_integrity(executable):
    """构建目录可能带可继承的 Low 完整性标签；只修正最终 EXE，不改项目目录权限。"""
    if os.name != 'nt':
        return
    windows = Path(os.environ.get('SystemRoot', r'C:\Windows'))
    subprocess.run([str(windows / 'System32' / 'icacls.exe'),
                    str(Path(executable).resolve()), '/setintegritylevel', 'M'],
                   check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def accept_executable(executable, workspace, env):
    report = workspace / 'self-test.json'
    run_env = {**env, 'LINSHE_LAUNCHER_TEST_RESULT': str(report)}
    subprocess.run([str(executable), '--self-test'], env=run_env, cwd=workspace,
                   check=True, timeout=45, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    result = json.loads(report.read_text(encoding='utf-8'))
    if not result.get('ok') or result.get('pages', 0) < 6:
        raise RuntimeError(f'Launcher window acceptance failed: {result}')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    # 只修正已存在 EXE 的完整性标签，不重新打包。
    # 发布脚本（scripts/build.mjs、scripts/build-release.mjs）在把 EXE 复制到目标位置后
    # 需要再归一化一次：复制到项目根目录 / 发布目录后可能继承不同的完整性标签，
    # 构建目录里自检通过不代表目标位置也能启动。此前这两个调用方传了这个参数，
    # 但解析器根本没有声明它 ⇒ `npm run release` 与 `npm run build` 在该步确定性失败。
    parser.add_argument('--normalize-integrity', type=Path, metavar='EXE',
                        help='只修正指定 EXE 的完整性标签后退出')
    args = parser.parse_args()

    if args.normalize_integrity is not None:
        target = args.normalize_integrity.resolve()
        if not target.is_file():
            raise SystemExit(f'--normalize-integrity 指向的文件不存在: {target}')
        normalize_executable_integrity(target)
        print(f'Normalized integrity: {target}')
        return

    root = Path(__file__).resolve().parent
    output = (args.output or root / 'dist' / '邻舍.EXE.exe').resolve()
    env = build_environment()
    subprocess.run([sys.executable, '-c', 'from PySide6.QtWidgets import QApplication; import PyInstaller, psutil'],
                   env=env, check=True)
    with tempfile.TemporaryDirectory(prefix='linshe-launcher-build-') as folder:
        work = Path(folder)
        command = [sys.executable, '-m', 'PyInstaller', '--onefile', '--windowed',
                   '--name', '邻舍.EXE', '--icon', str(root / 'assets/icon.ico'),
                   '--distpath', str(work / 'dist'), '--workpath', str(work / 'build'),
                   '--specpath', str(work), '--clean', '--noconfirm', '--noupx']
        for name in ['launchHeader.jpg', 'icon.ico', 'navbar-title.png', 'MiSans-Regular.ttf']:
            command += ['--add-data', f'{root / "assets" / name};assets']
        for module in ['QtCore', 'QtGui', 'QtWidgets', 'QtNetwork']:
            command += ['--hidden-import', f'PySide6.{module}']
        subprocess.run(command + [str(root / 'main.py')], env=env, cwd=root, check=True)
        exe = work / 'dist' / '邻舍.EXE.exe'
        # 上游 v4.3.0：先修正 EXE 的完整性标签，否则自检会因 Low 标签无法启动
        normalize_executable_integrity(exe)
        result = accept_executable(exe, work, env)
        output.parent.mkdir(parents=True, exist_ok=True)
        staged = output.with_suffix('.exe.new')
        try:
            shutil.copy2(exe, staged)
            os.replace(staged, output)
        finally:
            staged.unlink(missing_ok=True)
        print(f'Accepted launcher: {result}; output: {output}')


if __name__ == '__main__':
    main()
