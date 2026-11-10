"""Verify private remote evidence without treating a build as browser proof."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import nbformat
from packaging.requirements import Requirement


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
SITE = ROOT / "_site"
EXPECTED_BROWSER_CASES = 15
PYODIDE_VERSION = "314.0.6"
IMAGE = (
    "mcr.microsoft.com/playwright:v1.65.0-noble@sha256:"
    "6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d"
)
CORE_SHA256 = "1016c31e39ce3764d9a418cbb491a392c802c1b86ccc1367f009f5c59bf8f5fd"
COMM_SHA256 = "c615d91d75f7f04f095b30d1c1711babd43bdc6419c1be9886a85f2f4e489417"
PINNED = {
    "jupyterlite-core": "0.8.7",
    "jupyterlite-pyodide-kernel": "0.8.7",
    "jupyterlab": "4.6.5",
    "jupyter-builder": "1.2.4",
    "hatchling": "1.28.0",
    "pyodide": PYODIDE_VERSION,
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def inside(root: Path, relative: str) -> Path:
    value = PurePosixPath(relative)
    require(not value.is_absolute() and ".." not in value.parts, f"Unsafe evidence path: {relative}")
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()), f"Evidence path escapes its root: {relative}")
    return path


def source(value) -> str:
    return "".join(value) if isinstance(value, list) else value


def validate_notebook() -> dict:
    path = ARTIFACTS / "browser-updated-notebook.json"
    notebook = nbformat.read(path, as_version=4)
    nbformat.validate(notebook)
    require([cell.id for cell in notebook.cells] == ["instructions", "answer"], "Updated notebook lost the fixed cell IDs/order")
    expected_instructions = read_json(ROOT / "fixtures/course-assets/v2/lesson.ipynb")["cells"][0]["source"]
    require(source(notebook.cells[0].source) == source(expected_instructions), "Author instructions are absent from the browser result")
    answer = notebook.cells[1]
    require(source(answer.source) == 'answer = sum([2, 3, 5])\nprint("learner:", answer)', "Browser result lost the learner answer")
    stdout = "".join(source(output.text) for output in answer.outputs if output.output_type == "stream")
    require(stdout == f"learner: {sum([2, 3, 5])}\n", "Browser result lacks the independently expected executed answer")
    require(isinstance(answer.execution_count, int) and answer.execution_count > 0, "Browser answer was not recorded as executed")
    return {"path": str(path.relative_to(ROOT)), "sha256": digest(path), "nbformat": notebook.nbformat, "cells": len(notebook.cells)}


def browser_specs(suites):
    for suite in suites:
        yield from suite.get("specs", [])
        yield from browser_specs(suite.get("suites", []))


def validate_browser() -> dict:
    report = read_json(ARTIFACTS / "browser-results.json")
    stats = report["stats"]
    require(stats.get("expected") == EXPECTED_BROWSER_CASES, f"Expected {EXPECTED_BROWSER_CASES} successful browser cases: {stats}")
    for key in ("unexpected", "skipped", "flaky"):
        require(stats.get(key) == 0, f"Browser {key} must be zero: {stats}")
    require(not report.get("errors"), f"Browser infrastructure errors: {report.get('errors')}")
    specs = list(browser_specs(report["suites"]))
    require(len(specs) == EXPECTED_BROWSER_CASES, "Browser report has an unexpected number of independent specs")
    require(len({spec["title"] for spec in specs}) == EXPECTED_BROWSER_CASES, "Browser spec titles are not independent")
    for spec in specs:
        require(spec.get("ok") is True and len(spec["tests"]) == 1, f"Browser spec did not pass once: {spec['title']}")
        test = spec["tests"][0]
        require(test.get("expectedStatus") == "passed" and test.get("status") == "expected", f"Browser expected status changed: {spec['title']}")
        results = test["results"]
        require(len(results) == 1 and results[0].get("status") == "passed" and results[0].get("retry", 0) == 0, f"Browser case retried, skipped or failed: {spec['title']}")
        require(not results[0].get("errors") and not results[0].get("error"), f"Browser result contains an error: {spec['title']}")

    evidence_paths = sorted(ARTIFACTS.glob("*-evidence.json"))
    require(len(evidence_paths) == EXPECTED_BROWSER_CASES, "Each browser case must save its own evidence")
    runtimes = []
    for path in evidence_paths:
        evidence = read_json(path)
        require(evidence.get("externalRequests") == [], f"External runtime request observed in {path.name}")
        transports = evidence.get("transportSessions", [])
        require(bool(transports), f"No declared browser transport proof in {path.name}")
        for transport in transports:
            require(transport.get("crossOriginIsolated") is False, f"Unsupported COI transport in {path.name}")
            require(transport.get("serviceWorkerState") == "activated" and transport.get("activeServiceWorkerState") == "activated", f"Service Worker was not active in {path.name}")
            require(transport.get("serviceWorkerScriptURL") == transport.get("activeServiceWorkerScriptURL"), f"Service Worker did not control the page in {path.name}")
        page_errors = [message for message in evidence.get("console", []) if message.get("type") == "pageerror"]
        require(not page_errors, f"Unhandled browser page error in {path.name}: {page_errors}")
        runtime = evidence.get("runtime")
        if runtime is not None:
            require(runtime.get("platform") == "emscripten", "Runtime proof is not a real browser Python platform")
            require(runtime.get("pyodide") == PYODIDE_VERSION, f"Unexpected actual Pyodide runtime: {runtime}")
            require(runtime.get("python", "").startswith("3.14."), f"Unexpected browser Python runtime: {runtime}")
            runtimes.append(runtime)
    require(bool(runtimes), "No actual browser kernel/runtime execution was recorded")

    container = read_json(ARTIFACTS / "browser-container-after.json")
    require(len(container) == 1, "Expected one inspected browser container")
    container = container[0]
    require(container["HostConfig"]["NetworkMode"] == "none", "Browser container external networking was enabled")
    require(container["HostConfig"]["IpcMode"] == "host", "Browser container IPC mode differs from the reviewed command")
    require(container["Config"]["Image"] == IMAGE, "Browser image was not pinned to the reviewed digest")
    require(container["Config"]["User"] == f"{os.getuid()}:{os.getgid()}", "Browser did not run as the host runner UID/GID")
    require(container["State"]["ExitCode"] == 0 and container["State"]["Status"] == "exited", "Browser container did not exit successfully")
    env = set(container["Config"].get("Env", []))
    require("CI=true" in env and f"EXPECTED_PYODIDE_VERSION={PYODIDE_VERSION}" in env, "Browser validation environment differs from the pinned runtime")
    require(any(mount["Destination"] == "/work" and Path(mount["Source"]).resolve() == ROOT for mount in container["Mounts"]), "Browser did not test this source/site bind mount")
    image = read_json(ARTIFACTS / "browser-image-inspect.json")
    require(len(image) == 1 and IMAGE.split(":v", 1)[0] + "@" + IMAGE.split("@", 1)[1] in image[0].get("RepoDigests", []), "Pulled image digest is missing from Docker evidence")
    return {"passed": len(specs), "failed": 0, "skipped": 0, "flaky": 0, "titles": [spec["title"] for spec in specs], "runtimes": runtimes, "networkMode": "none", "image": IMAGE}


def validate_units() -> dict:
    tap = (ARTIFACTS / "unit.tap").read_text(encoding="utf-8")
    counts = {}
    for key in ("tests", "pass", "fail", "cancelled", "skipped", "todo"):
        matches = re.findall(rf"^# {key} (\d+)\s*$", tap, re.MULTILINE)
        require(len(matches) == 1, f"Unit TAP lacks a unique {key} count")
        counts[key] = int(matches[0])
    require(counts["tests"] > 0 and counts["pass"] == counts["tests"], f"Unit suite did not pass completely: {counts}")
    require(all(counts[key] == 0 for key in ("fail", "cancelled", "skipped", "todo")), f"Unit suite contains failures/skips: {counts}")
    negative = read_json(ARTIFACTS / "unit-negative-controls.json")
    require(negative.get("passed") is True and negative.get("restored") is True and not negative.get("infrastructureError"), "Unit negative controls or compiled restoration failed")
    controls = negative["controls"]
    require(len(controls) == 3 and len({control["id"] for control in controls}) == 3, "Expected three independent unit negative controls")
    for control in controls:
        require(control.get("passed") is True and control.get("executed") is True and control.get("exitCode") == 1, f"Negative control did not fail as expected: {control['id']}")
        require(control.get("assertionFailure") is True and control.get("namedFailure") is True and not control.get("setupError"), f"Negative control failed during setup instead of its assertion: {control['id']}")
    compiled_hash = digest(ROOT / "lib/merge.js")
    require(negative["originalCompiledSha256"] == negative["restoredCompiledSha256"] == compiled_hash, "Negative controls did not restore the compiled engine byte-for-byte")
    return {**counts, "negativeControls": 3, "compiledRestored": True, "compiledSha256": compiled_hash}


def validate_locks() -> dict:
    lock = ROOT / "requirements.lock"
    logical = []
    pending = ""
    for raw in lock.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        continuation = line.endswith("\\")
        pending += " " + (line[:-1].rstrip() if continuation else line)
        if not continuation:
            logical.append(pending.strip())
            pending = ""
    require(not pending and bool(logical), "Python lock is empty or has a truncated continuation")
    active = []
    for line in logical:
        hashes = re.findall(r"(?:^|\s)--hash=sha256:([a-f0-9]{64})(?=\s|$)", line)
        require(bool(hashes), f"Python requirement is missing SHA256 hashes: {line[:100]}")
        requirement = Requirement(re.sub(r"\s+--hash=sha256:[a-f0-9]{64}", "", line))
        specifiers = list(requirement.specifier)
        require(not requirement.url and len(specifiers) == 1 and specifiers[0].operator == "==" and "*" not in specifiers[0].version, f"Python dependency is not exactly pinned: {requirement}")
        if requirement.marker is None or requirement.marker.evaluate():
            installed = importlib.metadata.version(requirement.name)
            require(installed == specifiers[0].version, f"Installed Python dependency differs from lock: {requirement.name} {installed}")
            active.append(requirement.name)
    package = read_json(ROOT / "package.json")
    npm_lock = read_json(ROOT / "package-lock.json")
    require(npm_lock.get("lockfileVersion", 0) >= 2, "npm lock lacks the packages/integrity format")
    packages = npm_lock["packages"]
    for group in ("dependencies", "devDependencies"):
        require(packages[""][group] == package[group], f"npm root {group} differs from package.json")
        for name, version in package[group].items():
            require(packages[f"node_modules/{name}"]["version"] == version, f"npm direct dependency differs from its exact pin: {name}")
    for name, info in packages.items():
        if not name or info.get("link"):
            continue
        require(info.get("version") and info.get("resolved") and re.search(r"\bsha(?:1|256|384|512)-", info.get("integrity", "")), f"npm dependency lacks a version/resolution/integrity: {name}")
    return {"python": {"path": lock.name, "sha256": digest(lock), "hashedRequirements": len(logical), "activeInstalled": len(active)}, "npm": {"path": "package-lock.json", "sha256": digest(ROOT / "package-lock.json"), "packages": len(packages) - 1}}


def validate_build() -> dict:
    evidence = read_json(SITE / "build-evidence.json")
    require(evidence.get("sourceCommit") == subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "Built site source commit differs from checked-out source")
    require(evidence["versions"] == PINNED, f"Unexpected build/runtime pins: {evidence['versions']}")
    listed = set()
    for asset in evidence["assets"]:
        path = inside(SITE, asset["path"])
        require(asset["path"] not in listed, f"Duplicate deployed asset in evidence: {asset['path']}")
        require(path.is_file() and path.stat().st_size == asset["bytes"] and digest(path) == asset["sha256"], f"Deployed asset differs from build evidence: {asset['path']}")
        listed.add(asset["path"])
    actual = {path.relative_to(SITE).as_posix() for path in SITE.rglob("*") if path.is_file() and path.name != "build-evidence.json"}
    require(listed == actual, "Build evidence does not cover every deployed asset")
    for asset in sorted((ROOT / "fixtures/course-assets").rglob("*")):
        if asset.is_file():
            deployed = SITE / "course-assets" / asset.relative_to(ROOT / "fixtures/course-assets")
            require(digest(asset) == digest(deployed), f"Immutable author asset was changed during build: {asset}")
    require(digest(SITE / "files/lesson.ipynb") == digest(ROOT / "fixtures/course-assets/v1/lesson.ipynb"), "Learner seed differs from immutable base version")

    downloads = evidence["downloads"]
    core = [item for item in downloads if item["kind"] == "pyodide-core"]
    require(len(core) == 1 and core[0]["sha256"] == CORE_SHA256 and core[0]["version"] == PYODIDE_VERSION, "Core runtime release digest/version differs from the reviewed asset")
    cache = ROOT / ".cache/runtime-downloads"
    for item in downloads:
        filename = PurePosixPath(urlsplit(item["url"]).path).name
        path = inside(cache, filename)
        require(path.stat().st_size == item["bytes"] and digest(path) == item["sha256"], f"Downloaded cache asset failed its evidence hash: {filename}")
        require(item["url"].startswith("https://"), f"Unencrypted runtime asset source: {item['url']}")
    core_path = cache / f"pyodide-core-{PYODIDE_VERSION}.tar.bz2"
    runtime = SITE / "static/pyodide"
    with tarfile.open(core_path, "r:bz2") as archive:
        locks = [member for member in archive.getmembers() if PurePosixPath(member.name).name == "pyodide-lock.json"]
        require(len(locks) == 1, "Pinned core archive does not contain exactly one package lock")
        locked_bytes = archive.extractfile(locks[0]).read()
        require(locked_bytes == (runtime / "pyodide-lock.json").read_bytes(), "Deployed runtime lock differs from the SHA256-verified core archive")
        prefix = str(PurePosixPath(locks[0].name).parent)
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith(prefix + "/"):
                continue
            relative = str(PurePosixPath(member.name).relative_to(prefix))
            require(hashlib.sha256(archive.extractfile(member).read()).hexdigest() == digest(inside(runtime, relative)), f"Core runtime file differs from verified archive: {relative}")
    lock = json.loads(locked_bytes)
    packages = {name.replace("_", "-"): value for name, value in lock["packages"].items()}
    runtime_downloads = [item for item in downloads if item["kind"] == "pyodide-package"]
    require(len(runtime_downloads) == 15 and len({item["name"] for item in runtime_downloads}) == 15, "Expected fifteen independently hashed Pyodide bootstrap packages")
    for item in runtime_downloads:
        package = packages[item["name"]]
        require(item["version"] == package["version"] and item["sha256"] == package["sha256"], f"Runtime package differs from its pinned embedded lock: {item['name']}")
        require(digest(runtime / package["file_name"]) == package["sha256"], f"Deployed runtime package failed hash validation: {item['name']}")
    comm = [item for item in downloads if item["kind"] == "piplite-package"]
    require(len(comm) == 1 and comm[0]["name"] == "comm" and comm[0]["version"] == "0.2.3" and comm[0]["sha256"] == COMM_SHA256, "Unexpected extra piplite dependency")
    require(digest(SITE / "pypi/comm-0.2.3-py3-none-any.whl") == COMM_SHA256, "Deployed comm wheel failed its reviewed hash")
    return {"path": "_site/build-evidence.json", "sha256": digest(SITE / "build-evidence.json"), "deployedAssets": len(actual), "verifiedDownloads": len(downloads), "versions": evidence["versions"]}


def validate_source() -> dict:
    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", *args], cwd=ROOT)
    head = git("rev-parse", "HEAD").decode().strip()
    require(not os.environ.get("GITHUB_SHA") or head == os.environ["GITHUB_SHA"], "Checked-out source differs from the requested GitHub commit")
    require((ARTIFACTS / "source-head.txt").read_text().strip() == head, "Source changed since validation started")
    subprocess.run(["git", "diff", "--exit-code", "HEAD", "--"], cwd=ROOT, check=True)
    files = [path for path in git("ls-files", "-z").decode().split("\0") if path]
    manifest = [{"path": path, "sha256": digest(inside(ROOT, path))} for path in files]
    provenance = {"commit": head, "tree": git("rev-parse", "HEAD^{tree}").decode().strip(), "trackedSourceFiles": manifest}
    (ARTIFACTS / "source-provenance.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    return {"commit": head, "trackedFiles": len(manifest), "manifestSha256": digest(ARTIFACTS / "source-provenance.json")}


def validate_browser_negative() -> dict:
    path = ARTIFACTS / "browser-negative-control.json"
    evidence = read_json(path)
    for field in ("passed", "restored", "sha256ManifestsEqual", "sourceGitDiffRestoredClean", "originalArtifactsPreserved"):
        require(evidence.get(field) is True, f"Browser negative control did not prove {field}")
    require(len(evidence["controls"]) == 2 and not evidence["errors"], "Expected exactly two browser assertion witnesses without infrastructure errors")
    return {"path": str(path.relative_to(ROOT)), "sha256": digest(path), "controls": 2, "restored": True}


def main() -> None:
    ARTIFACTS.mkdir(exist_ok=True)
    checks = {}
    stage = "source"
    try:
        for stage, check in (
            ("source", validate_source),
            ("locks", validate_locks),
            ("unit", validate_units),
            ("build", validate_build),
            ("browser", validate_browser),
            ("browserNegative", validate_browser_negative),
            ("notebook", validate_notebook),
        ):
            checks[stage] = check()
            print(f"Verified {stage}", flush=True)
        summary = {"schemaVersion": 1, "passed": True, "validationArtifact": True, "checks": checks}
        (ARTIFACTS / "validation-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"Verified {EXPECTED_BROWSER_CASES} browser cases, real pinned Pyodide execution, network isolation and artifact provenance.")
    except Exception as error:
        failure = {"schemaVersion": 1, "passed": False, "stage": stage, "error": f"{type(error).__name__}: {error}", "completedChecks": checks}
        (ARTIFACTS / "validation-failure.json").write_text(json.dumps(failure, indent=2) + "\n", encoding="utf-8")
        raise


if __name__ == "__main__":
    main()
