"""Repackage pinned upstream executables unchanged; never execute a foreign CPU build."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform as host_platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / 'third_party/ffmpeg/upstream-artifacts.json').read_text())
REPOSITORY = 'mreasonyang/codex-hongguo'
BASE = f'https://github.com/{REPOSITORY}/releases/download/{CONFIG["componentTag"]}/'
MAX_BINARY = 256 * 1024 * 1024


class CheckError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise CheckError(code)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def save(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')


def command(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=kwargs.pop('timeout', 60), **kwargs)
    require(result.returncode == 0, 'SUBPROCESS')
    return result.stdout


class HTTPSOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        require(newurl.startswith('https://'), 'REDIRECT')
        return super().redirect_request(request, fp, code, message, headers, newurl)


def download(url, path, expected_bytes=None, expected_sha=None):
    require(url.startswith('https://'), 'DOWNLOAD_URL')
    opener = urllib.request.build_opener(HTTPSOnly())
    for attempt in range(3):
        try:
            count = 0
            with opener.open(url, timeout=60) as response, Path(path).open('wb') as output:
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    count += len(block)
                    require(count <= (expected_bytes or MAX_BINARY), 'ARCHIVE_SIZE')
                    output.write(block)
            require(expected_bytes is None or count == expected_bytes, 'ARCHIVE_SIZE')
            require(expected_sha is None or sha(path) == expected_sha, 'ARCHIVE_HASH')
            return
        except CheckError:
            raise
        except (OSError, urllib.error.URLError):
            Path(path).unlink(missing_ok=True)
            if attempt == 2:
                raise CheckError('DOWNLOAD') from None
            time.sleep(attempt + 1)


def copy_binary(stream, target, size):
    require(0 < size <= MAX_BINARY, 'BINARY_SIZE')
    count = 0
    with Path(target).open('wb') as output:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            count += len(block)
            require(count <= size, 'BINARY_SIZE')
            output.write(block)
    require(count == size, 'BINARY_SIZE')


def extract(archive, fmt, entry, target):
    """Apply no archive paths or links to disk; retain upstream license notices."""
    notices = {}

    def notice(name, size, stream):
        if re.match(r'^(license|copying|copyright|authors|notice)(\.|$)', Path(name).name, re.I):
            require(size <= 2 * 1024 * 1024, 'NOTICE_SIZE')
            body = stream.read()
            key = 'upstream-' + hashlib.sha256(name.encode()).hexdigest()[:8] + '-' + Path(name).name
            notices[key] = body

    if fmt == 'zip':
        with zipfile.ZipFile(archive) as source:
            matches = [item for item in source.infolist() if item.filename == entry]
            require(len(matches) == 1 and not matches[0].is_dir(), 'ENTRY')
            require(not stat.S_ISLNK(matches[0].external_attr >> 16), 'ENTRY_LINK')
            with source.open(matches[0]) as stream:
                copy_binary(stream, target, matches[0].file_size)
            for item in source.infolist():
                if not item.is_dir() and re.match(r'^(license|copying|copyright|authors|notice)(\.|$)', Path(item.filename).name, re.I):
                    with source.open(item) as stream:
                        notice(item.filename, item.file_size, stream)
    else:
        found = 0
        with tarfile.open(archive, 'r|xz') as source:
            for item in source:
                if item.name == entry:
                    require(item.isreg(), 'ENTRY_LINK')
                    found += 1
                    require(found == 1, 'ENTRY_DUPLICATE')
                    copy_binary(source.extractfile(item), target, item.size)
                elif item.isreg() and re.match(r'^(license|copying|copyright|authors|notice)(\.|$)', Path(item.name).name, re.I):
                    notice(item.name, item.size, source.extractfile(item))
        require(found == 1, 'ENTRY')
    return notices


def architecture(path, platform):
    with Path(path).open('rb') as stream:
        header = stream.read(4096)
    if platform.startswith('linux-'):
        require(header[:6] == b'\x7fELF\x02\x01', 'ELF')
        require(struct.unpack_from('<H', header, 18)[0] == (62 if platform.endswith('x64') else 183), 'CPU')
    else:
        require(header[:2] == b'MZ', 'PE')
        offset = struct.unpack_from('<I', header, 60)[0]
        require(offset + 6 <= len(header) and header[offset:offset + 4] == b'PE\0\0', 'PE')
        require(struct.unpack_from('<H', header, offset + 4)[0] == (0x8664 if platform.endswith('x64') else 0xAA64), 'CPU')


def pack(binary, documents, output, fmt, entry):
    if fmt == 'zip':
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, body in [(entry, binary.read_bytes()), *sorted(documents.items())]:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o100755 if name == entry else 0o100644) << 16
                archive.writestr(info, body, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    else:
        with tarfile.open(output, 'w:xz', preset=6, format=tarfile.USTAR_FORMAT) as archive:
            info = tarfile.TarInfo(entry)
            info.size = binary.stat().st_size
            info.mode = 0o755
            with binary.open('rb') as stream:
                archive.addfile(info, stream)
            for name, body in sorted(documents.items()):
                info = tarfile.TarInfo(name)
                info.size = len(body)
                info.mode = 0o644
                archive.addfile(info, io.BytesIO(body))


def sources_text():
    return f'''# FFmpeg component source and notices

This archive contains an unchanged upstream FFmpeg executable. The repackaging
code is MIT licensed; FFmpeg and its included GPL components retain GPLv3 and
their respective licenses. See COPYING.GPLv3 and upstream notices in this archive.

Complete source access and exact build/dependency recipes:
- FFmpeg commit: https://github.com/FFmpeg/FFmpeg/tree/{CONFIG['ffmpegCommit']}
- FFmpeg source snapshot: {BASE}ffmpeg-source.tar.gz
- Upstream build recipes, dependency source URLs/revisions and patches:
  {BASE}upstream-build-recipes.tar.gz
- Dependency source index: {BASE}sources-index.json
- Original build repository: https://github.com/{CONFIG['buildRepository']}/tree/{CONFIG['buildCommit']}
- Repackaging code: https://github.com/{REPOSITORY}/tree/{CONFIG['componentTag']}/scripts/repack-ffmpeg.py

The build-recipe snapshot contains every dependency recipe and its pinned source
repository, revision/version and patches. sources-index.json indexes these files
and source references. The original binary archive and its SHA-256 are recorded
in provenance.json. No executable was recompiled or modified.

Source snapshots and references are offered without charge alongside the binary
assets. If a source reference becomes unavailable, report it at
https://github.com/{REPOSITORY}/issues so maintainers can restore source access.
'''.encode()


def build(platform, output):
    original = CONFIG['platforms'][platform]
    output.mkdir(parents=True, exist_ok=True)
    fmt = original['format']
    entry = 'ffmpeg.exe' if platform.startswith('win32-') else 'ffmpeg'
    filename = f'ffmpeg-{CONFIG["version"]}-{platform}.' + ('zip' if fmt == 'zip' else 'tar.xz')
    with tempfile.TemporaryDirectory(prefix='ffmpeg-repack-') as temp:
        temp = Path(temp)
        archive, binary = temp / 'upstream', temp / entry
        download(original['url'], archive, original['archiveBytes'], original['archiveSha256'])
        notices = extract(archive, fmt, original['entry'], binary)
        architecture(binary, platform)
        binary_sha = sha(binary)
        require(not original.get('binarySha256') or binary_sha == original['binarySha256'], 'BINARY_HASH')
        provenance = dict(platform=platform, upstream=original, binarySha256=binary_sha,
                          binaryBytes=binary.stat().st_size, buildCommit=CONFIG['buildCommit'],
                          ffmpegCommit=CONFIG['ffmpegCommit'], binaryUnchanged=True)
        documents = {**notices, 'COPYING.GPLv3': (ROOT / 'third_party/ffmpeg/COPYING.GPLv3').read_bytes(),
                     'SOURCE.md': sources_text(), 'provenance.json': (json.dumps(provenance, indent=2) + '\n').encode()}
        target = output / filename
        pack(binary, documents, target, fmt, entry)
        checked = temp / 'checked'
        extract(target, fmt, entry, checked)
        require(sha(checked) == binary_sha, 'ROUNDTRIP')
        artifact = dict(version=CONFIG['version'], url=BASE + filename, format=fmt, entry=entry,
                        archiveBytes=target.stat().st_size, archiveSha256=sha(target),
                        binaryBytes=binary.stat().st_size, binarySha256=binary_sha,
                        cacheKey=original['archiveSha256'][:16])
        save(output / (platform + '.json'), dict(platform=platform, artifact=artifact,
             upstream=original, componentTag=CONFIG['componentTag'], binaryUnchanged=True))
        print(json.dumps(dict(platform=platform, beforeBytes=original['archiveBytes'], afterBytes=artifact['archiveBytes'], binaryUnchanged=True)))


def native(platform, output):
    expected = ('win32' if sys.platform == 'win32' else 'linux') + '-' + ('arm64' if host_platform.machine().lower() in ['arm64', 'aarch64'] else 'x64')
    require(platform == expected, 'NATIVE_CPU')
    receipt = json.loads((output / (platform + '.json')).read_text())
    artifact = receipt['artifact']
    archive = output / artifact['url'].split('/')[-1]
    require(sha(archive) == artifact['archiveSha256'], 'ARCHIVE_HASH')
    with tempfile.TemporaryDirectory(prefix='ffmpeg-native-') as temp:
        temp = Path(temp)
        binary = temp / artifact['entry']
        extract(archive, artifact['format'], artifact['entry'], binary)
        require(sha(binary) == artifact['binarySha256'], 'BINARY_HASH')
        binary.chmod(0o755)
        run = lambda *args: command([str(binary), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', *map(str, args)], timeout=90)
        command([str(binary), '-version'])
        avc, hevc, converted, cover = [temp / name for name in ['avc.mp4', 'hevc.mp4', 'converted.mp4', 'cover.jpg']]
        run('-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '0.6', '-c:v', 'libx264', '-c:a', 'aac', avc)
        run('-i', avc, '-f', 'null', '-')
        run('-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=5', '-t', '0.6', '-c:v', 'libx265', '-x265-params', 'pools=1:frame-threads=1', hevc)
        run('-i', hevc, '-c:v', 'libx264', converted)
        run('-i', converted, '-f', 'null', '-')
        run('-i', avc, '-vf', 'scale=240:320', '-frames:v', '1', '-c:v', 'mjpeg', cover)
        require(cover.stat().st_size > 0, 'COVER')
        header = run('-i', avc, '-c', 'copy', '-frames:v', '0', '-frames:a', '0', '-f', 'framehash', 'pipe:1')
        require(b'h264' in header and b'aac' in header, 'FRAMEHASH')
    save(output / (platform + '-native.json'), dict(platform=platform, binarySha256=artifact['binarySha256'],
         checks=['h264-aac', 'hevc-to-h264', 'jpeg-cover', 'framehash'], passed=True))
    print(json.dumps(dict(platform=platform, nativeChecksPassed=True)))


def collect(output):
    artifacts, receipts = {}, {}
    for platform in CONFIG['platforms']:
        receipt = json.loads((output / (platform + '.json')).read_text())
        require(receipt['componentTag'] == CONFIG['componentTag'] and receipt['upstream'] == CONFIG['platforms'][platform] and receipt['binaryUnchanged'], 'RECEIPT')
        artifact = receipt['artifact']
        require(sha(output / artifact['url'].split('/')[-1]) == artifact['archiveSha256'], 'ARCHIVE_HASH')
        require(artifact['cacheKey'] == receipt['upstream']['archiveSha256'][:16], 'CACHE_KEY')
        artifacts[platform], receipts[platform] = artifact, receipt
    for platform in ['linux-x64', 'win32-x64']:
        proof = json.loads((output / (platform + '-native.json')).read_text())
        require(proof['passed'] and proof['binarySha256'] == artifacts[platform]['binarySha256'], 'NATIVE_RECEIPT')
    download(f'https://codeload.github.com/{CONFIG["buildRepository"]}/tar.gz/{CONFIG["buildCommit"]}', output / 'upstream-build-recipes.tar.gz')
    download(f'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/{CONFIG["ffmpegCommit"]}', output / 'ffmpeg-source.tar.gz')
    index = []
    with tarfile.open(output / 'upstream-build-recipes.tar.gz', 'r:gz') as source:
        for entry in source:
            if entry.isfile() and entry.name.endswith('.sh') and '/scripts.d/' in entry.name:
                text = source.extractfile(entry).read().decode()
                values = re.findall(r'^(SCRIPT_[A-Z_]+)=(.*)$', text, re.M)
                index.append(dict(recipe=entry.name.split('/', 1)[1], sourceVariables=dict(values)))
    save(output / 'sources-index.json', dict(buildCommit=CONFIG['buildCommit'], ffmpegCommit=CONFIG['ffmpegCommit'], recipes=index))
    save(output / 'components.json', artifacts)
    save(output / 'qualification.json', dict(componentTag=CONFIG['componentTag'], platforms=receipts,
         nativePlatforms=['linux-x64', 'win32-x64'], arm64Validation='upstream archive hash, architecture and exact binary identity'))
    (output / 'SOURCE.md').write_bytes(sources_text())
    (output / 'COPYING.GPLv3').write_bytes((ROOT / 'third_party/ffmpeg/COPYING.GPLv3').read_bytes())
    (output / 'RELEASE.md').write_text('# Compact FFmpeg components\n\nUnchanged FFmpeg 9.0.2 executables from the pinned 2026-10-31 upstream build.\n\n' + sources_text().decode() + '\n\nNative Windows x64 and Linux x64 smoke tests passed: H.264/AAC, HEVC to H.264, JPEG covers and codec headers. ARM64 executable identity and architecture are verified; native ARM64 playback was not exercised here.\n')
    print(json.dumps(dict(collected=True, platforms=len(artifacts))))


def publish(output):
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI_ONLY')
    require(os.environ.get('COMPONENT_TAG') == CONFIG['componentTag'], 'TAG')
    tag = CONFIG['componentTag']
    require(command(['git', 'rev-parse', 'HEAD']).strip() == command(['git', 'rev-parse', f'refs/tags/{tag}^{{commit}}']).strip(), 'SOURCE')
    result = subprocess.run(['gh', 'release', 'view', tag, '--repo', REPOSITORY, '--json', 'isDraft'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 0 and not json.loads(result.stdout)['isDraft']:
        with tempfile.TemporaryDirectory() as temp:
            command(['gh', 'release', 'download', tag, '--repo', REPOSITORY, '--pattern', 'components.json', '--dir', temp])
            require(json.loads((Path(temp) / 'components.json').read_text()) == json.loads((output / 'components.json').read_text()), 'IMMUTABLE_RELEASE')
        return
    if result.returncode != 0:
        command(['gh', 'release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--draft', '--prerelease', '--latest=false', '--title', tag, '--notes-file', str(output / 'RELEASE.md')])
    files = [p for p in output.iterdir() if p.is_file() and p.name != 'RELEASE.md']
    command(['gh', 'release', 'upload', tag, '--repo', REPOSITORY, '--clobber', *map(str, files)], timeout=300)
    command(['gh', 'release', 'edit', tag, '--repo', REPOSITORY, '--draft=false', '--prerelease', '--latest=false'])
    print(json.dumps(dict(published=True, tag=tag)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['build', 'native', 'collect', 'publish'])
    parser.add_argument('--platform', choices=list(CONFIG['platforms']))
    parser.add_argument('--output', type=Path, default=ROOT / 'release/ffmpeg-components')
    args = parser.parse_args()
    try:
        if args.mode in ['build', 'native']:
            require(args.platform is not None, 'PLATFORM')
            (build if args.mode == 'build' else native)(args.platform, args.output)
        else:
            (collect if args.mode == 'collect' else publish)(args.output)
    except Exception as error:
        code = str(error) if isinstance(error, CheckError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'CHECKS'
        print(f'Component checks failed [{code}]', file=sys.stderr)
        sys.exit(1)
