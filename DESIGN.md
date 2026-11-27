# Design

The Coverage band is an Operate surface drawn in a terminal: the person is in a task and glances down to know whether the tests pass, whether the code they just wrote is covered, and what to do next. It looks like the Git Inspector and Session Inspector bands: one framed panel, a fixed label column, a dim label before every figure, and color reserved for meaning. `hooks/grid.tsx` is the same layout code as Git Inspector's, so the three bands line up.

## Medium

- Claude Code's own elements only (`Box`, `Text`); colors are theme keys, so the band follows the dark or light theme.

## Shape

- **Place**: one row of the band above the prompt, moved right above the Git Inspector row; above the Session Inspector row when Git Inspector is off. Both mods reorder `AbovePromptList`, so the order is computed to come out the same whichever hook runs first.
- **The frame** is one rounded border (`borderStyle: round`, dim). Its first row holds "Coverage Inspector" in bold brand color on the left, and on the right the runner (bold) and the run mark (`● passed 14:02` green, `● failed 14:02` red, `○ reading`, `○ waiting`). Under five rows of room the frame and title are dropped and the rows stay.
- **Layout** follows Git Inspector: one bordered table in the terminal when the band has the height for it (`3 + 2 × rows + 1`), else one line per row; rows of cards on the desktop. When the height is short, `Trend`, `Slow`, `Flaky` then `Command` leave first; the table is kept as long as every other row fits.
- **Rows** start with a dim label in a 9-column label column: `Run`, `Command`, `Tests`, `Coverage`, `Patch`, `Failing`, `Slow`, `Flaky`, `Trend`, `Stale`, `Next`, then `Note` or `Error`. Rows with nothing to say (`Patch` without a diff, `Failing` with no failure, `Flaky`, `Slow`, `Trend` with under two runs, `Stale` when fresh) are not drawn, so a green project is a short band.
- **Figures** carry their own dim label before the value. Columns share one width in every row; whole columns leave from the right when the band is narrow.
- **Messages** (the command, the first failing test, the next step, a failure) span their row and never sit in a column.
- **Glyphs**: `●` a finished run, `○` waiting or reading, `▲` `▼` the change in line coverage since the last full run, `▁▂▃▄▅▆▇█` the trend.

## Color roles

| Role | Theme key | Used for |
| --- | --- | --- |
| Brand mark | `claude` | The title only. |
| Good | `success` | `● passed`, all tests passed, coverage at or above the target, a rise, "nothing to do". |
| Watch | `warning` | A `partial` scope, skipped tests, coverage under the target, uncovered changed lines, a slow test, a flaky test, stale figures, a missing coverage report. |
| Danger | `error` | `● failed`, failed tests and the first failing test, a fall in coverage, a read error. |
| Secondary | dim | Labels, the command, zero counts, missing figures, notes. |
| Body | default | Every other value; the lines coverage is bold because it is the main fact. |

## Copy

- Sentence case and plain words a person new to testing reads at once: "changed lines", "uncovered", "failing", "stale".
- Never a number the band cannot back up: no report means "no coverage report: run the tests with coverage on", not 0%.
- No em dash.
