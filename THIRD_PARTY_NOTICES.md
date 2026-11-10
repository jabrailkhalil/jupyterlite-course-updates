# Third-party notices

The project license covers this project's original code. It does not replace the licenses of JupyterLite, the Python runtime, fonts or bundled dependencies. These components are redistributed without project-specific changes.

The built site retains `build/third-party-licenses.json` and each extension's `static/third-party-licenses.json`. Supplemental texts are copied to `licenses/`. Their original URLs, versions and SHA256 hashes are recorded in `licenses/SOURCES.json`; wheel contents are recorded in `licenses/PYTHON_WHEELS.json`. The same source files live in `release/licenses/` in this repository. Keep these notices with redistributed builds.

## Frontend

JupyterLite 0.8.7, JupyterLab 4.6.5, Jupyter Notebook 7.6.4, Lumino and the Jupyter UI packages use BSD-3-Clause. Their upstream copyright notices are preserved in the supplemental license files. Other JavaScript packages retain the license texts collected in the generated frontend manifests. Supplemental texts cover packages whose generated entry has no extracted text.

Font Awesome Free 5.15.4 is by Fonticons, Inc. Its icons use CC-BY-4.0, fonts use OFL-1.1, and code uses MIT. The upstream attribution notice and the CC-BY/OFL texts are included; font and icon attribution comments remain in the original assets. Brand names and icons do not imply endorsement.

ELKjs 0.9.3 uses EPL-2.0. The unmodified distribution's license is included. Its source and build instructions are available at the [published package's source commit](https://github.com/kieler/elkjs/tree/a8304cf79fde75bc2ab1a89d28320f53f8637436); the underlying Eclipse Layout Kernel is available from [eclipse-elk/elk](https://github.com/eclipse-elk/elk). DOMPurify's generated notice includes its Apache-2.0 alternative.

`json-schema-merge-allof` 0.8.1 declares MIT and identifies Martin Hansen in its upstream README. That exact README is preserved because the pinned source has no separate LICENSE file; the canonical MIT text is provided alongside the original notice.

## Python runtime

Pyodide 314.0.6 uses MPL-2.0. Its corresponding source and build files are available in the [314.0.6 source tree](https://github.com/pyodide/pyodide/tree/314.0.6) and [source archive](https://github.com/pyodide/pyodide/archive/refs/tags/314.0.6.tar.gz). The MPL text is included. The runtime includes CPython 3.14.2 under the Python license and incorporated-software notices, plus Emscripten 5.0.3 and its bundled musl notices. License texts for linked libffi, hiwire, liblzma, Zstandard, SQLite, bzip2 and zlib are preserved separately. The exact build dependencies are specified by Pyodide's [`cpython/Makefile`](https://github.com/pyodide/pyodide/blob/314.0.6/cpython/Makefile) and [`Makefile.envs`](https://github.com/pyodide/pyodide/blob/314.0.6/Makefile.envs).

These fifteen runtime wheels and one additional communication wheel are served locally:

| Component | Version | License |
|---|---|---|
| asttokens | 3.0.1 | Apache-2.0 |
| decorator | 5.2.1 | BSD-2-Clause |
| executing | 2.2.1 | MIT |
| IPython | 9.12.0 | BSD-3-Clause; included COPYING notices |
| jedi | 0.19.2 | MIT; included vendored notices |
| matplotlib-inline | 0.2.1 | BSD-3-Clause |
| micropip | 0.11.1 | MPL-2.0; vendored packaging notices |
| parso | 0.8.6 | MIT |
| prompt-toolkit | 3.0.52 | BSD-3-Clause |
| pure-eval | 0.2.3 | MIT |
| Pygments | 2.20.0 | BSD-2-Clause |
| six | 1.17.0 | MIT |
| stack-data | 0.6.3 | MIT |
| traitlets | 5.14.3 | BSD-3-Clause |
| wcwidth | 0.6.0 | MIT |
| comm | 0.2.3 | BSD-3-Clause |

Each wheel retains its embedded license, copyright and author files. Copies of those files, including vendored notices, are also included under `licenses/python/`. Micropip contains its Python source; its [versioned source tree](https://github.com/pyodide/micropip/tree/0.11.1) provides the upstream MPL-covered source. The vendored `packaging` library offers Apache-2.0/BSD licensing; both texts are retained.

The Pyodide kernel extension also contains five bootstrap/shim wheels: ipykernel 6.9.2, piplite 0.8.7, pyodide-kernel 0.8.7, and widgetsnbextension 3.6.999/4.0.999. These come from jupyterlite-pyodide-kernel 0.8.7, retain their embedded BSD notices, and are catalogued separately from the fifteen Pyodide-lock wheels.
