"""Explicit network check: wheel HEAD/PEP 658 metadata only, never install wheels.
Run python src-tauri/verify_wheel_metadata.py. Scratch report is not GPU acceptance.
"""
import concurrent.futures
import email
import hashlib
import html.parser
import json
import os
import pathlib
import urllib.error
import urllib.parse
import urllib.request

class Links(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a' and 'href' in attrs:
            self.links.append(attrs['href'])

def fetch(url, method='GET'):
    with urllib.request.urlopen(urllib.request.Request(url, method=method), timeout=60) as response:
        return response.status, response.read() if method == 'GET' else b''

def check(item):
    index, package, version = item
    base = f'https://download.pytorch.org/whl/{index}/{package}/'
    parser = Links()
    parser.feed(fetch(base)[1].decode())
    candidates = []
    for link in parser.links:
        name = urllib.parse.unquote(link).split('/')[-1].split('#')[0]
        if name.startswith(f'{package}-{version}+') and '-cp312-cp312-' in name and 'x86_64' in name and ('manylinux' in name or 'linux_x86_64' in name):
            candidates.append(urllib.parse.urljoin(base, link).split('#')[0])
    assert len(candidates) == 1, (item, candidates)
    advertised_url = candidates[0]
    url = advertised_url
    try:
        status, _ = fetch(url, 'HEAD')
    except urllib.error.HTTPError as error:
        if error.code != 403 or urllib.parse.urlsplit(url).hostname != 'download-r2.pytorch.org':
            raise
        # Official PyTorch CDN alias; report both, never hide blocked advertised links.
        url = url.replace('https://download-r2.pytorch.org/', 'https://download.pytorch.org/', 1)
        status, _ = fetch(url, 'HEAD')
    try:
        metadata = fetch(url + '.metadata')[1]
    except urllib.error.HTTPError as error:
        if index != 'cu121' or error.code not in (403, 404):
            raise
        return {'index': index, 'package': package, 'version': version + '+cu121', 'wheel': url, 'advertisedWheel': advertised_url, 'headStatus': status, 'metadataUnavailable': error.code}
    msg = email.message_from_bytes(metadata)
    assert msg['Name'].lower().replace('-', '_') == package
    assert msg['Version'].split('+')[0] == version
    return {'index': index, 'package': package, 'version': msg['Version'], 'wheel': url, 'advertisedWheel': advertised_url, 'cdnAliasUsed': url != advertised_url, 'headStatus': status, 'metadataSha256': hashlib.sha256(metadata).hexdigest(), 'requiresDist': msg.get_all('Requires-Dist', [])}

if __name__ == '__main__':
    matrix = [('cu130', 'torch', '2.14.1'), ('cu130', 'torchvision', '0.29.1'), ('cu130', 'torchaudio', '2.11.0'), ('cu121', 'torch', '2.4.1'), ('cu121', 'torchvision', '0.19.1'), ('cu121', 'torchaudio', '2.4.1'), ('cpu', 'torch', '2.8.0'), ('cpu', 'torchvision', '0.23.0'), ('cpu', 'torchaudio', '2.8.0')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(check, matrix))
    report = pathlib.Path(os.environ['TMPDIR']) / 'deas-wheel-metadata.json'
    report.write_text(json.dumps(results, indent=2))
    for result in results:
        print(result['index'], result['package'], result['version'], 'HEAD', result['headStatus'])
    print('Metadata report:', report)
