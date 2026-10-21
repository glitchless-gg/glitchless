@tool
extends EditorPlugin
## Turning the plugin on adds the Glitchless autoload; turning it off removes it.
## Adding the autoload by hand (Project Settings > Globals) works just as well.


func _enable_plugin() -> void:
	add_autoload_singleton("Glitchless", "res://addons/glitchless/glitchless.gd")


func _disable_plugin() -> void:
	remove_autoload_singleton("Glitchless")
