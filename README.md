# pi-pulse

Streaming telemetry for a [pi](https://pi.dev) session: a calibrated tokens-per-
second estimate, the session's phase and pi's context usage, written to a
heartbeat file and published on the extension bus.

The session log only gains an entry when a response completes, so it cannot
answer "is this streaming, and how fast" — a long tool run looks like a dead
session. Pulse answers that while the session is live.

## Install

```sh
pi install git:github.com/db112358/pi-pulse
```

For one run instead of settings:

```sh
pi -e git:github.com/db112358/pi-pulse
```

Or clone the repo and link `extensions/pulse.ts` into `~/.pi/agent/extensions/`.
pi supplies `@earendil-works/*` to extensions, so there is nothing to install.

## The heartbeat

`$PI_CODING_AGENT_DIR/live/<session id>.json`, by default
`~/.pi/agent/live/<session id>.json`, rewritten at most every 250 ms while
streaming and refreshed every two seconds otherwise, and removed on shutdown:

```json
{
  "sessionId": "01a1e680-aee7-7dac-817d-c304ca7e519d",
  "pid": 4711,
  "cwd": "/Users/me/src/parser",
  "sessionFile": "~/.goji/pi-sessions/2026-11-17T10-00-00-000Z_01a1e680.jsonl",
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "thinkingLevel": "high",
  "phase": "streaming",
  "phaseMs": 812,
  "tool": "bash",
  "tps": 43.1,
  "tpsLast": 41.0,
  "streamTokens": 212,
  "streamMs": 4900,
  "startedAt": 0,
  "updatedAt": 0,
  "ctx": { "tokens": 51230, "window": 1000000, "percent": 5.1 },
  "andon": { "light": "green", "word": "working", "objective": "porting the parser" }
}
```

The file is written to a temporary name and renamed, so a reader never sees a
half-written heartbeat. A reader is expected to ignore stale `updatedAt` and
dead `pid`s. `phase` is one of `idle`, `prefill`, `streaming`, `waiting`, `tool`
or `prompt`, and `phaseMs` says how long it has held.

## The bus

After each write, `pulse:tps` goes out on the extension bus:

```json
{ "sessionId": "...", "tps": 43.1, "phase": "streaming", "ctx": { "tokens": 51230, "window": 1000000, "percent": 5.1 }, "at": 0 }
```

On a pi build that carries the `pi.rpc.expose` bridge, the channel is forwarded
over RPC as a `custom_event` and any RPC client can read it — that is what puts
`~N tok/s` and `P% ctx` in a headless client's status bar. On a stock pi
`pi.rpc` is absent, the channel stays on the in-process bus, and nothing breaks.

`andon` relays the `andon:state` broadcast when
[pi-andon](https://github.com/db112358/pi-andon) is loaded, so an observer sees
the lamp without reading the session log.

## The rate

`tps` is a rolling estimate over the last three seconds of streamed text.
`tokensPerChar` starts at 0.25 and is recalibrated from each finished response
(`usage.output / characters streamed`, weight 0.3), resetting on a model switch.
It is a feel for the stream, not billing math; `tpsLast` keeps the last finished
response's rate so an idle card has a stable number to show.

## Requirements

pi 1.5.2 or newer. The heartbeat and the bus need no fork; RPC delivery needs
one with the `pi.rpc.expose` bridge.

## Licence

MIT.
