"""Explicit uv 0.8.22 resolution smoke in scratch; never installs a GPU stack.
Uses --dry-run and --only-binary; sources are fetched read-only. No user venv.
"""
import hashlib
import io
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

if __name__ == '__main__':
    if sys.platform != 'linux' or os.uname().machine != 'x86_64':
        sys.exit('This pinned uv/Linux wheel resolution diagnostic requires Linux x86_64; not Windows acceptance.')
    with tempfile.TemporaryDirectory(prefix='deas-resolver-') as directory:
        root = pathlib.Path(directory)
        url = 'https://github.com/astral-sh/uv/releases/download/0.8.22/uv-x86_64-unknown-linux-gnu.tar.gz'
        data = urllib.request.urlopen(url, timeout=60).read()
        assert hashlib.sha256(data).hexdigest() == '741ff1f5742c5a4a25d2f829e8395355e43f7a5ae2ebc6368e9ae2df0efb69cf'
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            member = archive.extractfile('uv-x86_64-unknown-linux-gnu/uv')
            assert member is not None
            executable = member.read()
        uv = root / 'uv'
        uv.write_bytes(executable)
        uv.chmod(0o700)
        requirements = root / 'requirements.txt'
        node_requirements = root / 'node-requirements.txt'
        for target, source in [(requirements, 'https://raw.githubusercontent.com/comfyanonymous/ComfyUI/master/requirements.txt'), (node_requirements, 'https://raw.githubusercontent.com/darksidewalker/ComfyUI-DaSiWa-Nodes/main/requirements.txt')]:
            content = urllib.request.urlopen(source, timeout=60).read()
            target.write_bytes(content)
            print(source, hashlib.sha256(content).hexdigest(), flush=True)
        constraints = root / 'constraints.txt'
        constraints.write_text('torch==2.14.1+cu130\ntorchvision==0.29.1+cu130\ntorchaudio==2.11.0+cu130\n', encoding='utf-8')
        env = {'PATH': os.environ['PATH'], 'HOME': str(root), 'UV_CACHE_DIR': str(root / 'cache'), 'UV_NO_CONFIG': '1', 'UV_PYTHON_INSTALL_DIR': str(root / 'runtime/python'), 'UV_PYTHON_BIN_DIR': str(root / 'runtime/bin'), 'TMPDIR': str(root)}
        subprocess.run([str(uv), 'python', 'install', '--managed-python', '--no-bin', '3.12'], env=env, cwd=root, check=True, timeout=120)
        subprocess.run([str(uv), 'venv', '--managed-python', '--python', '3.12', str(root / 'venv')], env=env, cwd=root, check=True, timeout=60)
        args = [str(uv), 'pip', 'install', '--dry-run', '--python', str(root / 'venv/bin/python'), '--python-version', '3.12', '--python-platform', 'x86_64-unknown-linux-gnu', '--only-binary', ':all:', '--index', 'https://download.pytorch.org/whl/cu130', '--constraint', str(constraints), '-r', str(requirements), 'torchaudio==2.11.0']
        if '--include-nodes' in sys.argv:
            args.extend(['-r', str(node_requirements)])
        subprocess.run(args, env=env, cwd=root, check=True, timeout=180)
