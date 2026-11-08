import importlib.util
import io
from pathlib import Path
import stat
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('repack_ffmpeg', ROOT / 'scripts/repack-ffmpeg.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RepackTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_both_formats_preserve_the_complete_executable_and_only_include_selected_documents(self):
        binary = self.root / 'binary'
        payload = b'unchanged executable\0' * 500
        binary.write_bytes(payload)
        for fmt in ['zip', 'tar.xz']:
            with self.subTest(format=fmt):
                archive, checked = self.root / ('archive.' + fmt), self.root / 'checked'
                module.pack(binary, {'COPYING.GPLv3': b'license'}, archive, fmt, 'ffmpeg')
                module.extract(archive, fmt, 'ffmpeg', checked)
                self.assertEqual(checked.read_bytes(), payload)
                if fmt == 'zip':
                    with zipfile.ZipFile(archive) as source:
                        self.assertEqual(set(source.namelist()), {'ffmpeg', 'COPYING.GPLv3'})
                else:
                    with tarfile.open(archive, 'r:xz') as source:
                        self.assertEqual(set(source.getnames()), {'ffmpeg', 'COPYING.GPLv3'})

    def test_tar_links_cannot_become_executables(self):
        archive = self.root / 'link.tar.xz'
        with tarfile.open(archive, 'w:xz') as target:
            item = tarfile.TarInfo('ffmpeg')
            item.type, item.linkname = tarfile.SYMTYPE, '../external'
            target.addfile(item)
        with self.assertRaisesRegex(module.CheckError, 'ENTRY_LINK'):
            module.extract(archive, 'tar.xz', 'ffmpeg', self.root / 'output')

    def test_zip_links_and_duplicate_entries_are_rejected(self):
        archive = self.root / 'link.zip'
        with zipfile.ZipFile(archive, 'w') as target:
            item = zipfile.ZipInfo('ffmpeg')
            item.create_system, item.external_attr = 3, (stat.S_IFLNK | 0o777) << 16
            target.writestr(item, '../external')
        with self.assertRaisesRegex(module.CheckError, 'ENTRY_LINK'):
            module.extract(archive, 'zip', 'ffmpeg', self.root / 'output')
        with zipfile.ZipFile(archive, 'a') as target:
            target.writestr('ffmpeg', b'duplicate')
        with self.assertRaisesRegex(module.CheckError, 'ENTRY'):
            module.extract(archive, 'zip', 'ffmpeg', self.root / 'output')

    def test_a_wrong_upstream_hash_is_rejected_before_extraction(self):
        class Opener:
            calls = 0
            def open(self, *_args, **_kwargs):
                self.calls += 1
                return io.BytesIO(b'not the pinned archive')
        opener = Opener()
        with patch.object(module.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaisesRegex(module.CheckError, 'ARCHIVE_HASH'):
                module.download('https://example.invalid/archive', self.root / 'download', 22, '0' * 64)
        self.assertEqual(opener.calls, 1)

    def test_architecture_checks_cover_both_operating_systems_and_cpus(self):
        for platform, machine in [('linux-x64', 62), ('linux-arm64', 183), ('win32-x64', 0x8664), ('win32-arm64', 0xAA64)]:
            with self.subTest(platform=platform):
                header = bytearray(256)
                if platform.startswith('linux'):
                    header[:6] = b'\x7fELF\x02\x01'
                    struct.pack_into('<H', header, 18, machine)
                else:
                    header[:2] = b'MZ'
                    struct.pack_into('<I', header, 60, 64)
                    header[64:68] = b'PE\0\0'
                    struct.pack_into('<H', header, 68, machine)
                binary = self.root / platform
                binary.write_bytes(header)
                module.architecture(binary, platform)
                other = platform.replace('arm64', 'x64') if platform.endswith('arm64') else platform.replace('x64', 'arm64')
                with self.assertRaisesRegex(module.CheckError, 'CPU'):
                    module.architecture(binary, other)


if __name__ == '__main__':
    unittest.main()
