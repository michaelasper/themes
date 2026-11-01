# Conductor for Tern

A Tern plugin (window half only) that opens one tab with three columns: a `pi` manager session on the left, a flight-strip board in the middle, and a reader on the right. Pi sessions in every other tab are grouped by state. Clicking a strip shows its recent output; **Go to session** focuses it.

Run `Open Conductor` from the palette, or `tern ctl plugins run plugin.conductor.open`.

## Install

```sh
tern plugin link "$PWD"
```

## How state is read

- Sessions are panes whose program is `pi` (`cx.session:panes()`).
- Working is the daemon's per-pane `working` flag from `tern inspect --json`. Tern's own `cx.agents:list()` only covers omp, so it is not used.
- Review ready is a pi pane with an unseen alert that is not working.
- Idle is everything else.

## Not built yet

- A blocked or needs-you bay. Nothing in Tern's API reports a pi permission or question prompt. Candidate: a pi extension that sets paused progress (OSC 9;4) so the daemon reports it.
- Git status and diff stat in the reader, keys, voice, and Carly integration.
