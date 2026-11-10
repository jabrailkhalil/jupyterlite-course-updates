"""Run the stale-review browser witnesses against one isolated CI-only mutant.

The positive browser report and every original artifact are restored before the
negative evidence is added. This script does not install dependencies or publish.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
BACKUP = ROOT / ".cache" / "negative-control-backup"
SOURCE = ROOT / "src" / "index.ts"
TARGET_DIRS = ("lib", "course_update/labextension", "_site", "artifacts")
EXPECTED_IMAGE = (
    "mcr.microsoft.com/playwright:v1.65.0-noble@sha256:"
    "6e3fb709361521eb27161606e6da6d2674e5e89fa16516cb37d6fdd91372273d"
)
TITLES = (
    "stale active model refuses a successful updated copy",
    "stale persisted content refuses a successful updated copy",
)
# Playwright matches a title path that includes the file suite before the title.
GREP = "(^| )stale (active model|persisted content)"
READY_STATUS = "Updated copy is ready. Your original notebook is unchanged."
SIGNATURE = "  private async assertFresh(review: Review): Promise<void> {"
NEXT_METHOD = "  private async saveNotebook("
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def manifest() -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    for relative in ("src/index.ts", *TARGET_DIRS):
        top = ROOT / relative
        require(top.exists() or top.is_symlink(), f"Missing restore target: {relative}")
        paths = [top]
        if top.is_dir():
            paths.extend(sorted(top.rglob("*")))
        for path in paths:
            key = path.relative_to(ROOT).as_posix()
            if path.is_symlink():
                target = os.readlink(path)
                result[key] = {"kind": "symlink", "target": target, "sha256": digest(os.fsencode(target))}
            elif path.is_file():
                result[key] = {"kind": "file", "sha256": digest(path.read_bytes())}
            elif path.is_dir():
                result[key] = {"kind": "directory"}
            else:
                raise AssertionError(f"Unsupported restore target: {key}")
    return result


def remove_generated(path: Path) -> None:
    require(path.parent.resolve().is_relative_to(ROOT), f"Refusing removal outside the project: {path}")
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def run(args: list[str], log: Path, timeout: int, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(
            args, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT,
            text=True, start_new_session=True,
        )
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
    child = subprocess.CompletedProcess(args, process.returncode)
    if check:
        require(child.returncode == 0, f"Command failed ({child.returncode}); see {log.relative_to(ROOT)}")
    return child


def specs(report: dict[str, Any]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def visit(suite: dict[str, Any]) -> None:
        found.extend(suite.get("specs", []))
        for child in suite.get("suites", []):
            visit(child)

    for suite in report.get("suites", []):
        visit(suite)
    return found


def require_positive_report() -> dict[str, Any]:
    report = json.loads((ARTIFACTS / "browser-results.json").read_text(encoding="utf-8"))
    stats = report.get("stats", {})
    require(
        stats.get("expected") == 15 and all(stats.get(key) == 0 for key in ("unexpected", "flaky", "skipped")),
        "The original browser report must contain exactly fifteen passes and no failures, skips or flaky cases.",
    )
    selected = specs(report)
    require(len(selected) == 15, "The positive browser report must contain fifteen independent specs.")
    require(not report.get("errors"), "The positive browser report contains setup or global errors.")
    for spec in selected:
        tests = spec.get("tests", [])
        require(len(tests) == 1, f"Expected one positive project result: {spec.get('title')}")
        require(tests[0].get("expectedStatus") == "passed", "A positive browser case was marked expected-to-fail.")
        results = tests[0].get("results", [])
        require(len(results) == 1 and results[0].get("status") == "passed" and results[0].get("retry", 0) == 0, "Every positive case must pass once.")
    return {"expected": 15, "unexpected": 0, "flaky": 0, "skipped": 0}


def validate_negative_report() -> list[dict[str, Any]]:
    report = json.loads((ARTIFACTS / "browser-results.json").read_text(encoding="utf-8"))
    stats = report.get("stats", {})
    require(
        stats.get("unexpected") == 2 and all(stats.get(key) == 0 for key in ("expected", "flaky", "skipped")),
        "The mutant must produce exactly two independent failures and zero passes, retries or skips.",
    )
    require(not report.get("errors"), "The mutant browser report contains setup or global errors.")
    selected = specs(report)
    require(sorted(item.get("title", "") for item in selected) == sorted(TITLES), "Unexpected mutant test selection.")
    evidence_files = sorted(path.name for path in ARTIFACTS.glob("*-evidence.json"))
    expected_files = sorted(re.sub(r"[^a-z0-9]+", "-", title, flags=re.I).lower() + "-evidence.json" for title in TITLES)
    require(evidence_files == expected_files, "Expected exactly the two selected browser evidence files.")
    results = []
    for spec in selected:
        title = spec["title"]
        tests = spec.get("tests", [])
        require(len(tests) == 1, f"Expected one project result for {title}")
        test = tests[0]
        require(test.get("expectedStatus") == "passed", f"The mutant case was marked expected-to-fail: {title}")
        attempts = test.get("results", [])
        require(len(attempts) == 1, f"A mutant case was retried: {title}")
        attempt = attempts[0]
        require(attempt.get("status") == "failed" and attempt.get("retry", 0) == 0, f"Not an ordinary assertion failure: {title}")
        errors = attempt.get("errors", [])
        require(len(errors) == 1, f"Expected exactly one assertion error for {title}")
        error = ANSI.sub("", errors[0].get("message", ""))
        expected_assertion = (
            "toContainText" in error
            and ("getByRole('status')" in error or 'getByRole("status")' in error)
            and "Expected pattern:" in error
            and "stale" in error
            and "changed" in error
            and re.search(r"Received string:\s*[\"']?" + re.escape(READY_STATUS), error) is not None
        )
        infrastructure = re.search(
            r"Test timeout of|TimeoutError:|browserType\.launch|Executable doesn't exist|"
            r"Target (?:page|context|browser).*closed|(?:page|locator)\.(?:goto|click|waitFor).*failed|"
            r"net::ERR_|SyntaxError:|ReferenceError:|TypeError:",
            error,
            re.I,
        ) is not None
        require(expected_assertion and not infrastructure, f"The case failed outside its stale-status assertion: {title}\n{error}")
        slug = re.sub(r"[^a-z0-9]+", "-", title, flags=re.I).lower()
        evidence_path = ARTIFACTS / f"{slug}-evidence.json"
        evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
        require(evidence.get("externalRequests") == [], f"External browser traffic was observed: {title}")
        require(not any(item.get("type") == "pageerror" for item in evidence.get("console", [])), f"Browser page errors were observed: {title}")
        screenshot = ARTIFACTS / f"{slug}.png"
        image = screenshot.read_bytes()
        require(len(image) > 1000 and image.startswith(b"\x89PNG\r\n\x1a\n"), f"Missing browser screenshot: {title}")
        results.append({
            "title": title, "status": "failed", "expectedStaleAssertion": True,
            "receivedRenderedStatus": READY_STATUS, "infrastructureFailure": False,
            "externalRequests": [], "screenshot": screenshot.name,
            "evidence": evidence_path.name, "assertionMessage": error,
        })
    return results


def main() -> int:
    require(os.environ.get("CI") == "true", "Browser negative controls are allowed only in remote CI with CI=true.")
    require(sys.platform == "linux", "The browser negative control requires the remote Linux Docker runner.")
    image = os.environ.get("BROWSER_IMAGE", "")
    require(image == EXPECTED_IMAGE, "BROWSER_IMAGE must match the exact digest pinned by validate.yml.")
    require(not BACKUP.exists(), "A previous negative-control backup exists; restore it before retrying.")
    require(not (ARTIFACTS / "browser-negative-control").exists(), "Negative evidence already exists; refusing to overwrite it.")
    require(not (ARTIFACTS / "browser-negative-control.json").exists(), "A negative summary already exists; refusing to overwrite it.")
    positive = require_positive_report()
    original_manifest = manifest()
    original_source = SOURCE.read_bytes()
    text = original_source.decode("utf-8")
    require(text.count(SIGNATURE) == 1 and text.count(NEXT_METHOD) == 1, "Expected exact unique freshness method boundaries.")
    start = text.index(SIGNATURE)
    end = text.index(NEXT_METHOD, start)
    require(end > start and text[start:end].rstrip().endswith("}"), "Unexpected freshness method boundary.")
    mutated = (text[:start] + SIGNATURE + "\n    void review;\n  }\n" + text[end:]).encode("utf-8")
    source_diff_before = subprocess.run(
        ["git", "diff", "--no-ext-diff", "--", "src/index.ts"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    ).stdout
    require(not source_diff_before, "The CI source already has uncommitted changes; refusing a mutation.")
    BACKUP.mkdir(parents=True)
    shutil.copy2(SOURCE, BACKUP / "index.ts")
    moved: list[str] = []
    container: str | None = None
    errors: list[str] = []
    control_results: list[dict[str, Any]] = []
    restored = False
    restored_manifest: dict[str, dict[str, str]] | None = None
    docker_result: dict[str, Any] | None = None
    source_diff_after = "not checked"
    try:
        for relative in TARGET_DIRS:
            destination = BACKUP / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(ROOT / relative), str(destination))
            moved.append(relative)
        ARTIFACTS.mkdir()
        SOURCE.write_bytes(mutated)
        run(["npm", "run", "build"], ARTIFACTS / "extension-build.log", 600)
        run([sys.executable, "scripts/build_site.py"], ARTIFACTS / "site-build.log", 900)
        container = f"course-update-browser-negative-{os.getpid()}"
        shell = f'mkdir -p "$HOME"; npm run test:browser -- --grep \'{GREP}\''
        create = [
            "docker", "create", "--name", container, "--network", "none", "--ipc", "host",
            "--user", f"{os.getuid()}:{os.getgid()}", "--env", "HOME=/tmp/course-update-home",
            "--env", "CI=true", "--env", "EXPECTED_PYODIDE_VERSION=" + os.environ.get("EXPECTED_PYODIDE_VERSION", "314.0.6"),
            "--env", "JUPYTERLITE_BASE_URL=http://127.0.0.1:4173",
            "--volume", f"{ROOT}:/work", "--workdir", "/work", image, "sh", "-lc", shell,
        ]
        run(create, ARTIFACTS / "browser-container-id.txt", 60)
        run(["docker", "inspect", container], ARTIFACTS / "browser-container-before.json", 60)
        before = json.loads((ARTIFACTS / "browser-container-before.json").read_text(encoding="utf-8"))[0]
        require(before["HostConfig"]["NetworkMode"] == "none", "The negative browser container is not network-isolated.")
        require(before["HostConfig"]["IpcMode"] == "host", "Unexpected browser IPC mode.")
        require(before["Config"]["User"] == f"{os.getuid()}:{os.getgid()}", "Unexpected browser container user.")
        require(before["Config"]["Image"] == image, "The container does not use the pinned browser image.")
        attach = run(["docker", "start", "--attach", container], ARTIFACTS / "browser.log", 600, check=False)
        run(["docker", "inspect", container], ARTIFACTS / "browser-container-after.json", 60)
        after = json.loads((ARTIFACTS / "browser-container-after.json").read_text(encoding="utf-8"))[0]
        docker_result = {
            "image": image, "networkMode": before["HostConfig"]["NetworkMode"],
            "attachExitCode": attach.returncode, "containerExitCode": after["State"]["ExitCode"],
            "oomKilled": after["State"].get("OOMKilled", False), "command": create,
        }
        require(attach.returncode == 1 and after["State"]["ExitCode"] == 1, "Expected the two assertion failures to exit with status 1.")
        require(not after["State"].get("OOMKilled") and not after["State"].get("Error"), "The browser container failed before its assertions.")
        control_results = validate_negative_report()
    except Exception as error:
        errors.append(f"{type(error).__name__}: {error}")
    finally:
        if container is not None:
            try:
                if ARTIFACTS.is_dir():
                    run(["docker", "rm", "--force", container], ARTIFACTS / "browser-container-cleanup.txt", 60)
            except Exception as error:
                errors.append(f"Container cleanup failed: {type(error).__name__}: {error}")
        negative_artifacts = BACKUP / "negative-artifacts"
        try:
            if "artifacts" in moved and ARTIFACTS.exists():
                shutil.move(str(ARTIFACTS), str(negative_artifacts))
        except Exception as error:
            errors.append(f"Negative artifacts backup failed: {type(error).__name__}: {error}")
        for relative in reversed(moved):
            try:
                target = ROOT / relative
                remove_generated(target)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(BACKUP / relative), str(target))
            except Exception as error:
                errors.append(f"Restore failed for {relative}: {type(error).__name__}: {error}")
        try:
            shutil.copy2(BACKUP / "index.ts", SOURCE)
        except Exception as error:
            errors.append(f"Source restore failed: {type(error).__name__}: {error}")
        try:
            restored_manifest = manifest()
            require(restored_manifest == original_manifest, "Original/restored SHA-256 manifests differ.")
            source_diff_after = subprocess.run(
                ["git", "diff", "--no-ext-diff", "--", "src/index.ts"],
                cwd=ROOT, capture_output=True, text=True, check=True,
            ).stdout
            require(source_diff_after == source_diff_before == "", "The original source did not restore to a clean Git diff.")
            restored = SOURCE.read_bytes() == original_source
            require(restored, "The original source bytes were not restored.")
        except Exception as error:
            errors.append(f"Restore failed: {type(error).__name__}: {error}")
        destination = ARTIFACTS / "browser-negative-control"
        try:
            ARTIFACTS.mkdir(parents=True, exist_ok=True)
            if negative_artifacts.exists():
                shutil.move(str(negative_artifacts), str(destination))
            else:
                destination.mkdir()
            write_json(destination / "original-sha256-manifest.json", original_manifest)
            write_json(destination / "restored-sha256-manifest.json", restored_manifest)
            (destination / "source-diff-before.txt").write_text(source_diff_before, encoding="utf-8")
            (destination / "source-diff-after.txt").write_text(source_diff_after, encoding="utf-8")
            passed = restored and not errors and len(control_results) == 2
            summary = {
                "schemaVersion": 1,
                "evidence": "Synthetic freshness-guard removal; two real browser assertion failures under network-isolated Docker. No kernel or human-review claim.",
                "positiveBrowserReport": positive,
                "mutation": {"method": "assertFresh", "replacementBody": "void review;", "originalSourceSha256": digest(original_source), "mutatedSourceSha256": digest(mutated)},
                "browser": docker_result, "controls": control_results,
                "restored": restored, "sha256ManifestsEqual": restored_manifest == original_manifest,
                "sourceGitDiffRestoredClean": source_diff_after == source_diff_before == "",
                "originalArtifactsPreserved": restored,
                "errors": errors, "passed": passed,
                "negativeArtifacts": "artifacts/browser-negative-control/",
            }
            write_json(ARTIFACTS / "browser-negative-control.json", summary)
            if restored:
                remove_generated(BACKUP)
            print(("PASS" if passed else "FAIL") + " browser freshness negative control")
            print("Evidence: artifacts/browser-negative-control.json")
            return 0 if passed else 1
        except Exception as error:
            print(f"Negative-control evidence could not be preserved: {type(error).__name__}: {error}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Browser negative control refused: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
