import unittest

from litellm_session_identity import (
    Resolution,
    derive_session_identity,
    resolve_session_identity,
)


class SessionIdentityTest(unittest.TestCase):
    def test_header_takes_precedence_over_body_key(self):
        body_id = derive_session_identity("raw-key", "fabro/1")
        self.assertIsNotNone(body_id)
        resolution = resolve_session_identity(
            [{"session_id": "ses_abc12345"}], "raw-key", "fabro/1"
        )
        self.assertEqual(resolution, Resolution("ses_abc12345", "header"))
        self.assertEqual(resolution.source, "header")
        self.assertEqual(resolution.session_id, "ses_abc12345")
        self.assertNotEqual(resolution.session_id, body_id)

    def test_same_raw_key_is_namespaced_per_producer(self):
        fabro_id = derive_session_identity("shared-key", "fabro/1")
        other_id = derive_session_identity("shared-key", "other/1")
        self.assertIsNotNone(fabro_id)
        self.assertIsNotNone(other_id)
        self.assertTrue(fabro_id.startswith("bridge:v1:"))
        self.assertTrue(other_id.startswith("bridge:v1:"))
        fabro_parts = fabro_id.split(":")
        other_parts = other_id.split(":")
        self.assertEqual(len(fabro_parts), 4)
        self.assertEqual(len(other_parts), 4)
        self.assertEqual(fabro_parts[2], "fabro")
        self.assertEqual(other_parts[2], "other")
        self.assertNotEqual(fabro_parts[2], other_parts[2])
        self.assertEqual(fabro_parts[3], other_parts[3])
        self.assertNotEqual(fabro_id, other_id)
        for user_agent, expected in (("fabro/1", fabro_id), ("other/1", other_id)):
            with self.subTest(user_agent=user_agent):
                resolution = resolve_session_identity(
                    [], "shared-key", user_agent
                )
                self.assertEqual(resolution, Resolution(expected, "body"))

    def test_absent_key_yields_none(self):
        self.assertIsNone(resolve_session_identity([], None, "fabro/1"))
        self.assertIsNone(derive_session_identity(None, "fabro/1"))
        self.assertIsNone(
            resolve_session_identity([{"session_id": ""}], "", "fabro/1")
        )
        self.assertIsNone(resolve_session_identity([{}], None, "fabro/1"))

    def test_malformed_keys_yield_none(self):
        for key in (
            123,
            b"bytes",
            [],
            {},
            "",
            "   ",
            "x" * 513,
            "a\rb",
            "a\nb",
            "a\x00b",
        ):
            with self.subTest(key=key):
                self.assertIsNone(derive_session_identity(key, "fabro/1"))
        self.assertIsNotNone(derive_session_identity("x" * 512, "fabro/1"))

    def test_body_identity_never_matches_header_identity(self):
        body_id = derive_session_identity("raw-key", "fabro/1")
        self.assertIsNotNone(body_id)
        self.assertTrue(body_id.startswith("bridge:v1:"))
        self.assertFalse(body_id.startswith("ses_"))
        header_id = "ses_" + "a" * 64
        resolution = resolve_session_identity(
            [{"session_id": header_id}], "raw-key", "fabro/1"
        )
        self.assertIsNotNone(resolution)
        self.assertEqual(resolution.source, "header")
        self.assertEqual(resolution.session_id, header_id)
        self.assertEqual(resolution, Resolution(header_id, "header"))
        self.assertNotEqual(body_id, resolution.session_id)


if __name__ == "__main__":
    unittest.main()
