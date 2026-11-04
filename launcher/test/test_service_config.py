import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from launcher.service_config import service_port, belongs_to_project


class ServiceConfigTests(unittest.TestCase):
    def test_port_precedence_and_validation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'agent-core'
            path.mkdir()
            self.assertEqual(service_port(root, {}), 3099)
            (path / '.env').write_text('PORT="3199" # local\n', encoding='utf-8')
            self.assertEqual(service_port(root, {}), 3199)
            self.assertEqual(service_port(root, {'PORT': '3399'}), 3399)
            for value in ['0', '65536', '-1', '3199abc']:
                with self.assertRaises(ValueError):
                    service_port(root, {'PORT': value})

    def test_cleanup_requires_project_directory(self):
        class Process:
            def __init__(self, path): self.path = path
            def cwd(self): return self.path
        with tempfile.TemporaryDirectory() as root:
            self.assertTrue(belongs_to_project(Process(str(Path(root) / 'agent-core')), root))
            self.assertFalse(belongs_to_project(Process(root + '-other'), root))


if __name__ == '__main__':
    unittest.main()
