import importlib.util
import io
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('macos_ffmpeg', ROOT / 'scripts/build-macos-ffmpeg.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MacOSBuildTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def archive(self, name, kind=tarfile.REGTYPE):
        target = self.root / 'source.tar.gz'
        with tarfile.open(target, 'w:gz') as archive:
            item = tarfile.TarInfo(name)
            item.type, item.linkname = kind, '/outside'
            item.mode, item.size = 0o755, 6 if kind == tarfile.REGTYPE else 0
            archive.addfile(item, io.BytesIO(b'source') if item.size else None)
        return target

    def test_sources_preserve_scripts_but_reject_path_traversal_and_links(self):
        source = module.unpack_source(self.archive('source/configure'), self.root / 'valid')
        self.assertEqual((source / 'configure').read_bytes(), b'source')
        self.assertTrue((source / 'configure').stat().st_mode & 0o111)
        for index, (name, kind) in enumerate([
            ('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
            ('source/symlink', tarfile.SYMTYPE), ('source/hardlink', tarfile.LNKTYPE),
        ]):
            with self.subTest(name=name), self.assertRaises(module.repack.CheckError):
                module.unpack_source(self.archive(name, kind), self.root / f'bad-{index}')
        self.assertFalse((self.root / 'escape').exists())

    def test_wrong_architecture_or_non_macho_binary_is_rejected(self):
        binary = self.root / 'ffmpeg'
        for platform, cpu in [('darwin-arm64', 0x100000c), ('darwin-x64', 0x1000007)]:
            binary.write_bytes(b'\xcf\xfa\xed\xfe' + struct.pack('<I', cpu) + b'\0' * 24)
            module.architecture(binary, platform)
            other = 'darwin-x64' if platform == 'darwin-arm64' else 'darwin-arm64'
            with self.assertRaisesRegex(module.repack.CheckError, 'CPU'):
                module.architecture(binary, other)
        binary.write_bytes(b'not an executable')
        with self.assertRaisesRegex(module.repack.CheckError, 'MACHO'):
            module.architecture(binary, 'darwin-arm64')

    def test_homebrew_or_relative_runtime_libraries_fail_qualification(self):
        for library in ['/opt/homebrew/lib/libx264.dylib', '/usr/local/lib/libx264.dylib',
                        '@rpath/libx264.dylib', 'libx264.dylib']:
            with self.subTest(library=library), patch.object(module, 'command', return_value=(
                'ffmpeg:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t' +
                library + ' (compatibility version 1.0.0)\n').encode()):
                with self.assertRaisesRegex(module.repack.CheckError, 'EXTERNAL_LIBRARY'):
                    module.system_libraries(Path('ffmpeg'))
        with patch.object(module, 'command', return_value=(
            'ffmpeg:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n'
            '\t/System/Library/Frameworks/VideoToolbox.framework/Versions/A/VideoToolbox (compatibility version 1.0.0)\n').encode()):
            self.assertEqual(len(module.system_libraries(Path('ffmpeg'))), 2)


if __name__ == '__main__':
    unittest.main()
