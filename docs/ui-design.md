# Compact, modular workspace

The accepted direction is a high-information-density workspace where the
workflow, block library, and terminal remain useful together. The owner
confirmed this direction after comparing the original, spacious redesign,
and restored interface. See the [measured comparison](ui-comparison/README.md).

## Design priorities

- Make more of the workflow understandable at a glance. Use alignment,
  typography, grouping, and restrained color before adding padding.
- Treat each block as an editable module: type, parameters, state, and actions
  stay together, with consistent ordering across block types.
- Keep the terminal large enough to read agent output. Resizable panels are
  working tools; preserve their proportions and persisted settings.
- Keep frequent actions accessible in the compact toolbar. Secondary setup
  belongs in focused dialogs or contextual controls.
- Distinguish draft, enabled, paused, running, failed, and completed states
  with words as well as color. A quiet terminal is not proof of success.
- Preserve readable labels, visible focus, keyboard access, and usable pointer
  targets. Density must not depend on shrinking text or hiding essential labels.
- Keep onboarding brief and actionable. A first-run choice must not start a
  provider session or enable a schedule before the user acts explicitly.

## Review a visual change

Use the same six-step hello workflow, synthetic account, terminal theme,
viewport, and scroll position on both sides. The accepted reference exposes
six complete steps at 1440x900 and five at 1100x700. These are regression
baselines for that fixture, not quotas for every possible block combination.

Check narrow windows, long labels, validation messages, the draft banner,
keyboard focus, and the hibernate banner. Run/Stop and schedule state must
remain reachable. The UI suite enforces six visible hello steps at 1440x900
and checks shell/toolbar fit down to 760x600.

Record both the visual benefit and its effect on working space. A new feature
may need more room; show the tradeoff explicitly rather than silently changing
the entire application's density.

## Next integration milestone

Bring the compact treatment into the latest run-history and session-scheduling
surfaces while preserving their behavior. Begin with side-by-side evidence on
those screens, then adapt individual modules. Do not replace their functional
implementation with files from this older UI branch.
