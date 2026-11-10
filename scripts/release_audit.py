"""Read-only release/site checks; writes a report outside the built site."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
PUBLIC_REPOSITORY = "jabrailkhalil/jupyterlite-course-updates"
LICENSE_IDS = {
    "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "EPL-2.0",
    "(MPL-2.0 OR Apache-2.0)", "(CC-BY-4.0 AND OFL-1.1 AND MIT)",
}
SUPPLEMENTS = {
    "@jupyterlab/": "jupyterlab-4.6.5-LICENSE.txt",
    "@jupyter-notebook/": "notebook-7.6.4-LICENSE.txt",
    "@jupyterlite/": "jupyterlite-0.8.7-LICENSE.txt",
    "@lumino/": "lumino-widgets-2.8.0-LICENSE.txt",
    "@jupyter/ydoc": "jupyter-ydoc-4.0.0-LICENSE.txt",
    "@jupyter/react-components": "jupyter-react-components-0.17.1-LICENSE.txt",
    "@jupyter/web-components": "jupyter-web-components-0.17.1-LICENSE.txt",
    "@microsoft/fast-element": "microsoft-fast-element-1.12.0-LICENSE.txt",
    "@microsoft/fast-foundation": "microsoft-fast-foundation-2.49.5-LICENSE.txt",
    "@microsoft/fast-web-utilities": "microsoft-fast-web-utilities-5.4.1-LICENSE.txt",
    "json-schema-merge-allof": "json-schema-merge-allof-0.8.1-README.md",
    "vega-lite": "vega-lite-5.14.1-LICENSE.txt",
    "vega-util": "vega-util-1.17.4-LICENSE.txt",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def safe_path(root: Path, relative: str) -> Path:
    item = PurePosixPath(relative)
    require(not item.is_absolute() and ".." not in item.parts, f"Unsafe notice path: {relative}")
    result = (root / relative).resolve()
    require(result.is_relative_to(root.resolve()), f"Notice escaped its directory: {relative}")
    return result


def notice_sources(source_root: Path, site: Path) -> dict:
    directory = source_root / "release/licenses"
    sources = read_json(directory / "SOURCES.json")["sources"]
    require(sources and all(not item.get("error") for item in sources), "Some upstream notices are unresolved")
    seen = set()
    for item in sources:
        relative = item["path"]
        require(relative not in seen, f"Duplicate notice record: {relative}")
        seen.add(relative)
        require(item["url"].startswith("https://"), f"Notice lacks its upstream HTTPS source: {relative}")
        path = safe_path(directory, relative)
        require(sha256(path) == item["sha256"], f"Supplement differs from audited upstream bytes: {relative}")
    for path in directory.rglob("*"):
        if path.is_file():
            deployed = site / "licenses" / path.relative_to(directory)
            require(deployed.is_file() and sha256(deployed) == sha256(path), f"Deployed license missing or changed: {path.relative_to(directory)}")
    for filename in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
        original = source_root / "release" / filename
        require((site / filename).is_file() and sha256(site / filename) == sha256(original), f"Project notice not preserved in site: {filename}")
    return {"upstreamSources": len(sources), "noticeFiles": sum(path.is_file() for path in directory.rglob("*")), "sourcesSha256": sha256(directory / "SOURCES.json")}


def python_wheels(source_root: Path, site: Path) -> dict:
    directory = source_root / "release/licenses"
    catalog = read_json(directory / "PYTHON_WHEELS.json")["wheels"]
    deployed = {path.relative_to(site).as_posix() for path in site.rglob("*.whl")}
    require(len(catalog) == 21 and {item["wheelFile"] for item in catalog} == deployed, "Runtime/bootstrap wheel inventory changed; repeat its license audit")
    count = 0
    for item in catalog:
        path = safe_path(site, item["wheelFile"])
        require(sha256(path) == item["wheelSha256"], f"Audited wheel changed: {item['wheelFile']}")
        require(item["url"].startswith("https://") and item["embeddedLicenses"], f"Wheel lacks a notice/source: {item['component']}")
        with zipfile.ZipFile(path) as wheel:
            for notice in item["embeddedLicenses"]:
                body = wheel.read(notice["archivePath"])
                expected = hashlib.sha256(body).hexdigest()
                require(expected == notice["sha256"], f"Embedded wheel license differs from audit: {notice['path']}")
                require(sha256(safe_path(directory, notice["path"])) == expected, f"Supplement differs from the original wheel notice: {notice['path']}")
                count += 1
    return {"wheels": len(catalog), "embeddedNotices": count, "catalogSha256": sha256(directory / "PYTHON_WHEELS.json")}


def frontend_notices(site: Path) -> dict:
    manifests = sorted(site.rglob("third-party-licenses.json"))
    require((site / "build/third-party-licenses.json") in manifests, "JupyterLite frontend license manifest was removed")
    packages = []
    supplemented = []
    for manifest in manifests:
        require(manifest.is_file(), f"Missing frontend license manifest: {manifest}")
        for package in read_json(manifest)["packages"]:
            name = package["name"]
            require(package.get("licenseId") in LICENSE_IDS, f"Unaudited frontend license: {name} {package.get('licenseId')}")
            require(package.get("versionInfo"), f"Frontend notice has no version: {name}")
            if not package.get("extractedText", "").strip():
                supplement = next((file for prefix, file in SUPPLEMENTS.items() if name == prefix or (prefix.endswith("/") and name.startswith(prefix))), None)
                require(supplement is not None and (site / "licenses" / supplement).is_file(), f"Empty frontend notice has no audited supplement: {name}")
                supplemented.append(name)
            packages.append(package)
    return {"manifests": len(manifests), "packageEntries": len(packages), "supplementedEntries": len(supplemented), "licenses": dict(Counter(package["licenseId"] for package in packages))}


def build_integrity(site: Path) -> dict:
    evidence = read_json(site / "build-evidence.json")
    listed = set()
    for item in evidence["assets"]:
        require(item["path"] not in listed, f"Duplicate built asset: {item['path']}")
        listed.add(item["path"])
        path = safe_path(site, item["path"])
        require(path.stat().st_size == item["bytes"] and sha256(path) == item["sha256"], f"Built file changed after validation: {item['path']}")
    actual = {path.relative_to(site).as_posix() for path in site.rglob("*") if path.is_file() and path.name != "build-evidence.json"}
    require(actual == listed, "Site contains files absent from build provenance")
    require(any(path.startswith("licenses/") for path in listed), "Notices were copied after the build manifest was sealed")
    require(evidence["versions"]["pyodide"] == "314.0.6", "Runtime version changed after its release audit")
    return {"assets": len(listed), "manifestSha256": sha256(site / "build-evidence.json"), "versions": evidence["versions"], "frontendVersions": evidence.get("frontendVersions")}


def source_hygiene(source_root: Path, public: bool) -> dict:
    package = read_json(source_root / "package.json")
    require(package.get("private") is True, "npm publication guard must remain enabled")
    require((source_root / "requirements.lock").is_file() and (source_root / "package-lock.json").is_file(), "Release source must include both validated dependency locks")
    if not public:
        return {"npmPublishingDisabled": True, "publicSnapshotChecks": "not requested"}
    require(package.get("license") == "BSD-3-Clause", "Public project metadata has not adopted its approved license")
    license_path = source_root / "LICENSE"
    require(license_path.is_file() and sha256(license_path) == sha256(source_root / "release/LICENSE"), "Public root LICENSE differs from approved project license")
    output = subprocess.check_output(["git", "ls-files", "-z"], cwd=source_root)
    files = [path for path in output.decode().split("\0") if path]
    require(files, "Public snapshot has no tracked source inventory")
    forbidden_paths = re.compile(r"(^|/)(artifacts|node_modules|\.cache|\.build-input|__pycache__|test-results|playwright-report)(/|$)|(^|/)(AGENTS\.md|checkpoint[^/]*|.*\.log)$", re.IGNORECASE)
    secret = re.compile(rb"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|(?:ghp_|github_pat_)[A-Za-z0-9_]{24,}|AKIA[0-9A-Z]{16}")
    local_desktop_path = re.compile(rb"[A-Z]:[/\\]Users[/\\][^/\\\r\n]+[/\\]Desktop[/\\]", re.IGNORECASE)
    own_repository_url = re.compile(rb"https?://github\.com/jabrailkhalil/([A-Za-z0-9_.-]+)", re.IGNORECASE)
    for relative in files:
        require(not forbidden_paths.search(relative), f"Development artifact included in public snapshot: {relative}")
        require(not (source_root / relative).is_symlink(), f"Unexpected symlink in public snapshot: {relative}")
        path = safe_path(source_root, relative)
        body = path.read_bytes()
        require(not secret.search(body), f"Credential-like content in public source: {relative}")
        require(not local_desktop_path.search(body), f"Local desktop path reference in public source: {relative}")
        require(all(match.decode().lower().removesuffix(".git") == PUBLIC_REPOSITORY.split("/", 1)[1] for match in own_repository_url.findall(body)), f"Unreviewed personal repository URL in public source: {relative}")
    for filename in ("README.md", "VALIDATION.md", "THIRD_PARTY_NOTICES.md"):
        path = source_root / filename
        require(path.is_file(), f"Public document is absent: {filename}")
        body = path.read_text(encoding="utf-8")
        require(not re.search(r"PUBLIC_\w+_PENDING|\bCodex\b|agent checkpoint|private development history", body, re.IGNORECASE), f"Public document still contains preparation text: {filename}")
    return {"npmPublishingDisabled": True, "trackedFiles": len(files), "publicSnapshotChecks": "passed", "intendedRepository": PUBLIC_REPOSITORY}


def pages_smoke(report_directory: Path) -> dict:
    report = read_json(report_directory / "pages-results.json")
    stats = report["stats"]
    require(stats.get("expected") == 1 and all(stats.get(key) == 0 for key in ("unexpected", "skipped", "flaky")), f"Pages-style smoke did not pass once: {stats}")
    require(not report.get("errors"), "Pages-style smoke had an infrastructure error")
    evidence = read_json(report_directory / "pages-evidence.json")
    require(evidence.get("passed") is True and evidence.get("externalRequests") == [], "Pages-style smoke lacked same-origin success")
    require(evidence.get("deployedHost") is False, "Pre-deploy acceptance must be the isolated local subpath test")
    require(evidence["noCOI"]["crossOriginIsolated"] is False, "Pages-style smoke accidentally used cross-origin isolation")
    worker = evidence["serviceWorker"]
    require(worker["activeState"] == "activated" and worker["controllingScriptURL"] == worker["activeScriptURL"], "No active controlling Service Worker was proved")
    require(evidence["runtime"]["platform"] == "emscripten" and evidence["runtime"]["pyodide"] == "314.0.6", "Pages-style smoke did not execute the pinned browser kernel")
    filesystem = evidence["kernelFilesystem"]
    require(filesystem["contentsReadThroughKernel"] is True and filesystem["cwd"].startswith("/drive/") and filesystem["answer"] == 10, "Pages-style smoke did not prove the real contents filesystem")
    return {"passed": True, "baseURL": evidence["baseURL"], "crossOriginIsolated": False, "serviceWorker": True, "kernelFilesystem": True, "deployedHost": False}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--site", type=Path, default=ROOT / "_site")
    parser.add_argument("--report", type=Path, default=ROOT / "artifacts/release-audit.json")
    parser.add_argument("--public-source", action="store_true", help="Require a clean public source snapshot and final root documents")
    parser.add_argument("--require-pages-smoke", action="store_true", help="Also require the separate pre-deploy no-COI/subpath browser proof")
    args = parser.parse_args()
    source_root, site, report = args.source_root.resolve(), args.site.resolve(), args.report.resolve()
    require(not report.is_relative_to(site), "Write the release report outside the immutable built site")
    checks = {}
    stage = "source"
    try:
        for stage, check in (
            ("source", lambda: source_hygiene(source_root, args.public_source)),
            ("build", lambda: build_integrity(site)),
            ("notices", lambda: notice_sources(source_root, site)),
            ("wheels", lambda: python_wheels(source_root, site)),
            ("frontend", lambda: frontend_notices(site)),
        ):
            checks[stage] = check()
            print(f"Verified release {stage}", flush=True)
        if args.require_pages_smoke:
            stage = "pages-smoke"
            checks[stage] = pages_smoke(report.parent)
            print("Verified release pages-smoke", flush=True)
        result = {"schemaVersion": 1, "passed": True, "checks": checks, "note": "License/artifact audit only; hosted demo acceptance is reported separately."}
    except Exception as error:
        result = {"schemaVersion": 1, "passed": False, "stage": stage, "error": f"{type(error).__name__}: {error}", "completedChecks": checks}
        raise
    finally:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
