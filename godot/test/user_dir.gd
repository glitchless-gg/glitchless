extends SceneTree
## Prints where this project keeps user:// files, for test/e2e.mjs.


func _init() -> void:
	print("user dir: ", OS.get_user_data_dir())
	quit()
