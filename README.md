# agent-collective

Cross-instance peer awareness and steering for [omp](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
**and [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**.

This fork of [andreiverdes/agent-collective](https://github.com/andreiverdes/agent-collective)
uses **explicit, session-scoped membership**. Run `/collective` in each terminal
you want to connect. Joined instances announce themselves, see one another by **callsign**, and
can exchange prompts through a shared registry under the same user's home directory.

**On omp** it needs no new tool — peers are bridged into the same registry the built-in `hub` tool
resolves names against:

```
hub op=list                      → other terminals listed next to your local subagents
hub op=send to="007" ...         → a real prompt injected into that terminal's agent
hub op=send to="007" await=true  → resolves in-band with the reply
```

**On pi** there is no IRC bus, no agent registry and no `hub` tool, and the package exports only
`.` and `./rpc-entry`, so there is nothing to bridge. Two tools are registered instead:

```
peers                            → list live instances by callsign
peer_send to="007" message="…"   → prompt that instance; its reply arrives as a peer message
```

The host is probed once at load, so one file serves both.

## Install

Clone this fork, then link it into omp:

```sh
git clone https://github.com/GarrettFaucher/agent-collective.git "$HOME/git/agent-collective"
omp plugin link "$HOME/git/agent-collective"
```

Restart existing omp instances to load the extension. New sessions start disconnected.
The installed link points at this checkout; keep it in place. Do not install the upstream npm
or marketplace package alongside it: those versions automatically join.

To remove the link:

```sh
omp plugin uninstall agent-collective
```

Install it **one way only**. Two copies loaded in one process (for example an npm install plus a
loose `~/.omp/agent/extensions/collective.ts`) means two collective nodes per instance: two records,
two sockets, and peer refs claimed twice.

## Use

| Input                          | Effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `/rename 007`                  | Renames the session; the collective adopts `007` as the callsign          |
| `/callsign 007`                | Sets the callsign after joining, leaving the session title alone          |
| `/collective`                  | Joins if disconnected, then lists joined peers; repeat calls do not toggle |
| `/collective status`           | Reports membership and, when joined, peers; never joins                  |
| `/collective leave`            | Disconnects and removes local presence and imported peer references       |
| `hub op=list` / `op=send`      | omp: peers as addressable agents; `await=true` waits for the reply        |
| `peers` / `peer_send`          | pi: the same two operations as tools                                      |

Startup, shutdown, and session changes (new/resumed/switched/branched/tree navigation) reset
membership to disconnected. Membership is not persisted. While disconnected there is no
listener, heartbeat, peer registration, roster injection, or collective footer chip.
Neither `/callsign` nor model calls enroll a session. Unknown command arguments do not join.

Leaving cancels queued incoming batches and closes existing sockets. Messages already delivered
to the host cannot be retracted; leaving does not abort an agent turn already underway.
Other terminals remove your stale roster entry on their next heartbeat (normally within 1.2 s).

The footer carries a roster chip — `⇄ 007 goose-3182* +2` — where `*` marks a working peer,
working peers and peers sharing your cwd sort first, and the rest collapse into `+N`.

While joined, each model call carries a short roster block naming your own callsign, each peer's
harness, and how to reach them, provided another peer is present.

### Callsigns

Resolution order: `/callsign` override → the session name, when it is safe to adopt →
`<project>-<pid>`.

"Safe to adopt" means the host reports the title as user-set (`/rename`, RPC). A callsign is an
address, and an auto-generated title is a model-written sentence that `title.refreshOnReplan`
rewrites mid-session — adopting it would rename an instance and break every peer's addressing. pi
exposes no title source, so there a session name is adopted only when it already looks like an
address: one token, no whitespace, within the length cap.

Name collisions deconflict by start time: the older instance keeps the bare name, the younger gets a
`-<pid>` suffix.

## How it works

- Each joined process writes `~/.agent-collective/<pid>.json` (0600, 1.2 s heartbeat) and listens on
  `<pid>.sock` beside it. Liveness is `process.kill(pid, 0)` plus a stale-beat reap, matching omp's
  own presence conventions. Records and sockets are unlinked on leave or session change. The directory is
  deliberately not derived from any env var — two terminals with different environments must never
  end up in two separate collectives.
- The host is probed once during module evaluation (top-level await), because tool registration is
  load-time only:
  - **omp** — `registry/agent-registry` and `tools/hub/messaging` resolve, so each peer becomes a
    registry ref whose session is a stub forwarding `deliverIrcMessage` over that peer's socket.
    `hub` resolves names against exactly that registry, so peers are addressable with no change to
    the tool. Inbound goes through the host's own `hub` send path, so a peer's `await=true` is
    satisfied by the bus waiter instead of timing out.
  - **pi** — neither module exists, so `peers` / `peer_send` are registered and inbound arrives via
    `sendUserMessage`.
- The roster is injected on the `context` event (before every model call, on a clone that never
  reaches the transcript), appended to the last user message so provider role alternation and the
  cached prompt prefix stay intact.

## Limits

- **Same machine only.** Unix sockets, one shared directory. For remote pairing use omp's `/collab`.
- **Opt-in is not a privacy boundary after joining.** Keep private/local-only sessions disconnected:
  joining allows communication with cloud-backed peers. There are no project allowlists.
- **Depends on omp internals for bridge mode.** It imports
  `@oh-my-pi/pi-coding-agent/registry/agent-registry` and `/tools/hub/messaging` — real host
  singletons, but not a stable extension API. If an omp upgrade removes them from the bundled export
  map, the probe fails and the extension silently degrades to tool mode on omp too.
- **`hub op=send to="all"` leaves the process** on omp — broadcast reaches other terminals.
- **Mid-turn delivery differs.** omp injects an aside that does not interrupt a running tool batch.
  pi has no aside, so a message arriving mid-turn steers and does interrupt.
- **Agent Hub (`Alt+A`) lists collective peers** as `sub` rows on omp. Their session is a forwarding
  stub, so read and steer them via `hub` or `/collective` rather than focusing the row.
- A callsign equal to a local agent id (a subagent name, or `Main`) is skipped with a warning rather
  than shadowing the local peer.
- **Chains stop at 4 hops.** Every message carries its distance from the human prompt that started
  the chain; past the limit, delivery is refused with an explicit error telling the sender the chain
  ends there, and a local warning is shown. A human prompt resets the count. This exists because
  mutual wake is a *behavioural* loop — A wakes B, B's turn wakes A — where each delivery is a
  legitimate single hop, so no transport-level guard trips. Raise or lower `MAX_HOPS` in `index.ts`
  if 4 is wrong for you.
- **Bursts become one wake.** Messages from one peer arriving within 400 ms are delivered as a single
  numbered batch, so N messages cost one turn rather than N.
- Roster injection costs roughly one line per peer per model call; with no peers nothing is injected
  and no status chip is shown.

## License

MIT
