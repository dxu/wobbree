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

1. **Branch** from `origin/main`, in a git worktree of your own if another session is working in this folder.
2. **Push as you go and open a draft:** push first with `git push -u origin HEAD`, then run `gh pr create --draft`, so
   the user can follow the work. The repository is public, so check each push and the pull request's text for anything
   specific to one game.
3. **Ask for review** when the change works and CI passes on the pull request. Have a fresh reviewer go over the diff
   and fix what it finds, then mark the pull request ready with `gh pr ready` and send the user its link. Write its
   description for the user: what changed and why, how it works, what you checked, and what they need to decide.
4. **Answer the review.** Reply to each of the user's comments on GitHub, and push the fixes as new commits.
5. **Catch up by rebasing** when `main` has moved on, before asking for review and before merging: run
   `git fetch origin` and `git rebase origin/main`, rerun `npm run check`, then push with
   `git push --force-with-lease --force-if-includes`. If the rebase needed conflict fixes, show the user the result. If
   the push is refused because the branch on GitHub has a commit yours doesn't include, stop and tell the user; never
   use a plain `--force`. Never merge `main` into a branch, and never force-push `main`.
6. **Merge only when the user says so in chat,** with
   `gh pr merge --squash --match-head-commit "$(git rev-parse HEAD)"`, so GitHub lands exactly what you checked on
   `main`, as one commit.

## Releasing

Publish only when the user says so; saying publish also approves merging the version change. Set the version with
`npm version <version> --no-git-tag-version` and commit `package.json` and `package-lock.json`, in the pull request
being published or in one of its own, which needs no fresh reviewer. Once it has merged, find the commit it landed as
(`gh pr view <number> --json mergeCommit --jq .mergeCommit.oid`), check that its `package.json` has the new version,
and publish a GitHub release for it: `gh release create v<version> --target <commit> --generate-notes`.
`.github/workflows/publish.yml` then runs the checks and publishes that version to npm through trusted publishing,
with provenance.
