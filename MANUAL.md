# Sephral’s Combat Log & Stats Manual

This manual covers the details. For a quick overview see the [README](README.md).

## Getting started

1. Start a combat in the combat tracker as usual. The log starts automatically.
2. Play. Roll and apply damage and healing from the chat cards as you always do.
3. Open the window from the token controls (chart icon) or with the button in the combat tracker.
4. When you end the combat, the summary opens (can be turned off).
5. Check the Corrections tab for hit point changes the log could not explain, then share a report from the Sharing tab.

The window has the tabs Summary, Round Log, Statistics, Impact Meter, Corrections, Participants, History and Sharing. In a narrow window the tabs show their icons only. Point at an icon to see the name of its tab.

Only one GM records at a time. With a second GM or an assistant logged in, nothing is recorded twice. When the recording GM leaves, the next GM continues the running logs.

Players can open the same window too, read only. See [What players see](#what-players-see).

## What is tracked

* **Hit points:** every change of hit points, temporary hit points and maximum hit points of a combatant. A change to 0 hit points counts as downed.
* **Who did it:** in D&D 5e the damage and healing you apply from a chat card are credited to the combatant who rolled them. With midi-qol the damage it applies is credited to the attacker of its workflow, and *undo* on midi-qol's damage card takes that damage back as a correction. In other systems the log matches a hit point change to a fitting damage or healing roll. Changes that fit several rolls, or none, wait in the Corrections tab until the GM assigns them.
* **Rolls:** attack rolls with critical hits and fumbles, damage and healing rolls, saves and checks. Damage rolls that were never applied appear as open rolls in the Round Log. In other systems a natural 20 on a single d20 counts as a critical hit and a natural 1 as a fumble, also with advantage or disadvantage.
* **Conditions and effects:** conditions put on an enemy count as control plays. Automatic states such as bloodied, dead or concentrating do not, and the Round Log and the reports leave them out.
* **Combat flow:** start, rounds, turns, combatants joining or leaving, reloads and the end of combat.

Healing without a known healer counts as healing received only. Damage nobody claimed counts as damage taken only, so it never inflates anybody's damage per round. The side totals still count it: damage an enemy took from an unknown source counts as damage the party dealt, damage a party member took counts for the enemies, and healing counts for the side of whoever was healed. That keeps the party and enemy numbers, the damage per round chart and the report recap in line with the net damage. The Summary tab says how many hits had no known attacker. Many of them point to an automation module the log does not know yet: save a debug log and report it.

## Crucible

In Crucible worlds the log reads the four pools of a combatant instead of hit points.

* **Health and wounds** count together as damage. When health runs out and the rest goes into wounds, the log shows one hit with the full amount. Healing restores health, healed wounds count as healing too.
* **Morale and madness** count as morale damage. Morale damage has its own numbers in the Summary, the Impact Meter and the exports and is not part of damage per round.
* **States:** a combatant counts as down when it becomes Weakened, Dead, Broken or Insane. Weakened and then Dead counts once, Broken counts on its own. The Round Log and the reports name the state instead of 0 HP. Weakened, Broken, Insane and Dead are automatic states and no control plays.
* **Action cards:** Crucible changes nothing before the GM confirms an action card. The log keeps the planned outcome of every card and credits the changes of the confirmation to the combatant who used the action. A change that matches the card exactly is certain. A change that stops early, because the target had less health left, is probable. Cards that are not confirmed yet appear as open actions in the Round Log and as a note in the Summary. A deleted card disappears from the log.
* **Undo:** reversing a confirmed card turns its changes into a correction. Damage, healing and takedowns of that card no longer count, and the card is open again until the GM confirms it once more.
* **Critical hits and fumbles** follow Crucible's rules: a critical success or failure on an attack counts, the natural dice do not decide.

Crucible rolls initiative anew at the start of every round. The Participants tab shows the initiative of the current round.

Damage over time at the start of a turn and morale escalation from round 7 have no action card. They count as damage taken or healing received without a source and wait in the Corrections tab like other unexplained changes.

## Impact Meter

The Impact Meter shows damage dealt and taken, healing, melee, ranged and spell hits, control plays, takedowns, times downed and damage per round for every combatant. Every column can be sorted. Damage per round uses the basis chosen in the settings:

* **Applied damage (net):** damage applied, plus and minus GM corrections
* **Applied damage (gross):** damage applied without corrections
* **Rolled damage:** damage rolled, applied or not

Unclear hit point changes stay out of all numbers unless the GM classifies them or turns on the setting that includes them.

## Charts and awards

The Statistics tab shows two charts:

* **Damage per round:** the damage the party and the enemies dealt in each round, side by side.
* **Damage and healing by combatant:** damage dealt, damage taken and healing for up to twelve combatants, sorted by damage dealt.

Point at a bar to see its exact value. Both charts read the same numbers as the Impact Meter. Damage or healing the GM reduces in the Corrections tab comes off the rounds in which that combatant dealt it, latest first.

The Summary tab hands out awards to party members. Enemies never get an award.

| Award | Goes to |
| --- | --- |
| MVP | the most damage dealt plus healing done, every point counts once. In Crucible morale damage counts as well. A tie goes to the one with more takedowns |
| Best Healer | the most healing done |
| Damage Sponge | the most damage taken by someone who never went down |
| Crowd Control | the most control plays |
| Takedowns | the most enemies taken down |
| Clutch Save | the most allies brought back from 0 hit points (Crucible: from 0 health or 0 morale) |
| Lucky Dice | the most critical hits, better dice break a tie |
| Unlucky Dice | the most fumbles, worse dice break a tie. Without any fumble it goes to the lowest average roll of at least three attacks, checks or saves |

An award only appears when somebody earned it. Party members with the same result share it.

## Corrections

The Corrections tab lists every hit point change the log could not explain. The GM can reclassify unclear changes, set the source of damage nobody claimed, add or reduce damage and healing by hand and ignore entries.

## Sharing

Sharing is set per combat in the Sharing tab: report detail, report sections, enemy numbers, enemy names and hidden combatants. The GM can post the report to chat or create a journal entry that players can read. Stopping the share hides those journal entries from players again. Chat posts stay in the chat log until the GM deletes them. Reports never show GM notes, private rolls, unclear entries or the Corrections tab.

Report sections: Combat Recap, Party Contributions, Blades and Bows, Spellwork, Healing and Support, Control Plays, Close Calls, Damage Spotlight, Awards, Hero Moments, Enemy Pressure, Tactical Turning Points, Support and Saves, and Aftermath.

The Awards section lists party members only, so hidden enemy names stay hidden. Whispered rolls do not count toward Lucky or Unlucky Dice in the player report.

The Sharing tab offers only the report sections that have something to tell for this combat with the chosen report detail and options. The options for enemy numbers and enemy names appear only when the combat has enemies, the option for hidden combatants only when it has hidden combatants. A choice that is not shown keeps its saved value, so a section that fills up later starts with the choice you made before.

The preview in the Sharing tab shows the report as players will see it. It follows your choices right away, even before you save them.

*Copy for Discord* copies the same report as Discord text with names in bold. Discord allows 2,000 characters per message, so a longer report is split into parts, each with its own copy button. Copying does not share the combat in Foundry.

With *Post player report when combat ends* or *Create journal report when combat ends* turned on, every ended combat is shared automatically with its own sharing choices or the defaults from the module settings.

## What players see

With *Players can view combat statistics* turned on (the default), players get the chart icon in the token controls and the button in the combat tracker as well. They open the window read only: nothing they click changes, shares or exports a combat. When the GM turns the setting off, the icon and the button disappear for players right away and an open window closes. Players who try to open it get a note that the GM turned it off.

| Tab | What players see |
| --- | --- |
| History | every recorded fight with its rounds, the combatants they may see, party damage and party damage per round. No delete button |
| Summary | the key numbers and the awards, without the count of corrections and without the GM hints |
| Round Log | the actions round by round, only when the report detail of the fight is *Full recap* or *Public report*. Open action cards and manual changes of the GM are left out, they only count in the numbers |
| Statistics | both charts, the discipline mix, the top actions and the side table |
| Impact Meter | the ranking. Sorting changes only their own view |
| Participants | the combatants with their side as plain text |

Corrections and Sharing stay with the GM, and so do renaming, deleting, the manual changes, the exports and the debug log.

Every fight follows its own sharing choices from the Sharing tab, the same way as a player report of that fight. A fight the GM never changed there uses the defaults from the module settings.

* **Hidden combatants** are left out, with everything they did and everything done to them, unless the fight includes hidden combatants.
* **Enemy names:** with *Hide enemy names* the enemies are called Enemy 1, Enemy 2 and so on, in the same order as in the report, and show no portrait.
* **Enemy numbers:** without *Show enemy numbers*, or with a report detail that shares no enemy numbers, players see no enemy rows, no enemy columns in the damage per round chart, no enemy DPR, no healing of enemies and no enemy actions among the top actions. The totals then show the damage and healing of the party.
* **Never shown:** GM notes, whispered rolls and cards, unclear hit point changes, entries the GM ignored and open action cards. Damage or healing applied from a whispered card still counts, because every player sees the hit points change, but the name of the action stays hidden.

The numbers players see are computed from what they may see. Damage the party dealt to a hidden combatant, for example, is not part of their totals.

A running fight shows up as the recording GM last saved it and follows every save, usually within a second. When it ends, it stays selected in the window.

## Export

The Sharing tab also exports the selected combat for the GM:

* **JSON:** the full log
* **Markdown:** a readable document with the summary, a damage per round table and all actions by round
* **CSV:** one row per combatant with damage dealt and rolled, damage taken, healing done and received, melee, ranged and spell hits, control effects, critical hits, fumbles, times downed, takedowns and damage per round. Crucible logs add morale damage dealt and taken
* **Debug log:** for bug reports. The full log, the raw chat messages from one minute before the combat started until one minute after it ended (with rolls, flags and the names of active modules) and the recent hook calls the recording GM saw since the last reload. It contains chat text and whispers, so check it before you share it

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
| Players can view combat statistics | world | Players open the window read only, on by default. See [What players see](#what-players-see) |
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

* Exact attribution in D&D 5e works when the GM applies the damage from the chat card. When a player applies damage on their own client, the log falls back to matching rolls. dnd5e 5.2 does not tell which roll its chat card applies, so there the log always matches the targeted roll.
* With midi-qol the attacker is known wherever midi-qol applies the damage, also on another GM's screen. midi-qol's *Undo workflow* is not recognised: the hit points that come back count as healing. Healing that gives back exactly the last hit a moment later can be read as an undo of that hit.
* In Crucible two open cards with the same outcome on the same target wait for the confirmation of their card before the log credits the change.
* Systems that keep hit points in an unusual place may need extra setup. Ask on [Discord](https://discord.gg/7BjCgDYaBP).
* Changes made while no GM was logged in are found when the log resumes, but nobody can tell who caused them.
* With two GMs, only the GM who records a running combat can change its log. The other GM gets a note and can make changes once the combat has ended.
