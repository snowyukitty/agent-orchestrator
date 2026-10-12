# UI comparison and visual restoration

The owner selected restoration of the original visual style while retaining
the new workflow features. The rejected redesign doubled several block heights,
added a taller application header, and reduced the terminal width at 1440px.

## Evidence

- [Original vs rejected redesign, 1440x900](workflow-1440.png)
- [Original vs rejected redesign, 1100x700](workflow-1100.png)
- [Rejected vs restored visuals, 1440x900](restored-vs-current-1440.png)
- [Rejected vs restored visuals, 1100x700](restored-vs-current-1100.png)
- [Original and rejected first-run screens](startup.png)
- [Restored first-run screen](restored-startup.png)
- [Measured layout data](metrics.json)

Each workflow comparison uses the same six steps, synthetic account, dark
terminal, window size, and scroll position. The startup comparison intentionally
shows each version's original first-run behavior and default terminal theme.
No workflow is executed and no production IPC or account homes are used.

| Viewport | Original | Rejected redesign | Restored visuals |
|---|---:|---:|---:|
| 1440x900: fully visible steps | 6 | 3 | 6 |
| 1100x700: fully visible steps | 5 | 3 | 5 |

The restored interface keeps the original colors, emoji block icons, compact
cards, 36px title bar, panel proportions, and bottom toolbar. It retains guided
hello setup, disabled drafts, persistent schedule pause, block search, keyboard
access, account assurance labels, and current dependency security fixes.

`npm run compare:ui` reproduces the captures from historical commits `e0cca66`
and `3873319`, plus the current working tree. `metrics.json` records actual
Chromium layout measurements. Images contain only synthetic UI state.
