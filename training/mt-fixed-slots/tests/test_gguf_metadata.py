import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("metadata_tool", ROOT / "tools/mt-gguf-metadata.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def string(value):
    raw = value.encode()
    return struct.pack("<Q", len(raw)) + raw


def fake_gguf(path):
    entries = [("tokenizer.ggml.bos_token_id", 4, struct.pack("<I", 1)),
               ("tokenizer.ggml.eos_token_id", 4, struct.pack("<I", 0)),
               ("tokenizer.ggml.padding_token_id", 4, struct.pack("<I", 3)),
               ("tokenizer.chat_template", 8, string("test-template")),
               ("tokenizer.ggml.tokens", 9, struct.pack("<IQ", 8, 4) + b"".join(string(s) for s in ["$", "<bos>", "<eos>", "<pad>"]))]
    path.write_bytes(b"GGUF" + struct.pack("<IQQ", 3, 0, len(entries)) + b"".join(string(k) + struct.pack("<I", t) + data for k, t, data in entries) + b"tensor-payload-must-not-change")


class MetadataExportRegression(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.model = self.root / "bad.gguf"
        fake_gguf(self.model)
        (self.root / "config.json").write_text(json.dumps({"bos_token_id": 1, "eos_token_id": 2, "pad_token_id": 3}))
        (self.root / "tokenizer_config.json").write_text(json.dumps({"bos_token": "<bos>", "eos_token": "<eos>", "pad_token": "<pad>", "chat_template": "test-template"}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_detects_dollar_as_incorrect_eos(self):
        checked, _ = tool.verify(self.model, self.root)
        self.assertFalse(checked["passed"])
        self.assertEqual(checked["checks"]["eos"]["actual_text"], "$")

    def test_repairs_only_output_metadata_and_keeps_input_and_payload(self):
        original = self.model.read_bytes()
        output = self.root / "fixed.gguf"
        result = tool.repair_eos(self.model, self.root, output)
        self.assertTrue(result["after"]["passed"])
        self.assertEqual(self.model.read_bytes(), original)
        after = output.read_bytes()
        self.assertEqual(len(after), len(original))
        self.assertTrue(after.endswith(b"tensor-payload-must-not-change"))
        self.assertEqual(sum(a != b for a, b in zip(original, after)), 1)

    def test_refuses_in_place_or_existing_outputs(self):
        with self.assertRaises(ValueError):
            tool.repair_eos(self.model, self.root, self.model)

    def test_refuses_unrelated_tokenizer_mismatch(self):
        (self.root / "chat_template.jinja").write_text("different-template")
        with self.assertRaises(ValueError):
            tool.repair_eos(self.model, self.root, self.root / "fixed.gguf")


if __name__ == "__main__":
    unittest.main()
