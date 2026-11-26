# PhotoCull roadmap

Where PhotoCull is heading, at a glance. It's a plan, not a promise: priorities
shift with feedback. [`BACKLOG.md`](BACKLOG.md) is the detailed working list,
and [`CHANGELOG.md`](CHANGELOG.md) records what has shipped.

Want to help with something here? See [`CONTRIBUTING.md`](CONTRIBUTING.md),
which also lists good first issues.

## Now: public beta (0.4.x)

- Beta feedback and bug fixes from real shoots.
- Hand-testing the newest features on real cards: star stacking on a RAW
  sequence, compare zoom/sync, the pop-out filmstrip, and Sort into events.
- Contributor basics: CI on pull requests, good-first-issue labels.

## Next

- **Windows x64 build** with a signed installer
  ([#4](https://github.com/ossger/PhotoCull/issues/4)).
- **Optional cloud vision scoring**: off by default. Any API key lives in the
  OS keychain, never in a file
  ([#5](https://github.com/ossger/PhotoCull/issues/5)).
- **Select and rate from the compare pane**, not just the filmstrip.
- **Pop-out filmstrip performance** on very large shoots
  ([#7](https://github.com/ossger/PhotoCull/issues/7)).
- **Update check**, so you can see when a new version is out.

## Later

- **CLIP smart scenes**: group scenes by what's in them, not only by time
  ([#6](https://github.com/ossger/PhotoCull/issues/6)).
- **Post-cull pipeline**: hand picks to Lightroom / Photoshop, then share
  edited exports to Immich, a shared album, or social
  ([#8](https://github.com/ossger/PhotoCull/issues/8)).
- **Star stacking, next**: dark-frame subtraction, a foreground-mask brush,
  local warp for long sequences and wide lenses, and star-tracker sequences.
- Google Photos / iCloud as import sources.
- Linux support.

## Principles that won't change

- **Local-first.** The core cull runs offline on your machine. Anything that
  touches the cloud is optional and opt-in.
- **Your originals are never modified.** Decisions go to XMP sidecars and a
  small per-shoot database.
- **Open source.** The app's source stays public under the MIT license.
