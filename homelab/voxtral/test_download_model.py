import tempfile
import unittest
from pathlib import Path

from download_model import byte_ranges, merge_parts, remaining_range


class ParallelDownloadTests(unittest.TestCase):
    def test_partial_segment_resumes_after_the_existing_bytes(self):
        self.assertEqual(remaining_range(100, 199, 0), (100, 199))
        self.assertEqual(remaining_range(100, 199, 35), (135, 199))
        self.assertIsNone(remaining_range(100, 199, 100))
        with self.assertRaises(ValueError):
            remaining_range(100, 199, 101)

    def test_ranges_cover_the_file_exactly_once(self):
        self.assertEqual(byte_ranges(10, 3), [(0, 3), (4, 7), (8, 9)])
        ranges = byte_ranges(3_133_798_126, 12)
        self.assertEqual(ranges[0][0], 0)
        self.assertEqual(ranges[-1][1], 3_133_798_125)
        self.assertTrue(all(left[1] + 1 == right[0] for left, right in zip(ranges, ranges[1:])))

    def test_merge_rejects_wrong_part_sizes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parts = [root / "0.part", root / "1.part"]
            parts[0].write_bytes(b"abcd")
            parts[1].write_bytes(b"ef")
            with self.assertRaises(ValueError):
                merge_parts(parts, [4, 4], root / "model.bin", "")

    def test_merge_checks_the_expected_sha256(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parts = [root / "0.part", root / "1.part"]
            parts[0].write_bytes(b"abc")
            parts[1].write_bytes(b"def")
            destination = root / "model.bin"
            merge_parts(
                parts,
                [3, 3],
                destination,
                "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
            )
            self.assertEqual(destination.read_bytes(), b"abcdef")


if __name__ == "__main__":
    unittest.main()
