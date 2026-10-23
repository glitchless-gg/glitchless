extends SceneTree
## Steam Deck detection (device.gd is_steam_deck) from what a Deck, a desktop
## and a Deck-like PC show, without a Deck. test/e2e.mjs runs it.
##   godot --headless --path godot --script res://test/device_test.gd

const Device := preload("res://addons/glitchless/device.gd")
const STEAMOS := "NAME=\"SteamOS\"\nPRETTY_NAME=\"SteamOS\"\nVERSION_CODENAME=holo\nID=steamos\nID_LIKE=arch\nVARIANT_ID=steamdeck\nVERSION_ID=3.7.13\n"
const UBUNTU := "PRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nID_LIKE=debian\n"
const BAZZITE := "NAME=\"Bazzite\"\nID=bazzite\nID_LIKE=\"fedora\"\nVARIANT_ID=bazzite-deck\n"

var _failed := 0


func _init() -> void:
	_check("SteamOS on the LCD model", Device.is_steam_deck({"env": "", "board_vendor": "Valve\n", "board_name": "Jupiter\n", "os_release": STEAMOS}))
	_check("the OLED model under another distro (Bazzite): the board says so", Device.is_steam_deck({"board_vendor": "Valve\n", "board_name": "Galileo\n", "os_release": BAZZITE}))
	_check("a Windows build under Proton: Steam's SteamDeck=1", Device.is_steam_deck({"env": "1"}))
	_check("SteamOS on its own (ID=steamos)", Device.is_steam_deck({"os_release": "ID=\"steamos\"\n"}))
	_check("an Ubuntu desktop is not one", not Device.is_steam_deck({"env": "", "board_vendor": "ASUSTeK COMPUTER INC.\n", "board_name": "ROG STRIX B650E-F\n", "os_release": UBUNTU}))
	_check("other Valve hardware is not one by its maker alone", not Device.is_steam_deck({"board_vendor": "Valve\n", "board_name": "Fremont\n", "os_release": UBUNTU}))
	_check("SteamDeck=0 is not one", not Device.is_steam_deck({"env": "0"}))
	_check("nothing known, not one", not Device.is_steam_deck({}))
	_check("a Deck on SteamOS reports SteamOS", Device.is_steam_os({"board_vendor": "Valve", "board_name": "Jupiter", "os_release": STEAMOS}))
	_check("so does a Windows build Steam started on a Deck", Device.is_steam_os({"env": "1"}))
	_check("a Deck under Bazzite stays Linux", not Device.is_steam_os({"board_vendor": "Valve", "board_name": "Galileo", "os_release": BAZZITE}))
	_check("a desktop stays what it is", not Device.is_steam_os({"os_release": UBUNTU}))
	var here := Device.info(false)
	_check("this machine sends steam_deck as a boolean, false here", here.get("steam_deck") is bool and here.steam_deck == Device.steam_deck() and not here.steam_deck and here.os != "SteamOS")
	print("device tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _check(name: String, ok: bool) -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1
