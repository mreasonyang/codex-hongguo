"""Build the macOS CLI from pinned sources; publish only after native checks."""
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform as host
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('repack', ROOT / 'scripts/repack-ffmpeg.py')
repack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repack)
CONFIG_PATH = ROOT / 'third_party/ffmpeg/macos-build.json'
CONFIG = json.loads(CONFIG_PATH.read_text())
require, sha, save, command = repack.require, repack.sha, repack.save, repack.command
PLATFORMS = ['darwin-arm64', 'darwin-x64']
BASE = f'https://github.com/{repack.REPOSITORY}/releases/download/{CONFIG["componentTag"]}/'
CHECKS = ['h264-aac-decode', 'hevc-decode', 'hevc-to-h264', 'jpeg-cover',
          'framehash', 'hls-fmp4', 'cenc-remux', 'system-libraries-only', 'signature-integrity']


def unpack_source(archive, destination):
    """Copy regular source files only; archive links and path escapes are rejected."""
    destination.mkdir(parents=True)
    roots = set()
    with tarfile.open(archive, 'r:*') as source:
        for item in source:
            path = PurePosixPath(item.name)
            require(not path.is_absolute() and '..' not in path.parts and path.parts, 'SOURCE_PATH')
            require(item.isdir() or item.isfile(), 'SOURCE_TYPE')
            roots.add(path.parts[0])
            target = destination.joinpath(*path.parts)
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                require(item.size <= 32 * 1024 * 1024, 'SOURCE_SIZE')
                target.parent.mkdir(parents=True, exist_ok=True)
                require(not target.exists(), 'SOURCE_DUPLICATE')
                with source.extractfile(item) as stream, target.open('wb') as output:
                    shutil.copyfileobj(stream, output)
                target.chmod(0o755 if item.mode & 0o111 else 0o644)
    require(len(roots) == 1, 'SOURCE_ROOT')
    return destination / roots.pop()


def source_inputs(output):
    output.mkdir(parents=True, exist_ok=True)
    result = {}
    for name, source in CONFIG['sources'].items():
        target = output / source['filename']
        repack.download(source['url'], target, source['bytes'], source['sha256'])
        result[name] = target
    return result


def build_step(args, directory, env, stage, timeout):
    # Build children receive only the explicitly constructed, credential-free env.
    # Emit a small set of compiler diagnostics, never complete raw build logs.
    result = subprocess.run(args, cwd=directory, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        lines = result.stdout.decode(errors='replace').splitlines()
        diagnostics = [line for line in lines if re.search(r'error:|^ERROR:|not found|failed|requires', line, re.I)]
        for line in diagnostics[-6:]:
            print(line.replace(str(directory.parent), '$BUILD')[:400], file=sys.stderr)
        require(False, stage)


def architecture(binary, platform):
    import struct
    header = binary.read_bytes()[:32]
    require(header[:4] == b'\xcf\xfa\xed\xfe', 'MACHO')
    cpu = struct.unpack_from('<I', header, 4)[0]
    require(cpu == (0x100000c if platform == 'darwin-arm64' else 0x1000007), 'CPU')


def system_libraries(binary):
    output = command(['/usr/bin/otool', '-L', str(binary)]).decode()
    libraries = [line.strip().split(' (', 1)[0] for line in output.splitlines()[1:]]
    require(libraries and all(path.startswith(('/usr/lib/', '/System/Library/'))
                              for path in libraries), 'EXTERNAL_LIBRARY')
    return libraries


def source_text():
    return f'''# macOS FFmpeg component source

FFmpeg {CONFIG['version']} and statically linked x264 are built from the exact
source archives accompanying this release. GPL-3.0-or-later applies to this
configured FFmpeg executable; x264 is GPL-2.0-or-later. See the bundled licenses.
No nonfree components are enabled. The executable only links macOS system
libraries/frameworks. An ad-hoc signature provides integrity, not publisher identity.

Source archives and their pinned hashes: {BASE}macos-build.json
Build scripts and configuration: {BASE}macos-build-recipes.tar.gz
Exact source commit, toolchain, configuration, archive and binary hashes, and
native qualification: {BASE}qualification.json

Rebuild on the matching native macOS architecture with Xcode command-line tools,
Python 3.12+, pkgconf and (for Intel) nasm, using:
  python3 scripts/build-macos-ffmpeg.py build --platform darwin-arm64
or --platform darwin-x64. Only build tools may come from Homebrew; runtime codec
libraries are built from the pinned sources, not taken from Homebrew.
Sources, recipes and licenses are available without charge at this release.
'''.encode()


def native_checks(binary, platform, output):
    architecture(binary, platform)
    libraries = system_libraries(binary)
    command(['/usr/bin/codesign', '--verify', '--strict', str(binary)])

    def run(*args):
        return command([str(binary), '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-y', *map(str, args)], timeout=120)

    version = run('-version').decode()
    require(version.startswith('ffmpeg version ' + CONFIG['version']), 'VERSION')
    require('--enable-nonfree' not in version and '--enable-libx264' in version and
            '--enable-videotoolbox' in version and '--disable-network' in version, 'CONFIGURATION')
    with tempfile.TemporaryDirectory() as directory:
        temp = Path(directory)
        avc, hevc = [ROOT / 'test/fixtures' / name for name in ['avc-aac.mp4', 'hevc-aac.mp4']]
        for fixture in [avc, hevc]:
            run('-xerror', '-i', fixture, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-')
        converted, cover = temp / 'converted.mp4', temp / 'cover.jpg'
        run('-i', hevc, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', converted)
        run('-xerror', '-i', converted, '-f', 'null', '-')
        run('-i', avc, '-vf', 'scale=240:320', '-frames:v', '1', '-c:v', 'mjpeg', cover)
        require(cover.stat().st_size > 0, 'COVER')
        header = run('-i', avc, '-c', 'copy', '-frames:v', '0', '-frames:a', '0', '-f', 'framehash', 'pipe:1')
        require(b'h264' in header and b'aac' in header, 'FRAMEHASH')
        playlist = temp / 'index.m3u8'
        run('-i', avc, '-c', 'copy', '-f', 'hls', '-hls_segment_type', 'fmp4',
            '-hls_segment_filename', temp / 'seg%03d.m4s', playlist)
        run('-protocol_whitelist', 'file,crypto,data', '-i', playlist, '-f', 'null', '-')
        # Public deterministic test vector; this key belongs only to the fixture.
        run('-decryption_key', bytes(range(16)).hex(), '-i', ROOT / 'test/fixtures/encrypted.mp4',
            '-c', 'copy', temp / 'decrypted.mp4')
        run('-xerror', '-i', temp / 'decrypted.mp4', '-f', 'null', '-')
    proof = dict(platform=platform, passed=True, binarySha256=sha(binary), checks=CHECKS,
                 libraries=libraries, signature='ad-hoc; integrity only',
                 hardwareEncoder='h264_videotoolbox compiled; runtime fallback tested in plugin suite')
    save(output / (platform + '-native.json'), proof)
    return proof


def build(platform, output):
    require(host.system() == 'Darwin' and host.machine() ==
            ('arm64' if platform == 'darwin-arm64' else 'x86_64'), 'NATIVE_HOST')
    sources = source_inputs(output)
    source_commit = command(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
    with tempfile.TemporaryDirectory(prefix='hongguo-ffmpeg-build-') as directory:
        work = Path(directory)
        prefix = work / 'prefix'
        (work / 'tmp').mkdir()
        paths = {name: unpack_source(path, work / name) for name, path in sources.items()}
        compiler = command(['xcrun', '--find', 'clang']).decode().strip()
        sdk = command(['xcrun', '--show-sdk-path']).decode().strip()
        env = dict(PATH=os.environ['PATH'], HOME=str(work), TMPDIR=str(work / 'tmp'),
                   LC_ALL='C', MACOSX_DEPLOYMENT_TARGET=CONFIG['minimumMacOS'],
                   ZERO_AR_DATE='1', SDKROOT=sdk, CC=compiler,
                   PKG_CONFIG_PATH='', PKG_CONFIG_LIBDIR=str(prefix / 'lib/pkgconfig'))
        target = 'arm64' if platform == 'darwin-arm64' else 'x86_64'
        cflags = f'-arch {target} -mmacosx-version-min={CONFIG["minimumMacOS"]}'
        x264_args = [f'--prefix={prefix}', '--enable-static', '--enable-pic', '--disable-cli',
                     '--disable-opencl', '--disable-lsmash', '--disable-swscale', '--disable-ffms',
                     f'--extra-cflags={cflags}', f'--extra-ldflags={cflags}']
        ffmpeg_args = [f'--prefix={prefix}', '--disable-autodetect', '--disable-shared', '--enable-static',
                       '--disable-doc', '--disable-debug', '--disable-ffplay', '--disable-ffprobe',
                       '--disable-network', '--enable-gpl', '--enable-version3', '--enable-libx264',
                       '--enable-videotoolbox', '--enable-audiotoolbox', '--enable-zlib',
                       '--pkg-config-flags=--static', f'--extra-cflags={cflags} -I{prefix}/include',
                       f'--extra-ldflags={cflags} -L{prefix}/lib']
        jobs = str(os.cpu_count() or 2)
        for name, args in [('x264', x264_args), ('ffmpeg', ffmpeg_args)]:
            build_step(['./configure', *args], paths[name], env, name.upper() + '_CONFIGURE', 180)
            build_step(['make', '-j', jobs], paths[name], env, name.upper() + '_COMPILE', 2400)
            build_step(['make', 'install'], paths[name], env, name.upper() + '_INSTALL', 180)
        binary = prefix / 'bin/ffmpeg'
        command(['/usr/bin/strip', '-S', str(binary)])
        command(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', str(binary)])
        proof = native_checks(binary, platform, output)
        normalize = lambda args: [arg.replace(str(prefix), '$PREFIX') for arg in args]
        provenance = dict(platform=platform, componentTag=CONFIG['componentTag'], sourceCommit=source_commit,
                          sources=CONFIG['sources'], minimumMacOS=CONFIG['minimumMacOS'],
                          configure=dict(x264=normalize(x264_args), ffmpeg=normalize(ffmpeg_args)),
                          toolchain=dict(clang=command([compiler, '--version']).decode().splitlines()[0],
                                         sdk=command(['xcrun', '--show-sdk-version']).decode().strip(),
                                         macOS=host.mac_ver()[0]),
                          binarySha256=sha(binary), binaryBytes=binary.stat().st_size, native=proof)
        filename = f'ffmpeg-{CONFIG["version"]}-macos-r1-{platform}.zip'
        documents = {'SOURCE.md': source_text(), 'provenance.json': (json.dumps(provenance, indent=2) + '\n').encode(),
                     'COPYING.GPLv3': (paths['ffmpeg'] / 'COPYING.GPLv3').read_bytes(),
                     'x264-COPYING': (paths['x264'] / 'COPYING').read_bytes()}
        repack.pack(binary, documents, output / filename, 'zip', 'ffmpeg')
        artifact = dict(version=CONFIG['version'] + '-macos-r1', url=BASE + filename, format='zip', entry='ffmpeg',
                        archiveBytes=(output / filename).stat().st_size, archiveSha256=sha(output / filename),
                        binaryBytes=binary.stat().st_size, binarySha256=sha(binary))
        save(output / (platform + '.json'), dict(artifact=artifact, provenance=provenance))
    print(json.dumps(dict(platform=platform, built=True, nativeChecksPassed=True)))


def collect(output):
    artifacts, receipts = {}, {}
    source_commit = command(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
    for name, source in CONFIG['sources'].items():
        path = output / source['filename']
        require(path.stat().st_size == source['bytes'] and sha(path) == source['sha256'], 'SOURCE_HASH')
    for platform in PLATFORMS:
        receipt = json.loads((output / (platform + '.json')).read_text())
        artifact, provenance = receipt['artifact'], receipt['provenance']
        require(provenance['sourceCommit'] == source_commit and provenance['sources'] == CONFIG['sources'] and
                provenance['componentTag'] == CONFIG['componentTag'], 'SOURCE_RECEIPT')
        require(artifact['url'].startswith(BASE) and artifact['binarySha256'] == provenance['binarySha256'], 'ARTIFACT')
        archive = output / artifact['url'].split('/')[-1]
        require(archive.stat().st_size == artifact['archiveBytes'] and sha(archive) == artifact['archiveSha256'], 'ARCHIVE_HASH')
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / 'ffmpeg'
            repack.extract(archive, 'zip', 'ffmpeg', binary)
            require(binary.stat().st_size == artifact['binaryBytes'] and sha(binary) == artifact['binarySha256'], 'BINARY_HASH')
            architecture(binary, platform)
        proof = json.loads((output / (platform + '-native.json')).read_text())
        require(proof == provenance['native'] and proof['passed'] and proof['checks'] == CHECKS and
                proof['binarySha256'] == artifact['binarySha256'], 'NATIVE_RECEIPT')
        artifacts[platform], receipts[platform] = artifact, provenance
    save(output / 'components.json', artifacts)
    save(output / 'qualification.json', dict(sourceCommit=source_commit, componentTag=CONFIG['componentTag'], platforms=receipts))
    shutil.copyfile(CONFIG_PATH, output / 'macos-build.json')
    command(['git', 'archive', '--format=tar.gz', '-o', str(output / 'macos-build-recipes.tar.gz'),
             'HEAD', 'scripts/build-macos-ffmpeg.py', 'scripts/repack-ffmpeg.py', 'third_party/ffmpeg',
             '.github/workflows/ffmpeg-macos.yml', 'test/fixtures'], cwd=ROOT)
    (output / 'SOURCE.md').write_bytes(source_text())
    (output / 'RELEASE.md').write_bytes(b'# macOS FFmpeg from pinned source\n\n' + source_text() +
                                      b'\nBoth architectures passed native decoding, software transcoding, HLS, cover, CENC, linkage and integrity checks.\n')
    print(json.dumps(dict(collected=True, nativePlatforms=PLATFORMS)))


def publish(output):
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'CI_ONLY')
    tag = CONFIG['componentTag']
    require(os.environ.get('COMPONENT_TAG') == tag, 'TAG')
    require(command(['git', 'rev-parse', 'HEAD']).strip() == command(['git', 'rev-parse', f'refs/tags/{tag}^{{commit}}']).strip(), 'SOURCE')
    result = subprocess.run(['gh', 'release', 'view', tag, '--repo', repack.REPOSITORY, '--json', 'isDraft'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 0 and not json.loads(result.stdout)['isDraft']:
        with tempfile.TemporaryDirectory() as directory:
            command(['gh', 'release', 'download', tag, '--repo', repack.REPOSITORY, '--pattern', 'qualification.json', '--dir', directory])
            require(json.loads((Path(directory) / 'qualification.json').read_text()) ==
                    json.loads((output / 'qualification.json').read_text()), 'IMMUTABLE_RELEASE')
        return
    if result.returncode != 0:
        command(['gh', 'release', 'create', tag, '--repo', repack.REPOSITORY, '--verify-tag', '--draft',
                 '--prerelease', '--latest=false', '--title', tag, '--notes-file', str(output / 'RELEASE.md')])
    files = [str(path) for path in output.iterdir() if path.is_file() and path.name != 'RELEASE.md']
    command(['gh', 'release', 'upload', tag, '--repo', repack.REPOSITORY, '--clobber', *files], timeout=300)
    command(['gh', 'release', 'edit', tag, '--repo', repack.REPOSITORY, '--draft=false', '--prerelease', '--latest=false'])
    print(json.dumps(dict(published=True, tag=tag)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['build', 'collect', 'publish'])
    parser.add_argument('--platform', choices=PLATFORMS)
    parser.add_argument('--output', type=Path, default=ROOT / 'release/ffmpeg-macos')
    args = parser.parse_args()
    try:
        if args.mode == 'build':
            require(args.platform in PLATFORMS, 'PLATFORM')
            build(args.platform, args.output.resolve())
        else:
            (collect if args.mode == 'collect' else publish)(args.output.resolve())
    except Exception as error:
        code = str(error) if isinstance(error, repack.CheckError) and re.fullmatch(r'[A-Z_]+', str(error)) else 'CHECKS'
        print(f'macOS component checks failed [{code}]', file=sys.stderr)
        sys.exit(1)
