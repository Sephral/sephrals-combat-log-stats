# Sephral’s Combat Log & Stats

Sephral’s Combat Log & Stats helps GMs understand what really happened in combat and turn that into readable reports for the table. Instead of guessing after the fight, SCLS keeps a running combat log, builds summaries and performance views from it, and lets the GM share only the parts players should see.

## Discord

[![Join Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/7BjCgDYaBP)

Questions, feedback, and module support are welcome on [Discord](https://discord.gg/7BjCgDYaBP).

## Why GMs Use It

- Keep a live record of what happened during a fight instead of reconstructing it afterward.
- See combat performance from multiple angles: summary, round flow, impact, participant stats, and corrections.
- Review older combats later and compare how fights played out.
- Share readable reports with players without exposing GM-only details.
- Catch uncertain or incomplete data instead of silently treating guesses as facts.

## What Players Get

- Clean combat recaps instead of raw event spam.
- Optional report sections such as party contributions, close calls, hero moments, enemy pressure, and aftermath.
- Chat posts or journal reports that are filtered for player-safe visibility.

## Features

Version 0.1.1 includes:

- Automatic combat logging while a GM runs combat.
- Live windows for Summary, Impact Meter, Round Log, Statistics, Corrections, Participants, History, and Sharing.
- Sortable combat-performance tables for damage, healing, control, downed moments, and Net DPR.
- Combat history for reopening earlier fights and reviewing key numbers.
- Corrections tools for unclear data and manual GM adjustments with an audit trail.
- Player report sharing with selectable sections and chat/journal export.
- JSON and Markdown export for external use.

## What SCLS Tracks

SCLS follows the flow of combat across start, progress, interruptions, reloads, resumes, and combat end. It watches the kinds of information that matter for post-fight review: who acted, who took damage, who was healed, when control effects landed, when someone dropped, and where data is still unclear.

The goal is not to replace your system automation. The goal is to give the GM a trustworthy combat record and useful presentation layers on top of it.

## How Data Is Stored

SCLS stores combat data inside the active Foundry world. Combat logs are not written into actors, items, scenes, chat messages, or compendia.

The primary storage location is one world-data JSON file that is updated whenever a combat log changes:

```text
worlds/<world-id>/data/sephrals-combat-log-stats/combat-logs.json
```

That file contains the full stored combat logs, including combat metadata, participants, event history, report settings, corrections, and computed statistics.

The world setting `sephrals-combat-log-stats.combatLogIndex` is kept as a compact discovery index and fallback metadata store. It powers the History tab and keeps enough information to show old combats even after reloads.

On Foundry VTT v13, where client-side world file uploads can be unavailable or unreliable, SCLS uses the same world setting as an inline fallback for the stored combat logs. Foundry VTT v14 uses the world-data JSON file when the client upload API is available.

## Impact Meter

The default DPR view is Applied Net DPR:

```text
netDamageApplied / combatRounds
```

The Impact Meter is meant to answer the table's common questions at a glance: who carried damage, who supported, who controlled the battlefield, who went down, and how much pressure each side created. Unclear deltas stay out of the default view unless the GM explicitly chooses to include them. Every visible column can be sorted.

## Sharing

Sharing is controlled through report settings per CombatLog. The GM chooses which sections belong in the report, then can post that report to chat, create a journal entry, or export it as JSON/Markdown. Reports never expose raw events, GM notes, private rolls, hidden combatant data, or correction controls.

Available report sections include Combat Recap, Party Contributions, Blades/Bows/Close Calls, Spellwork, Healing and Support, Control Plays, Close Calls, Damage Spotlight, Hero Moments, Enemy Pressure, Tactical Turning Points, Support and Saves, and Aftermath.

If `autoPostPlayerSummaryOnEnd` or `autoExportJournalOnEnd` is enabled, the module only runs those actions for CombatLogs that are already explicitly shared.
