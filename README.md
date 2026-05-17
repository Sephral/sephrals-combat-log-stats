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

## MVP Scope

Version 0.1 establishes the architecture and first usable tracker:

- Combat start, update, deletion, resume, combatant, chat, roll, actor-resource, token, and template hooks.
- Persistent CombatLog index in a world setting and large log payloads prepared for world-data JSON files.
- Session segments for combat start and resume after reload.
- Active combat resume and orphan handling on Foundry ready.
- Generic and D&D5e system adapters with conservative roll/resource classification.
- Chat-derived source, target, damage, and healing extraction for automatic combat statistics without GM-entered adjustments during normal play.
- Real token combatants are matched by speaker token, actor, and combatant identifiers so chat events stay attached to the correct active combat even when Foundry has no global combat selected.
- HP/resource delta tracking for configurable resource paths.
- Actor HP/resource deltas that merely confirm an already extracted chat application are stored as evidence but not counted a second time.
- Offline resource delta detection with `unclear` confidence.
- Stats and DPR computation from ledger events.
- Open Combat Log windows update live while a combat is running, so the GM can watch Summary, DPR, Timeline, and History values during play.
- Combat history overview for browsing stored past combats, opening old logs, and comparing status, rounds, participants, net damage, and party DPR.
- Corrections tab for unclassified/unclear deltas and manual classification.
- Manual GM adjustments for adding or reducing damage/healing as explicit ledger events, including an audit history with ignore/restore controls.
- The Corrections view no longer presents a manual entry form; it only shows unresolved data that could not be derived from chat or resource changes.
- Lifecycle events are tracked as safe combat facts and are not shown as correction candidates.
- Participant attribution ignores empty actor UUIDs so side-based DPR stays stable for tokens or simulated combatants without actor UUIDs.
- DPR Meter, Summary, Timeline, Participants, Sharing, Raw Events, and Export sections.
- JSON and Markdown export.

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

Legacy manual GM adjustments are stored as explicit ledger events. They do not edit historical rolls or resource deltas; they add a traceable correction event that is included in recomputed net totals. Player reports keep these GM-only correction events hidden unless GM notes and correction sharing are both explicitly enabled. New combat data is expected to come from chat messages, roll metadata, and actor resource changes rather than GM-entered adjustments.

## Persistence

The module stores a compact index in the world setting `sephrals-combat-log-stats.combatLogIndex`.

The History tab is built from that index and enriches rows from stored log payloads when available, so past combats remain discoverable even after a reload.

Large CombatLog payloads are designed to be written as JSON under world data:

```text
worlds/<world-id>/data/sephrals-combat-log-stats/combat-logs/<combatLogId>.json
```

If the current Foundry environment does not expose persistent file upload helpers to the client, logs remain available in memory and indexed metadata is still maintained. The implementation keeps this path isolated so a server-side helper or later Foundry API can be added without changing the ledger model.

## DPR

Default DPR is Applied Net DPR:

```text
netDamageApplied / combatRounds
```

The module also tracks rolled damage, gross applied damage, correction impact, party DPR, enemy DPR, side DPR, and per-combatant DPR. Unclear deltas are excluded from default DPR unless the GM classifies them or enables unclear-delta inclusion.

## Sharing

Sharing is always opt-in per CombatLog. Players never receive raw events, GM notes, private rolls, hidden combatant data, or correction controls unless the GM explicitly allows the relevant report data.

Default sharing mode is GM-only.

When sharing is enabled, the GM can post a filtered player report to chat or create a journal report. The player report is derived from the computed ledger statistics and respects the CombatLog sharing settings: hostile names can be anonymized, enemy stats can stay hidden, private rolls and GM notes are excluded by default, and unclear events are only included when explicitly allowed.

If `autoPostPlayerSummaryOnEnd` or `autoExportJournalOnEnd` is enabled, the module only runs those actions for CombatLogs that are already explicitly shared.

## Validation

From this module directory:

```powershell
npm run check
npm test
npm run check:manifest
npm run release:prepare
```
