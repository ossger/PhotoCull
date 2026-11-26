## What and why

<!-- What does this change, and why? Link the issue: "Closes #123". -->

## How it was tested

<!-- Steps you ran. Screenshots or a short clip for UI changes (sample or synthetic shoots only, not personal photos). -->

## Checklist

- [ ] `npm run build` and `npm --workspace apps/shell run lint` pass
- [ ] `pytest` and `ruff check` pass in `apps/worker` (if the worker changed)
- [ ] A new worker capability updates all four layers: FastAPI route, main IPC handler, `preload.ts` allow-list, `shared/types.ts` (+ `models.py`)
- [ ] `CHANGELOG.md` "Unreleased" has a line for any user-visible change
- [ ] No photos, personal paths, or keys committed

By submitting this PR I agree my contribution is released under the project's MIT License.
