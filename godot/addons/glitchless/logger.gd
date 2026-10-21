extends Logger
## Hears engine and script errors for the Glitchless autoload (Godot 4.5 and up).
##
## Godot calls _log_error from whichever thread raised the error, so this only
## writes the error down under a lock; the autoload takes the list on the main
## thread every frame (take()). Nothing here may print or push_error: that
## would come straight back in.
##
## Script frames come with each error in debug builds. In release builds they
## come only when the project setting
## debug/settings/gdscript/always_track_call_stacks is on.

const MAX_PENDING := 100

var capture_warnings := false

var _lock := Mutex.new()
var _pending: Array[Dictionary] = []


func _log_error(function: String, file: String, line: int, code: String, rationale: String,
		_editor_notify: bool, error_type: int, script_backtraces: Array[ScriptBacktrace]) -> void:
	if error_type == ERROR_TYPE_WARNING and not capture_warnings:
		return
	var frames: Array[Dictionary] = []
	for bt in script_backtraces:
		for i in bt.get_frame_count():
			frames.append({"fn": bt.get_frame_function(i), "file": bt.get_frame_file(i), "line": bt.get_frame_line(i)})
	var entry := {
		"function": function,
		"file": file,
		"line": line,
		"code": code,
		"rationale": rationale,
		"type": error_type,
		"frames": frames,
	}
	_lock.lock()
	if _pending.size() < MAX_PENDING:
		_pending.append(entry)
	_lock.unlock()


func _log_message(_message: String, _error: bool) -> void:
	pass  # print() output is not an error; push_error() and engine errors arrive in _log_error


## Hands over everything heard since the last call.
func take() -> Array[Dictionary]:
	_lock.lock()
	var out := _pending
	_pending = []
	_lock.unlock()
	return out
