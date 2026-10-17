# Working on wobbree

wobbree is a minimal library for managing Three.js objects. Its value is being small, fast and easy to read; every
change protects all three.

- The library is one file, `src/index.ts`, short enough to read in one sitting. What can live in user code, as the
  README's patterns show, stays out of the library.
- Three.js is a type import only, so the library never loads a second copy of Three.js into an app.
- Nothing that runs on every update, such as `List.update`, creates objects.
- Every behavior has a test that calls the public API and checks what a user can observe (`test/`, Node's test runner,
  real Three.js objects).
- A change to `Owner` or `List` internals runs `npm run bench` before and after; refresh the README's numbers when they
  move.
- The README is the documentation. Change it with the API.
- `npm run check` (types, Oxlint, tests, build) passes before every commit.

Releasing: set the version in `package.json`, push, then publish a GitHub release for it. `.github/workflows/publish.yml`
runs the checks and publishes the version to npm through trusted publishing, with provenance.
