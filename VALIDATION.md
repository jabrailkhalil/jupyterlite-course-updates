# Validation

The v0.1.0 release workflow requires these checks:

- Extension build and strict TypeScript compilation.
- 31 independent unit tests: merge rules, line highlighting and the native Atomics synchronous-return witness.
- 15 independent Chromium cases with no retries or skipped cases. These check the learner answer, real Pyodide execution before and after a persistent-browser restart, both conflict choices, output invalidation, cancellation, stale/moved originals, saved work, line highlights, 720px layout, keyboard controls, frozen completed choices and literal HTML rendering.
- Three deliberately faulty merge variants must fail their intended unit assertions. Removing the freshness guards must produce exactly two intended browser assertion failures. Original source, generated files and evidence must restore byte for byte.
- A network-isolated subpath check without COOP/COEP must prove an activated controlling Service Worker, real Pyodide filesystem access under /drive/, the saved notebook source, answer 10 and the review workflow.
- The license audit checks upstream source notices, 21 distributed wheels and frontend license manifests. The build audit checks every deployed asset, dependency locks and exact source revision.
- After deployment, a fresh browser checks the actual GitHub Pages origin and the same filesystem/review flow. This hosted check is distinct from the network-isolated checks.

[Workflow and actual runs](https://github.com/jabrailkhalil/jupyterlite-course-updates/actions/workflows/public-demo.yml)

Each CI artifact includes source provenance, test reports, runtime versions and screenshots. The downloaded build includes validation-summary.json, release-audit.json and pages-evidence.json. The deployed build-evidence.json identifies the source commit tested before publication.

## Screenshots

[Unresolved conflict](docs/images/review-conflict.png) · [Resolved preview](docs/images/review-resolved.png) · [Updated notebook](docs/images/updated-notebook.png) · [720px layout](docs/images/review-narrow.png)

## Limits

This is one synthetic course with fixed cell IDs and whole-cell source updates. It is not a full nbformat/output validator or a proof that an answer fits changed instructions. Arbitrary concurrent-tab transactions, structural merges, other kernels and the cross-origin-isolated Atomics transport are outside v0.1.0. Keyboard checks cover native radio navigation; the responsive check covers 720px. Neither is a complete accessibility or all-browser audit.
