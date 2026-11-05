import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_launcher import build_environment, accept_executable


class LauncherBuildTests(unittest.TestCase):
    def test_native_search_path_excludes_external_toolchains(self):
        source = {'SystemRoot': r'C:\Windows', 'PATH': r'C:\tools\poppler;C:\tools\libheif',
                  'PYTHONPATH': 'foreign', 'QT_PLUGIN_PATH': 'foreign'}
        env = build_environment(source)
        self.assertNotIn('poppler', env['PATH'])
        self.assertNotIn('libheif', env['PATH'])
        self.assertIn(r'C:\Windows\System32', env['PATH'])
        self.assertNotIn('PYTHONPATH', env)
        self.assertNotIn('QT_PLUGIN_PATH', env)
        self.assertEqual(source['PYTHONPATH'], 'foreign')

    def test_exit_zero_without_window_report_is_not_success(self):
        with tempfile.TemporaryDirectory() as folder, patch('build_launcher.subprocess.run'):
            root = Path(folder)
            with self.assertRaises(FileNotFoundError):
                accept_executable(root / 'app.exe', root, {})
            (root / 'self-test.json').write_text(json.dumps({'ok': False, 'pages': 6}))
            with self.assertRaises(RuntimeError):
                accept_executable(root / 'app.exe', root, {})

    def test_real_window_report_is_required(self):
        with tempfile.TemporaryDirectory() as folder, patch('build_launcher.subprocess.run') as run:
            root = Path(folder)
            (root / 'self-test.json').write_text(json.dumps({'ok': True, 'pages': 6}))
            self.assertTrue(accept_executable(root / 'app.exe', root, {})['ok'])
            self.assertEqual(run.call_args.kwargs['env']['LINSHE_LAUNCHER_TEST_RESULT'], str(root / 'self-test.json'))
