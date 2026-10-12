# Sephral’s Combat Log & Stats

Sephral’s Combat Log & Stats records what really happens in a fight and turns it into numbers and readable reports. Instead of guessing after the combat, the GM gets a round by round log, damage and healing per combatant, takedowns, close calls and control plays, and can share a player friendly report in chat or as a journal.

## Discord

[![Join Discord](https://img.shields.io/badge/Discord-Join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/7BjCgDYaBP)

Questions, feedback, and module support are welcome on [Discord](https://discord.gg/7BjCgDYaBP).

## Features

- Automatic combat log while a GM runs combat in the combat tracker, resumed after a reload
- Damage, healing, temporary hit points, downed combatants and takedowns per combatant
- Exact attribution in D&D 5e: damage and healing applied from a chat card is credited to the combatant who rolled it, including overkill and temporary hit points
- Conditions such as prone, stunned or restrained count as control plays of the combatant who applied them
- Melee, ranged and spell attacks, critical hits and fumbles
- Windows for Summary, Round Log, Statistics, Impact Meter, Corrections, Participants, History and Sharing
- Sortable Impact Meter with damage per round based on applied damage (net or gross) or rolled damage
- Corrections: reclassify unclear hit point changes, set the source of damage nobody claimed, add or reduce damage and healing by hand, ignore entries
- Player reports with selectable sections, several detail levels, hidden enemy names and hidden combatants, posted to chat, created as a journal entry players can read or copied for Discord
- Live preview of the player report in the Sharing tab
- JSON export of the full log, a readable Markdown export and a CSV table with the numbers of every combatant
- English and German. Follow Foundry uses Foundry's language, including community translations
- Foundry VTT v13 and v14

## Usage

1. Start a combat in the combat tracker as usual. SCLS starts a log automatically.
2. Play. Roll and apply damage and healing from the chat cards as you always do.
3. Open the window from the token controls (chart icon) or with the button in the combat tracker.
4. When you end the combat, the summary opens (can be turned off).
5. Check the Corrections tab for hit point changes SCLS could not explain, then share a report from the Sharing tab.

Only the active GM records combats. With a second GM or an assistant logged in, nothing is recorded twice. When the recording GM leaves, the next GM continues the running logs.

## What SCLS tracks

- **Hit points:** every change of hit points, temporary hit points and maximum hit points of a combatant. A change to 0 hit points counts as downed.
- **Who did it:** in D&D 5e the damage tray tells SCLS which chat card a hit came from, so the source is certain. Otherwise SCLS matches the change to a nearby damage or healing roll: targeted rolls first, then rolls with the same amount. Killing blows that remove less than was rolled still match. Changes that fit several rolls, or none, stay in the Corrections tab until the GM assigns them.
- **Rolls:** attack rolls with critical hits and fumbles, damage and healing rolls, saves and checks. Damage rolls that were never applied appear as open rolls in the Round Log. In other systems a natural 20 on a single d20 counts as a critical hit and a natural 1 as a fumble, also with advantage or disadvantage.
- **Conditions and effects:** conditions put on an enemy count as control plays. Automatic states such as bloodied, dead or concentrating do not. The source is the actor behind the effect, otherwise the combatant whose turn it is.
- **Combat flow:** start, rounds, turns, combatants joining or leaving, reloads and the end of combat.

Healing without a known healer counts as healing received only. Damage nobody claimed counts as damage taken only, so it never inflates anybody's damage per round.

## How data is stored

SCLS stores combat logs inside the active world. Combat logs are not written into actors, items, scenes, chat messages, or compendia. Chat message text is not stored.

On Foundry VTT v14 the full logs live in one world data JSON file:

```text
worlds/<world-id>/data/sephrals-combat-log-stats/combat-logs.json
```

The world setting `sephrals-combat-log-stats.combatLogIndex` keeps a compact index for the History tab. On Foundry VTT v13, where client file uploads into the world folder are not reliable, and whenever an upload fails, the logs are kept in that world setting instead.

Events of one moment (a roll, its chat card, the hit point update, a condition) are written together, at most a moment later. Ending a combat, reloading or closing the tab writes right away.

Foundry offers no storage only the GM can read. A player who knows where to look could open the stored logs, so SCLS keeps whispers and chat text out of them.

### The Forge

On The Forge the world folder is not writable, so on Foundry VTT v14 SCLS stores the JSON file in the Assets Library of the Forge account instead:

```text
sephrals-combat-log-stats/<world-id>/combat-logs.json
```

The index keeps the absolute Assets Library URL that The Forge returns for the upload, and SCLS reads the file back from that URL. Combat logs saved by earlier versions under `worlds/<world-id>/data/sephrals-combat-log-stats/combat-logs.json` stay readable and are copied to the new location on the next save. The old file is not deleted.

## Impact Meter

The Impact Meter shows damage dealt and taken, healing, melee, ranged and spell hits, control plays, takedowns, times downed and damage per round for every combatant. Every column can be sorted. Damage per round uses the basis chosen in the settings:

```text
Applied damage (net):   damage applied, plus and minus GM corrections, per round
Applied damage (gross): damage applied without corrections, per round
Rolled damage:          damage rolled, applied or not, per round
```

Unclear hit point changes stay out of all numbers unless the GM classifies them or turns on the setting that includes them.

## Sharing

Sharing is set per combat in the Sharing tab: report detail, report sections, enemy numbers, enemy names and hidden combatants. The GM can post the report to chat or create a journal entry that players can read. Stopping the share hides those journal entries from players again. Chat posts stay in the chat log until the GM deletes them. Reports never show GM notes, private rolls, unclear entries or the Corrections tab.

Report sections: Combat Recap, Party Contributions, Blades and Bows, Spellwork, Healing and Support, Control Plays, Close Calls, Damage Spotlight, Hero Moments, Enemy Pressure, Tactical Turning Points, Support and Saves, and Aftermath.

The preview in the Sharing tab shows the report as players will see it. It follows the settings in the form right away, even before you save them.

Copy for Discord copies the same report as Discord Markdown with names in bold. Discord allows 2,000 characters per message. A longer report is split between sections or lines, and a window lists the parts, each with its own copy button. Copying does not share the combat in Foundry.

With `Post player report when combat ends` or `Create journal report when combat ends` turned on, SCLS shares every ended combat with its own sharing settings, or the defaults from the module settings.

## Export

The Sharing tab also exports the selected combat for the GM:

- **JSON:** the full log with every event
- **Markdown:** a readable document with the summary and all actions by round
- **CSV:** one row per combatant with damage dealt and rolled, damage taken, healing done and received, melee, ranged and spell hits, control effects, critical hits, fumbles, times downed, takedowns and damage per round

The CSV file uses commas and UTF-8 with a byte order mark, so Excel shows umlauts correctly. Excel with German regional settings expects semicolons. Import the file there with Data, From Text/CSV.

## Settings

| Setting | Scope | What it does |
| --- | --- | --- |
| Language | client | Follow Foundry, German or English |
| Track combats automatically | world | Start a log for every combat |
| Resume active combats after reload | world | Continue running logs after a reload |
| Open report when combat ends | client | Open the summary at the end of a combat |
| Track conditions and effects | world | Record conditions and count control plays |
| Include unclear HP changes | world | Count unclear hit point changes before the GM checks them |
| Damage per round basis | world | Applied net, applied gross or rolled damage |
| Allow player reports | world | Allow chat and journal reports for players |
| Default report detail | world | Detail level preselected for new combats |
| Hide enemy names by default | world | Reports call enemies Enemy 1, Enemy 2 and so on |
| Post player report when combat ends | world | Post the report to chat automatically |
| Create journal report when combat ends | world | Create the journal report automatically |
| History retention days | world | Remove ended logs older than this, 0 keeps all |
| Debug logging | client | Extra console output for troubleshooting |

## Limitations

- Exact attribution needs the damage tray of the D&D 5e chat cards on the GM's client. When a player applies damage on their own client, SCLS falls back to matching rolls.
- Other systems get the generic matching of hit point changes and rolls. Systems with other hit point paths can be configured through the `resourcePaths` world setting.
- Changes made while no GM was logged in are found when the log resumes, but SCLS cannot know who caused them.
- With two GMs, only the GM who records a running combat can change its log. The other GM gets a note and can make changes once the combat has ended.
