import json
import re
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
EXPECTED_VERSION = "1.10.0"


def _required_match(pattern, text, source_name):
    match = re.search(pattern, text, flags=re.MULTILINE)
    assert match is not None, f"missing release version in {source_name}"
    return match.group(1)


def test_release_version_literals_are_aligned_to_1_10_0():
    manifest_path = REPO_ROOT / "media-catcher" / "manifest.json"
    host_path = REPO_ROOT / "media-catcher-host" / "mc_host.py"
    installer_path = (
        REPO_ROOT
        / "media-catcher-host"
        / "installer"
        / "media-catcher-host.iss"
    )

    versions = {
        "extension manifest": json.loads(manifest_path.read_text(encoding="utf-8"))[
            "version"
        ],
        "native host": _required_match(
            r'^VERSION\s*=\s*["\']([^"\']+)["\']',
            host_path.read_text(encoding="utf-8"),
            host_path.name,
        ),
        "installer": _required_match(
            r'^#define\s+AppVersion\s+"([^"]+)"',
            installer_path.read_text(encoding="utf-8"),
            installer_path.name,
        ),
    }

    assert versions == {
        "extension manifest": EXPECTED_VERSION,
        "native host": EXPECTED_VERSION,
        "installer": EXPECTED_VERSION,
    }
