extends SceneTree
## Steam Deck detection (device.gd is_steam_deck) from what a Deck, a desktop
## and a Deck-like PC show, without a Deck, Firebase Test Lab's setting, and
## where an iOS build was installed from (TestFlight or the App Store).
## test/e2e.mjs runs it.
##   godot --headless --path godot --script res://test/device_test.gd

const Device := preload("res://addons/glitchless/device.gd")
const Glitchless := preload("res://addons/glitchless/glitchless.gd")
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
	_check("Firebase Test Lab: the setting says \"true\"", Device.is_test_lab("true") and Device.is_test_lab("true\n"))
	_check("Firebase Test Lab: anything else, or no setting, is not it", not Device.is_test_lab(null) and not Device.is_test_lab("") and not Device.is_test_lab("false") and not Device.is_test_lab("1"))
	_check("Firebase Test Lab: not on this machine, and reading it never fails off Android", not Device.test_lab())
	var phone := "/private/var/mobile/Containers/Data/Application/BE5EB9FD-3704-488D-96E8-ADB805300ED7"
	_check("iOS: an App Store receipt is the App Store", Device.ios_distribution({"home": phone, "receipt": true}) == "app_store")
	_check("iOS: no receipt on an iPhone is TestFlight (Apple writes one with every App Store install)", Device.ios_distribution({"home": phone}) == "testflight" and Device.ios_distribution({"home": phone.trim_prefix("/private")}) == "testflight")
	_check("iOS: a sandbox receipt, after a TestFlight purchase, is TestFlight", Device.ios_distribution({"home": phone, "sandbox_receipt": true}) == "testflight")
	_check("iOS: a provisioning profile in the bundle is a development build, receipt or not", Device.ios_distribution({"home": phone, "provisioned": true}) == "development" and Device.ios_distribution({"home": phone, "provisioned": true, "sandbox_receipt": true}) == "development")
	_check("iOS: the Simulator is a development build", Device.ios_distribution({"home": "/Users/dev/Library/Developer/CoreSimulator/Devices/1F2E/data/Containers/Data/Application/AB12"}) == "development")
	_check("iOS: an iPad app on a Mac without a receipt can't tell", Device.ios_distribution({"home": "/Users/dev/Library/Containers/AB12/Data"}) == "" and Device.ios_distribution({}) == "")
	_check("iOS: an iPad app on a Mac with a receipt is the App Store; with a sandbox one TestFlight", Device.ios_distribution({"home": "/Users/dev/Library/Containers/AB12/Data", "receipt": true}) == "app_store" and Device.ios_distribution({"home": "/Users/dev/Library/Containers/AB12/Data", "sandbox_receipt": true}) == "testflight")
	_check("iOS: TestFlight and development builds buy in the sandbox, the App Store doesn't", Device.is_sandbox("testflight") and Device.is_sandbox("development") and not Device.is_sandbox("app_store") and not Device.is_sandbox(""))
	_check("iOS: nothing to tell off iOS", Device.distribution() == "" and not Device.info(false).has("distribution"))
	var buy := {"amount": 4.99, "currency": "USD", "item": "full_version"}
	_check("a sandbox install's purchase says sandbox: true, and the game's own attributes are left as they were", Glitchless.sandbox_attrs("purchase", buy, true) == {"amount": 4.99, "currency": "USD", "item": "full_version", "sandbox": true} and not buy.has("sandbox"))
	_check("so does any event with a currency", Glitchless.sandbox_attrs("unlock", {"price": 2, "currency": "EUR"}, true).get("sandbox") == true)
	_check("other events, App Store purchases and a sandbox the game set stay as they are", not Glitchless.sandbox_attrs("level_pick", {"what": "forge"}, true).has("sandbox") and not Glitchless.sandbox_attrs("purchase", buy, false).has("sandbox") and Glitchless.sandbox_attrs("purchase", {"sandbox": false}, true) == {"sandbox": false})
	var here := Device.info(false)
	_check("this machine sends steam_deck as a boolean, false here", here.get("steam_deck") is bool and here.steam_deck == Device.steam_deck() and not here.steam_deck and here.os != "SteamOS")
	print("device tests: %d failed" % _failed)
	quit(1 if _failed else 0)


func _check(name: String, ok: bool) -> void:
	print("%s %s" % ["ok" if ok else "FAIL", name])
	if not ok:
		_failed += 1
