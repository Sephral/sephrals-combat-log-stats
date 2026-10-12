# Sephral’s Combat Log & Stats Manual

This manual covers the details. For a quick overview see the [README](README.md).

## Getting started

1. Start a combat in the combat tracker as usual. The log starts automatically.
2. Play. Roll and apply damage and healing from the chat cards as you always do.
3. Open the window from the token controls (chart icon) or with the button in the combat tracker.
4. When you end the combat, the summary opens (can be turned off).
5. Check the Corrections tab for hit point changes the log could not explain, then share a report from the Sharing tab.

The window has the tabs Summary, Round Log, Statistics, Impact Meter, Corrections, Participants, History and Sharing.

Only one GM records at a time. With a second GM or an assistant logged in, nothing is recorded twice. When the recording GM leaves, the next GM continues the running logs.

## What is tracked

* **Hit points:** every change of hit points, temporary hit points and maximum hit points of a combatant. A change to 0 hit points counts as downed.
* **Who did it:** in D&D 5e the damage and healing you apply from a chat card are credited to the combatant who rolled them. In other systems the log matches a hit point change to a fitting damage or healing roll. Changes that fit several rolls, or none, wait in the Corrections tab until the GM assigns them.
* **Rolls:** attack rolls with critical hits and fumbles, damage and healing rolls, saves and checks. Damage rolls that were never applied appear as open rolls in the Round Log. In other systems a natural 20 on a single d20 counts as a critical hit and a natural 1 as a fumble, also with advantage or disadvantage.
* **Conditions and effects:** conditions put on an enemy count as control plays. Automatic states such as bloodied, dead or concentrating do not, and the Round Log and the reports leave them out.
* **Combat flow:** start, rounds, turns, combatants joining or leaving, reloads and the end of combat.

Healing without a known healer counts as healing received only. Damage nobody claimed counts as damage taken only, so it never inflates anybody's damage per round.

## Impact Meter

The Impact Meter shows damage dealt and taken, healing, melee, ranged and spell hits, control plays, takedowns, times downed and damage per round for every combatant. Every column can be sorted. Damage per round uses the basis chosen in the settings:

* **Applied damage (net):** damage applied, plus and minus GM corrections
* **Applied damage (gross):** damage applied without corrections
* **Rolled damage:** damage rolled, applied or not

Unclear hit point changes stay out of all numbers unless the GM classifies them or turns on the setting that includes them.

## Corrections

The Corrections tab lists every hit point change the log could not explain. The GM can reclassify unclear changes, set the source of damage nobody claimed, add or reduce damage and healing by hand and ignore entries.

## Sharing

Sharing is set per combat in the Sharing tab: report detail, report sections, enemy numbers, enemy names and hidden combatants. The GM can post the report to chat or create a journal entry that players can read. Stopping the share hides those journal entries from players again. Chat posts stay in the chat log until the GM deletes them. Reports never show GM notes, private rolls, unclear entries or the Corrections tab.

Report sections: Combat Recap, Party Contributions, Blades and Bows, Spellwork, Healing and Support, Control Plays, Close Calls, Damage Spotlight, Hero Moments, Enemy Pressure, Tactical Turning Points, Support and Saves, and Aftermath.

The preview in the Sharing tab shows the report as players will see it. It follows your choices right away, even before you save them.

*Copy for Discord* copies the same report as Discord text with names in bold. Discord allows 2,000 characters per message, so a longer report is split into parts, each with its own copy button. Copying does not share the combat in Foundry.

With *Post player report when combat ends* or *Create journal report when combat ends* turned on, every ended combat is shared automatically with its own sharing choices or the defaults from the module settings.

## Export

The Sharing tab also exports the selected combat for the GM:

* **JSON:** the full log
* **Markdown:** a readable document with the summary and all actions by round
* **CSV:** one row per combatant with damage dealt and rolled, damage taken, healing done and received, melee, ranged and spell hits, control effects, critical hits, fumbles, times downed, takedowns and damage per round

Excel with German regional settings expects semicolons in CSV files. Import the file there with *Data, From Text/CSV*, then umlauts and columns come out right.

## Settings

| Setting | Applies to | What it does |
| --- | --- | --- |
| Language | you | Follow Foundry, German or English |
| Track combats automatically | world | Start a log for every combat |
| Resume active combats after reload | world | Continue running logs after a reload |
| Open report when combat ends | you | Open the summary at the end of a combat |
| Track conditions and effects | world | Record conditions and count control plays |
| Include unclear HP changes | world | Count unclear hit point changes before the GM checks them |
| Damage per round basis | world | Applied net, applied gross or rolled damage |
| Allow player reports | world | Allow chat and journal reports for players |
| Default report detail | world | Detail level preselected for new combats |
| Hide enemy names by default | world | Reports call enemies Enemy 1, Enemy 2 and so on |
| Post player report when combat ends | world | Post the report to chat automatically |
| Create journal report when combat ends | world | Create the journal report automatically |
| History retention days | world | Remove ended logs older than this, 0 keeps all |
| Debug logging | you | Extra console output for troubleshooting |

*Follow Foundry* uses Foundry's language, including community translations.

## Where combat logs are kept

Combat logs are saved inside your world. They are never written into actors, items, scenes, chat messages or compendia, and chat text is not stored.

Foundry has no storage that only the GM can read. A player who knows where to look could open the stored logs, so whispers and chat text are kept out of them.

On The Forge with Foundry v14 the logs go to your Assets Library, in the folder `sephrals-combat-log-stats`. Logs from earlier versions move there automatically.

## Limitations

* Exact attribution in D&D 5e works when the GM applies the damage from the chat card. When a player applies damage on their own client, the log falls back to matching rolls.
* Systems that keep hit points in an unusual place may need extra setup. Ask on [Discord](https://discord.gg/7BjCgDYaBP).
* Changes made while no GM was logged in are found when the log resumes, but nobody can tell who caused them.
* With two GMs, only the GM who records a running combat can change its log. The other GM gets a note and can make changes once the combat has ended.
