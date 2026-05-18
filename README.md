# Sephral’s Combat Log & Stats

Sephral’s Combat Log & Stats tracks Foundry combats as a persistent event ledger and computes honest combat statistics, DPR, corrections, and player-safe reports from that ledger.

## Discord

[![Join Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/7BjCgDYaBP)

Questions, feedback, and module support are welcome on [Discord](https://discord.gg/7BjCgDYaBP).

## Design Goals

- Extend Foundry combat workflows without replacing combat automation or enforcing rules.
- Track what happened between combat start, interruptions, resumes, and combat end.
- Treat the combat log as an event ledger, not a post-hoc estimate.
- Separate rolled damage, applied resource deltas, corrections, and net results.
- Mark uncertain data as uncertain instead of silently treating guesses as facts.
- Keep all logs GM-only by default and require explicit sharing choices.

## Features

Version 0.1.0 provides:

- Combat start, update, deletion, resume, combatant, chat, roll, actor-resource, token, and template hooks.
- Persistent world-data JSON store for all CombatLogs, with a compact world-setting index for discovery and fallback metadata.
- Session segments for combat start and resume after reload.
- Active combat resume and orphan handling on Foundry ready.
- Generic and D&D5e system adapters with conservative roll/resource classification.
- Chat-derived source, target, damage, and healing extraction for automatic combat statistics without GM-entered adjustments during normal play.
- Real token combatants are matched by speaker token, actor, and combatant identifiers so chat events stay attached to the correct active combat even when Foundry has no global combat selected.
- HP/resource delta tracking for configurable resource paths.
- Actor HP/resource deltas that merely confirm an already extracted chat application are stored as evidence but not counted a second time.
- Offline resource delta detection with `unclear` confidence.
- Stats and DPR computation from ledger events.
- Open Combat Log windows update live while a combat is running, so the GM can watch Summary, Impact Meter, Round Log, and History values during play.
- Combat history overview for browsing stored past combats, opening old logs, and comparing status, rounds, participants, net damage, and party DPR.
- Corrections tab for unclassified/unclear deltas and manual classification.
- Manual GM adjustments for adding or reducing damage/healing as explicit ledger events, including an audit history with ignore/restore controls.
- The Corrections view no longer presents a manual entry form; it only shows unresolved data that could not be derived from chat or resource changes.
- Lifecycle events are tracked as safe combat facts and are not shown as correction candidates.
- Participant attribution ignores empty actor UUIDs so side-based DPR stays stable for tokens or simulated combatants without actor UUIDs.
- Impact Meter, Summary, Round Log, Statistics, Corrections, Participants, History, and Sharing sections.
- Sortable Impact Meter columns for combatant, side, damage, healing, discipline counts, control, downed moments, and Net DPR.
- JSON and Markdown export from Sharing.

## Core Model

A CombatLog stores:

- durable combat metadata and status
- session segments
- stable participant references and fallback names/images
- initial and latest resource snapshots
- an append-only event ledger
- manual overrides and share settings
- recomputable statistics

Statistics are computed from ledger events. Damage rolls alone do not imply applied damage. Resource deltas alone do not imply a safe source or target. Corrections and manual classifications are explicit ledger facts.

Manual GM adjustments are stored as explicit ledger events. They do not edit historical rolls or resource deltas; they add a traceable correction event that is included in recomputed net totals. Player reports keep GM-only correction events and GM-only markers hidden. New combat data is expected to come from chat messages, roll metadata, and actor resource changes rather than GM-entered adjustments.

## How Data Is Stored

SCLS stores combat data inside the active Foundry world. Combat logs are not written into actors, items, scenes, chat messages, or compendia.

The primary storage location is one world-data JSON file that is updated whenever a combat log changes:

```text
worlds/<world-id>/data/sephrals-combat-log-stats/combat-logs.json
```

That file contains the full stored `CombatLog` payloads: combat metadata, session segments, participants, resource snapshots, ledger events, manual corrections, report settings, and recomputable statistics.

The world setting `sephrals-combat-log-stats.combatLogIndex` is kept as a compact discovery index and fallback metadata store. It lets the History tab find past combats quickly and keeps enough metadata to show rows such as title, status, start/end time, rounds, participants, net damage, and party DPR. It is not the primary payload store when the JSON file can be written.

The History tab is built from that index and enriches rows from stored log payloads when available, so past combats remain discoverable even after a reload.

If the current Foundry environment does not expose persistent file upload helpers to the client, SCLS falls back to storing full log payloads inline in the world-setting index so reloads still keep the data.

Generated player reports are separate Foundry content: posting a report creates a normal chat message, and creating a journal report creates a normal journal entry. These reports contain only the filtered report output selected by the GM; they do not expose the internal ledger or GM-only events.

Deleting a combat log from SCLS removes it from the central store and index. It does not delete chat messages or journal entries that were previously generated from that combat.

## Impact Meter

Default DPR is Applied Net DPR:

```text
netDamageApplied / combatRounds
```

The module also tracks rolled damage, gross applied damage, correction impact, party DPR, enemy DPR, side DPR, and per-combatant DPR. Unclear deltas are excluded from default DPR unless the GM classifies them or enables unclear-delta inclusion. The Impact Meter table can be sorted by each visible column.

## Sharing

Sharing is controlled through report settings per CombatLog. The GM selects which report sections should be included, then can post the filtered player report to chat, create a journal report, or export JSON/Markdown. The report is derived from the computed ledger statistics and never exposes raw events, GM notes, private rolls, hidden combatant data, or correction controls.

Available report sections include Combat Recap, Party Contributions, Blades/Bows/Close Calls, Spellwork, Healing and Support, Control Plays, Close Calls, Damage Spotlight, Hero Moments, Enemy Pressure, Tactical Turning Points, Support and Saves, and Aftermath.

If `autoPostPlayerSummaryOnEnd` or `autoExportJournalOnEnd` is enabled, the module only runs those actions for CombatLogs that are already explicitly shared.
