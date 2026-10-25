# Godot

Part of the `instrument` skill. Apply its settings first (section 0 of [SKILL.md](../SKILL.md): the
intake URL and client token, privacy, bots, testers and the version), and finish with its last two
sections: the game's own metrics and dashboard, and the report.


Follow the addon's README (`godot/addons/glitchless/README.md`): install, `Glitchless.init`, levels, deaths,
`track`, and `--glitchless-measure` for bots.

## Bug reports from players (ask first)

As for [Three.js](threejs.md#4b-bug-reports-from-players-ask-first), and the same question to the user first. In Godot,
`"bug_reports": true` in the options of `Glitchless.init` adds the F8 form; it pauses the tree while it's open, so
a game with its own pause logic passes `"bug_reports": {"pause": false}` and connects `Glitchless.bug_report_opened` and
`bug_report_closed`. A pause menu can call `Glitchless.open_bug_report()`, and the game's own form
`await Glitchless.report_bug(note)`. The screenshot is the root viewport; headless runs have none. Privacy wording:
`godot/addons/glitchless/PRIVACY.md`.
