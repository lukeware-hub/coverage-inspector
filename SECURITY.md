# Security

## What the mod does

Coverage Inspector reads the test reports a test run leaves in the project and a few facts from git. It never changes a project file, a branch, a commit or the working tree, never runs your tests, and never blocks or changes any tool call: it listens to a command after the command ended.

## What it keeps

- In memory, for the band: the last run and its figures.
- On disk, in the mod's own store under Claude Code's configuration folder, per project root: for the last 20 runs only the time, line coverage, pass rate and scope; the last run's summary (runner, the command line, durations, counts, failing test names with file and line, coverage percentages); and the last ten outcomes of tests that ever failed.
- It never stores a command's output, its environment, file contents or report contents. A command line is stored as typed, so do not put a secret in a test command's arguments.

## What it reads and runs

| What | Why | When |
| --- | --- | --- |
| Directory listings and report files under the repository (the names listed in the README, up to 40 files, up to 4 MiB each) | Coverage and test results. | After a shell command that is a test run, on `/coverage`, and while a background test run is awaited. |
| `git diff -U0 HEAD` | Coverage of the changed lines. | After a test run that produced coverage. |
| `git status --porcelain` and the modification time of the files it lists | Tells whether code changed after the last run. | Every 15 seconds while a run is shown, after each answer, and when the tool runs. |

Git runs with `GIT_OPTIONAL_LOCKS=0` (no `index.lock`), `GIT_TERMINAL_PROMPT=0` and `LC_ALL=C`, with no shell, and stops after 20 seconds. The mod uses no network.

User patterns from the `testCommands` setting are compiled as regular expressions and only matched against command text; they are never executed.

## Reporting a vulnerability

Please report a vulnerability privately through the repository's GitHub security advisories ("Report a vulnerability" on the Security tab), not in a public issue.
