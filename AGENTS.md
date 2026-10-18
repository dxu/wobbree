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

## Changes go through pull requests

Every change reaches `main` through a pull request the user has read and approved.

1. **Branch** from `origin/main`. If another session is working in this folder, make your branch in a git worktree of
   your own.
2. **Push as you go and open a draft** with `gh pr create --draft`, so the user can follow the work. The repository is
   public, so check each push for anything specific to one game.
3. **Ask for review** when the change works: `npm run check` passes here and in CI, and a fresh reviewer has gone over
   the diff and you have fixed what it found. Then mark the pull request ready with `gh pr ready` and send the user its
   link. Write its description for the user: what changed and why, how it works, what you checked, and what they need
   to decide.
4. **Catch up by rebasing.** When `main` moves on, run `git fetch origin` and `git rebase origin/main`, then push with
   `git push --force-with-lease --force-if-includes`. If that push is refused because the branch on GitHub has a
   commit yours doesn't include, stop and tell the user. Never merge `main` into a branch, and never force-push `main`.
5. **Merge only when the user says so.** If `main` has moved, catch up and rerun `npm run check` first. Then run
   `gh pr merge --squash --match-head-commit "$(git rev-parse HEAD)"`, so GitHub lands exactly what you checked on
   `main`, as one commit.

## Releasing

Publish only when the user says so; saying publish also approves merging the version change. Set the version with
`npm version <version> --no-git-tag-version` in a pull request, the one being published or one of its own. Once it has
merged, publish a GitHub release for the merge commit with `gh release create v<version> --target <commit>`.
`.github/workflows/publish.yml` runs the checks and publishes the version to npm through trusted publishing, with
provenance.
