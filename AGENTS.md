# Working on wobbree

wobbree is a very light set of ideas for building games with Three.js: the few pieces every game needs (owners,
entities, lists, scenes and a stage) and light rules for performance and for shaping abstractions, without prescribing
how a game works. Its value is being small, fast and easy to read; every change protects all three.

- The library is one file, `src/index.ts`, short enough to read in one sitting. A piece belongs in it only when every
  Three.js game needs it; what one game chooses, such as its camera, its layout or its look, stays in that game, as the
  README's patterns show.
- Three.js is a type import only, so the library never loads a second copy of Three.js into an app.
- Nothing that runs every frame or on every update, such as the stage's frame and `List.update`, creates objects.
- Every behavior has a test that calls the public API and checks what a user can observe (`test/`, Node's test runner,
  real Three.js objects, and a stand-in renderer where Node has no WebGL).
- A change to `Owner` or `List` internals runs `npm run bench` before and after; refresh the README's numbers when they
  move.
- The README is the documentation. Change it with the API.
- `npm run check` (types, Oxlint, tests, build) passes before every commit.

Releasing: set the version in `package.json`, push, then publish a GitHub release for it. `.github/workflows/publish.yml`
runs the checks and publishes the version to npm through trusted publishing, with provenance.
