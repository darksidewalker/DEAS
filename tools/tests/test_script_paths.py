"""Small offline checks for developer-script paths; no builds, services or installs."""
import ast
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
LINUX_PROBES = [
    'tools/verify_webkit_view.py', 'tools/verify_webkit_stars.py',
    'tools/verify_component_pickers.py', 'tools/verify_settings_selectors.py',
    'tools/verify_native_video.py', 'tools/verify_native_media_drag.py',
    'tools/verify_video_playback.py', 'tools/test_matroska_rescan.py',
    'src-tauri/verify_resolution.py',
]


class ScriptPathTests(unittest.TestCase):
    def test_repository_text_io_is_explicit_utf8(self):
        for path in [*ROOT.joinpath('tools').glob('*.py'), *ROOT.joinpath('src-tauri').glob('verify_*.py')]:
            tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ('read_text', 'write_text'):
                    with self.subTest(script=path.name, line=node.lineno):
                        encodings = [ast.literal_eval(k.value) for k in node.keywords if k.arg == 'encoding']
                        self.assertEqual(encodings, ['utf-8'])

    def test_linux_probes_reject_windows_before_optional_imports_or_writes(self):
        for name in LINUX_PROBES:
            with self.subTest(script=name), mock.patch.object(sys, 'platform', 'win32'):
                with self.assertRaisesRegex(SystemExit, 'Linux'):
                    runpy.run_path(str(ROOT / name), run_name='__main__')

    def test_graph_paths_are_resolved_before_chdir(self):
        with tempfile.TemporaryDirectory(prefix='deas paths 猫 # ') as temp:
            caller = Path(temp)
            comfy = caller / 'Comfy UI'
            (comfy / 'comfy').mkdir(parents=True)
            (comfy / 'nodes.py').touch()
            (comfy / 'comfy/__init__.py').touch()
            # Stop at the import boundary: inspect real argument setup without loading ComfyUI.
            (comfy / 'comfy/options.py').write_text(
                'import json, os, sys\n'
                'def enable_args_parsing():\n'
                '    caller = sys._getframe(1).f_globals\n'
                '    print(json.dumps([os.getcwd(), str(caller["GRAPHS"]), sys.argv]))\n'
                '    sys.exit(0)\n', encoding='utf-8')
            graphs, config = caller / 'graphs 猫.json', caller / 'model paths.yaml'
            graphs.write_text('{}', encoding='utf-8')
            config.write_text('{}', encoding='utf-8')
            command = [sys.executable, str(ROOT / 'tools/validate_video_graphs.py'), graphs.name,
                       '--comfy-root', comfy.name, '--extra-model-paths-config', config.name]
            result = subprocess.run(command, cwd=caller, capture_output=True, encoding='utf-8', timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), [str(comfy.resolve()), str(graphs.resolve()),
                             ['probe', '--cpu', '--extra-model-paths-config', str(config.resolve())]])
            config.unlink()
            result = subprocess.run(command, cwd=caller, capture_output=True, encoding='utf-8', timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn('must exist', result.stderr)

    def test_scratch_diagnostics_do_not_require_tmpdir(self):
        with tempfile.TemporaryDirectory(prefix='deas scratch 猫 ') as temp:
            env = dict(os.environ)
            env.pop('TMPDIR', None)
            with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(tempfile, 'tempdir', temp):
                # No metadata/network tasks: only exercise report output selection.
                with mock.patch.object(ThreadPoolExecutor, 'map', return_value=[]):
                    runpy.run_path(str(ROOT / 'src-tauri/verify_wheel_metadata.py'), run_name='__main__')
                self.assertEqual(json.loads((Path(temp) / 'deas-wheel-metadata.json').read_text(encoding='utf-8')), [])
                # Stop before network access, after real scratch creation and platform validation.
                with mock.patch.object(sys, 'platform', 'linux'), \
                     mock.patch.object(os, 'uname', return_value=SimpleNamespace(machine='x86_64'), create=True), \
                     mock.patch('urllib.request.urlopen', side_effect=OSError('network disabled by test')):
                    with self.assertRaisesRegex(OSError, 'network disabled by test'):
                        runpy.run_path(str(ROOT / 'src-tauri/verify_resolution.py'), run_name='__main__')
                self.assertFalse(list(Path(temp).glob('deas-resolver-*')))


if __name__ == '__main__':
    unittest.main()
