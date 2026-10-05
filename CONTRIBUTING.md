# Contributing to PhotoCull

Thanks for helping. Bug reports, feature ideas, and pull requests are all
welcome.

## Before you start

- Check [`BACKLOG.md`](BACKLOG.md) and the open issues — the idea may already be
  planned. For anything bigger than a small fix, open an issue first so we can
  agree on the approach.
- Setup: see "Dev setup" in [`README.md`](README.md) (or [`QUICKSTART.md`](QUICKSTART.md)
  for the long version). `CLAUDE.md` describes the architecture in depth.

## Ground rules

- **Local-first.** Core culling must work offline. Any cloud feature is optional
  and opt-in.
- **Keep the cross-process contract in sync.** A new worker capability changes
  the FastAPI route, the IPC handler in `src/main`, the allow-listed method in
  `src/preload/preload.ts`, and `src/shared/types.ts` together.
- **Cross-platform.** Don't break Windows or macOS paths or the packaged worker.
- **Never commit photos**, personal library paths, or keys.

## Checks before a PR

```bash
npm run build                      # type-check + bundle
cd apps/worker && pytest           # worker tests
cd apps/worker && ruff check       # worker lint
```

Add a line under "Unreleased" in `CHANGELOG.md` for user-visible changes.

By contributing you agree your work is released under the [MIT License](LICENSE).
