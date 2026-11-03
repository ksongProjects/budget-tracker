# Branches

`dev` is the integration branch and the last stop before `main`.

1. Work happens on a feature branch cut from `dev`.
2. Feature branches merge into `dev`, never straight into `main`.
3. On `dev`, everything has to be green before it moves on:
   - CI: typecheck, lint, the node, browser and mobile screen suites above
     their coverage floors, the web build, and the bundle budget. CI runs on
     every push to `dev`.
   - For a release: the end-to-end flows on the emulator against a release
     build of the `dev` head. See
     [running-locally.md](docs/running-locally.md#end-to-end-flows).
4. Then open one pull request from `dev` into `main`, with the details: what
   changed, what was tested and how, what is known and left undone.
5. Release builds are made from `main` after that merge, following
   [docs/release/checklist.md](docs/release/checklist.md).
