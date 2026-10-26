extends RefCounted
## The checks a session property passes before it is sent (SPEC §2 props).
##
## A property is the game's words about the session: its mode, the player's
## rank tier or class, the region of the game's servers. Never words about the
## person: keys that name a person or an account are dropped, and so are values
## shaped like an email address, a link, a phone number or an ID. Intake checks
## them again, for older and other SDKs. PRIVACY.md beside this file says the same.

const MAX_KEYS := 12
const MAX_STRING := 64
const MAX_NUMBER := 1000000

## Built-in splits and filters a property would hide (the Steam facts among them).
const RESERVED: Array[String] = [
	"version", "level", "env", "platform", "browser", "device_tier", "session_type", "privacy", "role", "link",
	"type", "players", "sessions", "hours", "zone", "match", "party", "run",
	"steam_build", "steam_branch", "steam_hardware", "steam_deck", "proton", "big_picture", "steam_controller",
	"family_shared", "timed_trial", "steam_language",
]

## Keys that would make a property a person's details or an ID.
const IDENTIFYING: Array[String] = [
	"name", "username", "user", "email", "phone", "user_id", "account", "account_id", "player_id", "steam_id",
	"epic_id", "psn_id", "xbox_id", "ip", "address", "device_id", "idfa", "gaid", "ad_id", "location", "lat", "lon",
	"city", "birthday", "age", "gender",
]

static var _key: RegEx
static var _shapes: Array = []  # [RegEx, why]
static var _phone: RegEx


## {"value": what to send} for a property that passes, else {"why": what is wrong}.
## A whole float becomes an int; strings are trimmed and cut to 64 characters.
static func check(key: String, value: Variant) -> Dictionary:
	_compile()
	if _key.search(key) == null:
		return {"why": "keys are 1 to 32 of a-z, 0-9 and _, starting with a letter"}
	if key in RESERVED:
		return {"why": "a built-in split has that name"}
	if key in IDENTIFYING:
		return {"why": "it would describe the person, not the session"}
	if value is bool:
		return {"value": value}
	if value is int or value is float:
		if value is float and value != floorf(value):
			return {"why": "fractions aren't kept: send a band such as \"30-39\""}
		if absf(float(value)) > MAX_NUMBER:
			return {"why": "numbers go from -1,000,000 to 1,000,000"}
		return {"value": int(value)}
	if not (value is String or value is StringName):
		return {"why": "values are a string, a boolean or a whole number"}
	var s := str(value).strip_edges().substr(0, MAX_STRING)
	if s == "":
		return {"why": "the value is empty"}
	var why := shape(s)
	return {"why": why} if why != "" else {"value": s}


## Why a string looks like something that identifies a person, or "".
static func shape(s: String) -> String:
	_compile()
	for rule: Array in _shapes:
		if (rule[0] as RegEx).search(s) != null:
			return rule[1]
	for m in _phone.search_all(s):
		var digits := 0
		for c in m.get_string():
			if c >= "0" and c <= "9":
				digits += 1
		if digits >= 7:
			return "it looks like a phone number"
	return ""


static func _compile() -> void:
	if _key != null:
		return
	_key = RegEx.create_from_string("^[a-z][a-z0-9_]{0,31}$")
	_phone = RegEx.create_from_string("\\+?[0-9][0-9 ().-]{5,}[0-9]")
	for rule: Array in [
		["[^\\s@]+@[^\\s@]+\\.[^\\s@]+", "it looks like an email address"],
		["(?i)\\b[a-z][a-z0-9+.-]*://|\\bwww\\.", "it looks like a link"],
		["[0-9]{7,}", "it has a run of 7 or more digits"],
		["[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}", "it looks like a UUID"],
		# 16 or more characters of hex with a digit and a letter, or of base64 with a digit, a capital and a small
		# letter: the shape of an ID or a token, and almost never of a word.
		["(?=[0-9a-fA-F]*[0-9])(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{16,}", "it looks like an ID (hex)"],
		["(?=[A-Za-z0-9+/]*[0-9])(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{16,}={0,2}", "it looks like an ID (base64)"],
	]:
		_shapes.append([RegEx.create_from_string(rule[0]), rule[1]])
