# pi-status ↔ Conductor Tern plugin contract (v1)

File: `~/.local/state/conductor/tern-status/<TERN_PANE>.json` (dir 0700, file 0600).
Written atomically (tmp file + rename). One file per Tern pane running pi.

```json
{"v":1,"pane":"8589934595","session_file":"/path/session.jsonl|null","cwd":"/abs/dir",
 "state":"working|blocked|idle|done","msg":"short text","kind":"question|permission|auth|null",
 "turn":3,"updated_ms":1730000000000,"pid":12345,"instance":"a1b2c3d4e5f60718"}
```

- `state`: working = agent turn running; blocked = waiting on user (UI dialog/ask_user_question; `kind` set);
  done = turn finished with output the user hasn't seen/acted on; idle = nothing happening (kind null).
- `msg`: latest assistant status line, single line, ≤120 chars, secrets redacted. May be "".
- `turn`: integer, increments per agent run (`agent_start`, which also fires for retries/continuations), not per user turn.
- `instance` (optional): random per-process token. The producer deletes the file only if `pid` and `instance` both match its own. Consumers MUST ignore unknown/optional fields.
- `kind`: `auth` is reserved and not currently emitted (pi's built-in login/trust dialogs and `project_trust` prompts are not detected). Dialogs shown while a non-question tool runs are `permission`.
- While blocked, `msg` is `Waiting: <first line of prompt, ≤60 chars>` (redacted); otherwise the last assistant status line.
- `updated_ms`: epoch ms of last write; heartbeat rewrite every ~10s while alive.
- File deleted on clean shutdown, exit, SIGHUP and SIGTERM, only by the writer that owns it.
- Stale (producer): `now - updated_ms > 30000` AND `pid` not alive (`kill(pid,0)`; ESRCH = dead). The producer sweeps stale `*.json` and orphan `*.<pid>.tmp` files in the directory at session start.
- Stale (consumer): may treat `updated_ms` unchanged for >35s as stale without a pid check (it cannot signal-probe). A live pi whose event loop stalls >35s can therefore be hidden temporarily; the next heartbeat restores it.
- Pane ids are numeric (`^\d+$`); anything else writes nothing.
- Only a TUI session (`ctx.mode === "tui"`) writes. Print/RPC sessions, in-process subagent children and `PI_SUBAGENT_CHILD=1` processes write nothing. One owner per process (`globalThis[Symbol.for("tern-pi-status.owner")]`).
- Shared pane limitation: several pi TUIs sharing one `TERN_PANE` (tmux/screen inside a pane, pi launched from a pi shell) cannot all own the file; last writer wins and the others' `remove()` is a no-op because `instance` differs.
- Outside Tern (no `TERN_PANE`) the extension writes nothing.
