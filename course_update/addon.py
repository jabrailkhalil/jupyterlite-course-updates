"""Copy immutable course versions outside the learner contents overlay."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from jupyterlite_core.addons.base import BaseAddon


def copy_course_assets(source: Path, destination: Path) -> None:
    """Preserve fixture bytes and record the exact deployed author snapshots."""
    manifest = json.loads((source / "course.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != 1 or manifest.get("courseId") != "sum-course":
        raise ValueError("Unsupported course manifest")

    versions = [manifest["base"], *manifest["updates"]]
    for version in versions:
        url = version["url"]
        relative = Path(url)
        if relative.is_absolute() or ".." in relative.parts or ":" in url:
            raise ValueError(f"Course asset must be a relative local path: {url}")
        asset = (source / relative).resolve()
        if not asset.is_relative_to(source.resolve()) or not asset.is_file():
            raise ValueError(f"Missing or unsafe course asset: {url}")

    destination.mkdir(parents=True, exist_ok=True)
    assets = []
    for asset in sorted(source.rglob("*")):
        if asset.is_symlink():
            raise ValueError(f"Course assets cannot be symlinks: {asset}")
        if not asset.is_file():
            continue
        relative = asset.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(asset, target)
        data = asset.read_bytes()
        assets.append(
            {
                "path": relative.as_posix(),
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    (destination / "asset-manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "assets": assets}, indent=2) + "\n",
        encoding="utf-8",
    )


class CourseUpdateAddon(BaseAddon):
    """Emit course-assets independently of files/ and browser persistence."""

    __all__ = ["build"]

    def build(self, manager):
        source = manager.lite_dir / "course-assets"
        if not (source / "course.json").is_file():
            raise FileNotFoundError(source / "course.json")
        destination = manager.output_dir / "course-assets"
        files = sorted(path for path in source.rglob("*") if path.is_file())
        yield self.task(
            name="immutable-course-assets",
            file_dep=files,
            targets=[
                *(destination / path.relative_to(source) for path in files),
                destination / "asset-manifest.json",
            ],
            actions=[(copy_course_assets, [source, destination])],
        )
