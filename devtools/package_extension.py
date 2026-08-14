"""Build the extension package from the ship set.

Release packaging previously archived `media-catcher/*` wholesale, which put
the 38-file test suite and the editor config into what users install. This
builds the same artifact the install tooling verifies, from the same ship set,
so the two cannot disagree.

    python devtools/package_extension.py dist/media_catcher-1.10.0.zip

Standard library only. No PowerShell.
"""
import argparse
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import install_dev  # noqa: E402
import ship_set     # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("out", help="path of the archive to write")
    parser.add_argument("--repo-root", default=".",
                        help="repository root (default: cwd)")
    args = parser.parse_args(argv)

    mapping = ship_set.extension_ship_set(args.repo_root)
    data = install_dev.build_zip_from_mapping(mapping)

    parent = os.path.dirname(os.path.abspath(args.out))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(args.out, "wb") as handle:
        handle.write(data)

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.namelist()
    excluded = ", ".join(ship_set.EXTENSION_EXCLUDE_DIRS)
    print("%s: %d entries (%s excluded), %d bytes"
          % (args.out, len(entries), excluded, len(data)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
