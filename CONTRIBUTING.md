# Contributing to PhotoCull

Thanks for helping. Bug reports, feature ideas, docs fixes, and pull requests
are all welcome, and you don't need to be a photographer or an ML person to
make a useful one.

- **Found a bug?** [Open a bug report](https://github.com/ossger/PhotoCull/issues/new/choose).
- **Have an idea?** Check [`ROADMAP.md`](ROADMAP.md) and the
  [open issues](https://github.com/ossger/PhotoCull/issues) first, then open a
  feature request.
- **Want to write code?** Pick something from [Good first issues](#good-first-issues)
  below, or comment on an issue to say you're taking it.
- **Security problem?** Report it privately; see [`SECURITY.md`](SECURITY.md).

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

For anything bigger than a small fix, **open an issue (or comment on one)
first** so we can agree on the approach before you spend time on it.

## Dev setup

Follow "Dev setup" in [`README.md`](README.md). In short: Node 20+, Python
3.11+, a `.venv` at the repo root, `npm run worker:install`, `npm run doctor`,
then `npm run dev`. On macOS, also `brew install exiftool`.

For tests and lint, install the worker's dev extra too:

```bash
pip install -e "apps/worker[raw,ml,dev]"
```

[`CLAUDE.md`](CLAUDE.md) describes the architecture in depth: the Electron
shell, the Python worker sidecar, and how they talk.

## How the code is laid out

```
apps/shell/    Electron + React + TypeScript
  src/main/       main process: windows, IPC handlers, spawns the worker
  src/preload/    the allow-listed window.photocull bridge
  src/renderer/   React UI (components/, store.ts, useHotkeys.ts, …)
  src/shared/     types shared across processes
apps/worker/   Python package `photocull` (FastAPI)
  photocull/      raw.py, ingest.py, scenes.py, scoring/, astro/, export/xmp.py, …
  tests/          pytest suite
packaging/     per-OS build scripts (see packaging/README.md)
```

## Ground rules

- **Local-first.** Core culling must work offline. Any cloud feature is
  optional, off by default, and never a hard dependency.
- **Keep the cross-process contract in sync.** A new worker capability changes
  four places together: the FastAPI route in the worker, the IPC handler in
  `src/main`, the allow-listed method in `src/preload/preload.ts`, and
  `src/shared/types.ts` (mirrored by the worker's `models.py`).
- **The renderer only talks to `window.photocull`** and the worker's `/files`
  URLs, nothing else.
- **Cross-platform.** macOS builds ship today and a Windows build is planned.
  Don't break either one's paths or the packaged worker (`sidecar.ts`).
- **Heavy work belongs in the worker** (decode, scoring, ML), not the renderer.
- **Never commit photos**, personal library paths, API keys, or anything from
  `_RawIngest/` or `PhotoLibrary/`. Test fixtures are generated in code (see
  `apps/worker/tests/`), not real photos.

## Checks before a PR

```bash
npm run build                          # type-check + bundle
npm --workspace apps/shell run lint    # eslint, zero-warnings gate
cd apps/worker && pytest               # worker tests
cd apps/worker && ruff check           # worker lint
```

- Add or update tests for worker changes.
- Add a line under "Unreleased" in [`CHANGELOG.md`](CHANGELOG.md) for anything
  a user would notice.
- Keep PRs focused: one change per PR is easier to review and to revert.
- UI changes: a screenshot or short clip in the PR helps a lot. Use a sample
  or synthetic shoot, not your personal photos.

## Good first issues

These are drawn from [`BACKLOG.md`](BACKLOG.md) and sized for a first PR. Each
one is self-contained. Comment on the matching issue (or open one) before
starting, so two people don't build the same thing.

1. **Add CI.** There's no GitHub Actions workflow yet. Add one that runs on
   pull requests: `npm ci`, `npm run build`, the shell lint, and the worker
   `pytest` and `ruff check` (Python 3.11 and 3.12, macOS and Ubuntu). The
   worker tests generate their own fixtures, so they shouldn't need real
   photos. *Files:* `.github/workflows/ci.yml`. *Skills:* GitHub Actions.
2. **Select and rate from the compare pane.** With four frames up in compare,
   clicking a frame in the big compare area should select it (⌘/Ctrl-click and
   Shift-click for multi-select), and pick/reject/stars/colour should then
   apply to that selection. Example: four picks in compare, unpick three of
   them without going back to the filmstrip. *Files:*
   `renderer/components/CompareView.tsx`, `renderer/store.ts`,
   `renderer/useHotkeys.ts`. *Skills:* React, TypeScript.
3. **Measure the pop-out filmstrip on a large shoot**
   ([#7](https://github.com/ossger/PhotoCull/issues/7)). Generate a synthetic
   10,000-frame shoot, time a rating change with the filmstrip popped out, and
   report the numbers. `renderer/filmstripSync.ts` already sends diffs for some
   changes, so the work is to confirm whether the image list is re-sent and
   trim it if so. *Skills:* TypeScript, profiling.
4. **Star stacking: dark-frame subtraction.** Accept optional dark frames
   (lens cap on, same exposure), average them, and subtract the result from
   each light frame before alignment. Worker only, with a pytest using the
   synthetic fixtures in `tests/astro_fixtures.py`. *Files:*
   `photocull/astro/stack.py`, `tests/test_astro_stack.py`. *Skills:* Python,
   NumPy.
5. **Docs: a "your first cull" walkthrough.** A short illustrated guide in
   `docs/` covering open a shoot → scenes → compare → pick → export XMP → open
   in Lightroom, using synthetic or freely licensed sample images. *Skills:*
   writing, screenshots.
6. **Run it on Linux.** Nobody has tried PhotoCull on Linux yet. Get
   `npm run dev` working on a recent Ubuntu or Fedora, fix any path
   assumptions you hit, and document the steps. (Packaging a Linux build is a
   separate, later step.) *Skills:* Linux, Node, Python.

Bigger items that need a design conversation first: Windows build
([#4](https://github.com/ossger/PhotoCull/issues/4)), optional cloud vision
scoring ([#5](https://github.com/ossger/PhotoCull/issues/5)), CLIP smart scenes
([#6](https://github.com/ossger/PhotoCull/issues/6)), post-cull pipeline
([#8](https://github.com/ossger/PhotoCull/issues/8)).

## Licensing of contributions

PhotoCull is released under the [MIT License](LICENSE). By submitting a
contribution you agree it is released under that same license ("inbound =
outbound"), and that you have the right to submit it. There's no CLA to sign.
