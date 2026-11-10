"""Build an all-local JupyterLite site in remote CI only.

Setup downloads are allowed here. Browser acceptance subsequently runs with its
container network disabled and serves this output on container-local HTTP.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "runtime-downloads"
SITE = ROOT / "_site"
PYODIDE_VERSION = "314.0.6"
PYODIDE_CORE_URL = (
    "https://github.com/pyodide/pyodide/releases/download/"
    f"{PYODIDE_VERSION}/pyodide-core-{PYODIDE_VERSION}.tar.bz2"
)
PYODIDE_CORE_SHA256 = (
    "1016c31e39ce3764d9a418cbb491a392c802c1b86ccc1367f009f5c59bf8f5fd"
)
PYODIDE_PACKAGES_URL = f"https://cdn.jsdelivr.net/pyodide/v{PYODIDE_VERSION}/full/"
COMM_URL = (
    "https://files.pythonhosted.org/packages/60/97/"
    "891a0971e1e4a8c5d2b20bbe0e524dc04548d2307fee33cdeba148fd4fc7/"
    "comm-0.2.3-py3-none-any.whl"
)
COMM_SHA256 = "c615d91d75f7f04f095b30d1c1711babd43bdc6419c1be9886a85f2f4e489417"
PINNED = {
    "jupyterlite-core": "0.8.7",
    "jupyterlite-pyodide-kernel": "0.8.7",
    "jupyterlab": "4.6.5",
    "jupyter-builder": "1.2.4",
    "hatchling": "1.28.0",
}
EXPECTED_RUNTIME_PACKAGES = {
    "asttokens",
    "decorator",
    "executing",
    "ipython",
    "jedi",
    "matplotlib-inline",
    "micropip",
    "parso",
    "prompt-toolkit",
    "pure-eval",
    "pygments",
    "six",
    "stack-data",
    "traitlets",
    "wcwidth",
}
KERNEL_PLUGIN = "@jupyterlite/pyodide-kernel-extension:kernel"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def fetch_verified(url: str, expected: str, filename: str) -> Path:
    if PurePosixPath(filename).name != filename or "\\" in filename:
        raise ValueError(f"Unsafe download filename: {filename}")
    CACHE.mkdir(parents=True, exist_ok=True)
    destination = CACHE / filename
    if destination.exists() and sha256(destination) == expected:
        return destination
    request = urllib.request.Request(url, headers={"User-Agent": "course-update-lab/0.0.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        with tempfile.NamedTemporaryFile(dir=CACHE, delete=False) as stream:
            temporary = Path(stream.name)
            shutil.copyfileobj(response, stream)
    try:
        actual = sha256(temporary)
        if actual != expected:
            raise ValueError(f"SHA256 mismatch for {filename}: {actual}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def runtime_assets(input_dir: Path) -> list[dict[str, object]]:
    archive = fetch_verified(
        PYODIDE_CORE_URL,
        PYODIDE_CORE_SHA256,
        f"pyodide-core-{PYODIDE_VERSION}.tar.bz2",
    )
    extracted = input_dir / "runtime-extracted"
    extracted.mkdir()
    with tarfile.open(archive, "r:bz2") as bundle:
        members = bundle.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if (
                path.is_absolute()
                or ".." in path.parts
                or not (member.isfile() or member.isdir())
            ):
                raise ValueError(f"Unsupported runtime archive member: {member.name}")
        bundle.extractall(extracted, members=members, filter="data")
    roots = [path.parent for path in extracted.rglob("pyodide.mjs")]
    if len(roots) != 1:
        raise ValueError("Expected exactly one Pyodide module in the pinned core archive")
    runtime = input_dir / "static" / "pyodide"
    shutil.copytree(roots[0], runtime)
    lock_path = runtime / "pyodide-lock.json"
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    packages = {name.lower().replace("_", "-"): info for name, info in lock["packages"].items()}
    closure = {}
    pending = ["micropip", "jedi", "ipython"]
    while pending:
        name = pending.pop().lower().replace("_", "-")
        if name in closure:
            continue
        package = packages[name]
        closure[name] = package
        pending.extend(package.get("depends", []))
    if set(closure) != EXPECTED_RUNTIME_PACKAGES:
        raise ValueError(f"Unexpected pinned Pyodide bootstrap dependency closure: {sorted(closure)}")
    evidence = [
        {
            "kind": "pyodide-core",
            "version": PYODIDE_VERSION,
            "url": PYODIDE_CORE_URL,
            "sha256": PYODIDE_CORE_SHA256,
            "bytes": archive.stat().st_size,
            "lockSha256": sha256(lock_path),
        }
    ]
    for name, package in sorted(closure.items()):
        filename = package["file_name"]
        url = PYODIDE_PACKAGES_URL + filename
        wheel = fetch_verified(url, package["sha256"], filename)
        shutil.copyfile(wheel, runtime / filename)
        evidence.append(
            {
                "kind": "pyodide-package",
                "name": name,
                "version": package["version"],
                "url": url,
                "sha256": package["sha256"],
                "bytes": wheel.stat().st_size,
            }
        )
    comm = fetch_verified(COMM_URL, COMM_SHA256, "comm-0.2.3-py3-none-any.whl")
    wheels = input_dir / "pypi"
    wheels.mkdir()
    shutil.copyfile(comm, wheels / comm.name)
    evidence.append(
        {
            "kind": "piplite-package",
            "name": "comm",
            "version": "0.2.3",
            "url": COMM_URL,
            "sha256": COMM_SHA256,
            "bytes": comm.stat().st_size,
        }
    )
    return evidence


def verify_build() -> None:
    required = [
        SITE / "lab" / "index.html",
        SITE / "files" / "lesson.ipynb",
        SITE / "course-assets" / "course.json",
        SITE / "course-assets" / "asset-manifest.json",
        SITE / "static" / "pyodide" / "pyodide.mjs",
        SITE / "static" / "pyodide" / "pyodide-lock.json",
        SITE / "pypi" / "all.json",
    ]
    for path in required:
        if not path.is_file():
            raise FileNotFoundError(path)
    if (SITE / "files" / "course-assets").exists():
        raise ValueError("Immutable author assets must not enter the learner contents overlay")
    settings = json.loads((SITE / "jupyter-lite.json").read_text(encoding="utf-8"))[
        "jupyter-config-data"
    ]
    if str(settings.get("exposeAppInBrowser")).lower() != "true":
        raise ValueError("Browser acceptance requires explicit app exposure")
    overrides = settings["settingsOverrides"]
    if overrides["@jupyterlab/docmanager-extension:plugin"]["autosave"] is not False:
        raise ValueError("Autosave must be disabled for dirty-model acceptance cases")
    if overrides[KERNEL_PLUGIN]["disablePyPIFallback"] is not True:
        raise ValueError("Public PyPI fallback must be disabled")
    if not settings["litePluginSettings"][KERNEL_PLUGIN]["pyodideUrl"].startswith("./static/pyodide/"):
        raise ValueError("Pyodide must use the local pinned runtime")


def main() -> None:
    if os.environ.get("CI", "").lower() != "true":
        raise SystemExit("Run asset downloads and site builds in remote CI only (CI=true).")
    if sys.version_info < (3, 12):
        raise SystemExit("Python >=3.12 is required")
    installed = {name: importlib.metadata.version(name) for name in PINNED}
    if installed != PINNED:
        raise ValueError(f"Build dependency versions differ from the pins: {installed}")
    extension = ROOT / "course_update" / "labextension"
    if not (extension / "package.json").is_file():
        raise FileNotFoundError("Build the portable frontend labextension before building the site")
    generated = ROOT / ".build-input"
    generated.mkdir(exist_ok=True)
    input_dir = Path(tempfile.mkdtemp(prefix="site-", dir=generated))
    fixtures = ROOT / "fixtures" / "course-assets"
    shutil.copytree(fixtures, input_dir / "course-assets")
    files = input_dir / "files"
    files.mkdir()
    shutil.copyfile(fixtures / "v1" / "lesson.ipynb", files / "lesson.ipynb")
    downloads = runtime_assets(input_dir)
    write_json(
        input_dir / "jupyter-lite.json",
        {"jupyter-config-data": {"exposeAppInBrowser": True}},
    )
    write_json(
        input_dir / "overrides.json",
        {
            "@jupyterlab/docmanager-extension:plugin": {"autosave": False},
            KERNEL_PLUGIN: {"disablePyPIFallback": True},
        },
    )
    config = input_dir / "jupyter_lite_config.json"
    write_json(
        config,
        {
            "LiteBuildConfig": {
                "lite_dir": str(input_dir),
                "output_dir": str(SITE),
                "cache_dir": str(ROOT / ".cache" / "lite"),
                "apps": ["lab"],
                "contents": [str(files)],
                "federated_extensions": [str(extension)],
            }
        },
    )
    command = [sys.executable, "-m", "jupyterlite_core.app", "build", f"--config={config}"]
    subprocess.run(command, cwd=input_dir, check=True)
    shutil.copytree(ROOT / "release" / "licenses", SITE / "licenses", dirs_exist_ok=True)
    shutil.copyfile(ROOT / "release" / "LICENSE", SITE / "licenses" / "PROJECT-LICENSE.txt")
    shutil.copyfile(ROOT / "release" / "THIRD_PARTY_NOTICES.md", SITE / "licenses" / "THIRD_PARTY_NOTICES.md")
    shutil.copyfile(ROOT / "release" / "LICENSE", SITE / "LICENSE")
    shutil.copyfile(ROOT / "release" / "THIRD_PARTY_NOTICES.md", SITE / "THIRD_PARTY_NOTICES.md")
    verify_build()
    evidence = {
        "schemaVersion": 1,
        "status": "built-not-browser-verified",
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "sourceCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "python": sys.version,
        "versions": {**installed, "pyodide": PYODIDE_VERSION},
        "frontendVersions": json.loads((SITE / "jupyter-lite.json").read_text(encoding="utf-8"))["jupyter-config-data"]["versionInfo"],
        "command": command,
        "downloads": downloads,
        "assets": [
            {
                "path": path.relative_to(SITE).as_posix(),
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
            for path in sorted(SITE.rglob("*"))
            if path.is_file() and path.name != "build-evidence.json"
        ],
    }
    write_json(SITE / "build-evidence.json", evidence)
    print(f"Built site at {SITE}; browser/kernel/offline acceptance is still required.")


if __name__ == "__main__":
    main()
