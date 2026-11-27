# Coverage Inspector

A Claude Code mod that shows the health of your project's tests, and refreshes it every time the agent runs them.

It works with any language. It does not run your tests and does not change them: when the agent runs a test command, the mod reads what the runner left behind (coverage and result reports) and the end of the command's output, and draws it in a band above the Git Inspector band.

It answers at a glance: did the last run pass, how many tests failed and which one first, how much code the tests cover and whether that went up or down, whether the lines you just changed are covered, which tests are slow or flaky, and whether the figures are out of date because you edited code after the run.

## Install

Pick one way. All three give the same result: the mod is installed for your user and is active in every Claude Code session.

### 1. Inside Claude Code (easiest)

Type this one line in the Claude Code prompt. It adds the marketplace and installs the mod:

```
/plugin install coverage-inspector --marketplace lukeware-hub/coverage-inspector
```

Answer `y` if it asks to add the marketplace, then type `/reload-plugins`. The band appears above the prompt.

### 2. From a terminal

```
claude plugin marketplace add lukeware-hub/coverage-inspector
claude plugin install coverage-inspector@coverage-inspector
```

Then type `/reload-plugins` in a running Claude Code session, or just start a new one. To set the options while installing, add `--config coverageTarget=80` (see Settings).

### 3. Ask Claude Code to do it

Paste this to Claude Code, and it can install the mod by itself:

> Install the Claude Code mod "Coverage Inspector" from GitHub. Run `claude plugin marketplace add lukeware-hub/coverage-inspector`, then `claude plugin install coverage-inspector@coverage-inspector`, then `claude plugin list` and confirm that `coverage-inspector@coverage-inspector` shows `Status: enabled`. Finally tell me to type `/reload-plugins`.

For an agent reading this file: these are the only steps. The commands need no extra flags, no files to edit and no build step. The mod has no runtime dependencies, uses no network and needs Claude Code with plugin support (a version that has `claude plugin`).

### Check that it works

1. `claude plugin list` shows `coverage-inspector@coverage-inspector`, `Status: enabled`.
2. In a project, ask Claude Code to run your tests (for example `npm test`, `pytest` or `go test ./...`).
3. When the tests end, the band **Coverage Inspector** appears above the Git Inspector band with the result. Before any test run it says "no test run yet, the band reads each run the agent makes": that is normal.
4. For real coverage numbers, run the tests with coverage on (see How a run is captured).

### Update, change options, remove

```
claude plugin marketplace update coverage-inspector
claude plugin update coverage-inspector@coverage-inspector
claude plugin uninstall coverage-inspector
```

An update takes effect after a restart of Claude Code. To change the options later, type `/plugin configure coverage-inspector@coverage-inspector` in Claude Code.

### If something goes wrong

- **The band does not show:** type `/reload-plugins`, then check `claude plugin list`. The band needs a terminal at least 5 rows tall; below that it hides the frame and keeps the rows.
- **"Marketplace file not found" or "not found in marketplace":** run the `marketplace add` line first, and check you typed `lukeware-hub/coverage-inspector` exactly.
- **The band says "no coverage report":** your test run did not write a report. Turn coverage on in your runner (`--coverage`, `--cov`, `-coverprofile`).
- **Nothing happens after a test run:** the command may not be on the built-in list. Add it in the `testCommands` option, for example `make verify`.
- **The band appears twice or a row repeats:** you have the mod loaded from two places. Keep one, then `/reload-plugins`.
- **To try it from a local copy without installing:** `claude --plugin-dir .` inside the repository folder.

## What it adds

- **A band above the prompt**, drawn like the Session Inspector and Git Inspector bands and stacked right above Git Inspector. In the terminal it is one bordered table; on the desktop, rows of cards. When the band is too short, `Trend`, `Slow`, `Flaky` and `Command` leave first.

  An illustration of the layout (column widths adapt to the terminal):

  ```
  ╭────────────────────────────────────────────────────────────────────────────────╮
  │ Coverage Inspector                                    vitest   ● failed 14:02 │
  │          ╭─────────────────────┬──────────────────────┬──────────────────────╮ │
  │ Run      │ runner vitest       │ took 12 s            │ scope full           │ │
  │          ├─────────────────────┴──────────────────────┴──────────────────────┤ │
  │ Command  │ npx vitest run --coverage                                         │ │
  │          ├──────────────┬───────────────┬─────────────────┬──────────────────┤ │
  │ Tests    │ total 148    │ passed 146    │ failed 2        │ skipped 0        │ │
  │          ├──────────────┴─┬─────────────┴───┬─────────────┴──────────────────┤ │
  │ Coverage │ lines 87.4% ▲1.2 │ branches 71%  │ functions 90.2%                │ │
  │          ├────────────────┴─┬───────────────┴────┬───────────────────────────┤ │
  │ Patch    │ changed lines 18/24 75% │ uncovered 6 │ worst src/auth.ts (4)       │ │
  │          ├──────────────────┴─────┴──────────────┴───────────────────────────┤ │
  │ Failing  │ auth > rejects an expired token  src/auth.test.ts:42  +1 more     │ │
  │          ├───────────────────────────────────────────────────────────────────┤ │
  │ Next     │ fix 2 failing tests, then cover 6 changed lines in src/auth.ts    │ │
  │          ╰───────────────────────────────────────────────────────────────────╯ │
  ╰────────────────────────────────────────────────────────────────────────────────╯
  ```

- **The `/coverage` command** reads the newest reports on disk now and refreshes the band, for tests you ran yourself outside the session.
- **The `coverage_status` tool** gives the agent the same data as JSON, so you can ask Claude "how healthy are the tests?" and it reads it itself.

## How a run is captured

1. The agent runs a command through the Bash or PowerShell tool. The mod watches the conversation rows (the tool_use row, then the tool_result row), so it never sits in front of the tool: Bash keeps its live output and its background mode.
2. The mod looks under the repository for report files written during the run and reads them:

   | Kind | Files | Written by |
   | --- | --- | --- |
   | LCOV | `lcov.info`, `*.lcov` | c8, nyc, vitest, jest, Dart, Rust llvm-cov, gcov, lcov |
   | Cobertura | `cobertura*.xml`, `coverage*.xml` | coverage.py, pytest-cov, coverlet (.NET), many CI tools |
   | JaCoCo | `jacoco*.xml` | Maven and Gradle (Java, Kotlin, Scala) |
   | Istanbul | `coverage-final.json`, `coverage-summary.json` | nyc, c8, vitest, jest |
   | coverage.py | `coverage.json` | `coverage json` |
   | Go | `cover.out`, `coverage.out`, `coverage.txt` | `go test -coverprofile` |
   | JUnit XML | `junit*.xml`, `TEST-*.xml`, `results.xml` | pytest, jest-junit, vitest, surefire, Gradle, go-junit-report, rspec, phpunit |
   | TRX | `*.trx` | `dotnet test --logger trx` |

3. With no result report, the totals line the runner printed (Jest, Vitest, pytest, `cargo test`, `dotnet test`, `go test`, RSpec, Maven) gives the counts. With nothing to read, the band says so and shows no number it cannot back up.

Test commands it knows: npm, pnpm, yarn and bun scripts named `test` or `coverage`, vitest, jest, mocha, playwright, cypress, deno, pytest, tox, nox, `coverage run`, go, dotnet, Maven, Gradle, cargo (test, nextest, llvm-cov, tarpaulin), rspec, rails, phpunit, pest, flutter, dart, ctest, swift, mix, sbt, and `make test`. Add your own in the settings (see below).

## What each row means

- **Run**: the runner, how long it took, and the scope. `full` means the whole project; `partial` means a file, a folder or a name filter (a guess from the command, shown in the warning color). A partial run never becomes the baseline for the coverage change.
- **Command**: the command that ran, cut in the middle when long.
- **Tests**: total, passed, failed and skipped. Skipped tests are shown because a growing skipped count hides risk.
- **Coverage**: lines, branches and functions as percentages, and `▲`/`▼` the change since the last full run. With a target set, lines turn to the warning color below it.
- **Patch**: how many of the lines you changed since the last commit (`git diff -U0 HEAD`) the tests ran, how many did not, and the file with the most uncovered ones. Only lines a report knows count; a changed file no report mentions (a doc, a test, a file the runner skips) is left out, not counted as uncovered.
- **Failing**: the first failing test, with its file and line when the report has them, and how many more.
- **Slow**: the slowest test and its time (warning from 5 s).
- **Flaky**: tests that changed between passing and failing at least twice in their last ten results.
- **Trend**: the last runs as bars, for coverage and for the pass rate.
- **Stale**: files that changed after the last run finished, so the figures may no longer describe the code.
- **Next**: what to do, in order: fix failing tests, cover changed lines, reach the target, run again.
- **Note** or **Error**: what went wrong while reading, in plain words.

## Settings

| Option | Meaning |
| --- | --- |
| `testCommands` | Comma-separated regular expressions for test commands the built-in list does not know, such as `^\./ci\.sh, make verify`. Matched against each part of a compound command. |
| `coverageTarget` | The line coverage the project should reach, in percent. `0` turns the target off. |

## Limits

- It sees commands the agent runs through Bash or PowerShell, not tests you run in another terminal. Use `/coverage` after those.
- Coverage needs a report on disk: turn coverage on in your runner (`--coverage`, `--cov`, `-coverprofile`, JaCoCo, coverlet) and let it write one of the formats above.
- A command that starts tests in the background is looked for until its reports appear, for up to ten minutes.
- It looks at most seven folders deep, skips `node_modules`, `.git`, `vendor`, virtual environments and build caches, and reads at most the 40 newest reports of a run.
- Per-test history (for flaky tests) keeps the last ten results of at most 300 tests that ever failed.

## Development

```
claude plugin validate .
claude plugin test .
```

`tsc -p .` type-checks the mod once Claude Code has loaded it and written its types to `.claude-plugin/types/`.

## License

MIT
