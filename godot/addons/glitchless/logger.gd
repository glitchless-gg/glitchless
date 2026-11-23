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
##
## As Godot's crash handler starts, the autoload sets crash_path: what the
## handler prints next (the signal, the engine's backtrace and the script's)
## goes to that file line by line, since the game dies right after.

const MAX_PENDING := 100
const MAX_CRASH_BYTES := 16384

var capture_warnings := false
var crash_path := ""

var _lock := Mutex.new()
var _pending: Array[Dictionary] = []
var _crash_bytes := 0


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


# print() output is not an error; push_error() and engine errors arrive in _log_error. Only the crash handler's
# words are kept, once crash_path is set.
func _log_message(message: String, _error: bool) -> void:
	if crash_path == "" or _crash_bytes > MAX_CRASH_BYTES:
		return
	var f := FileAccess.open(crash_path, FileAccess.READ_WRITE)
	if f:
		f.seek_end()
		f.store_string(message)
		f.close()
		_crash_bytes += message.length()


## Hands over everything heard since the last call.
func take() -> Array[Dictionary]:
	_lock.lock()
	var out := _pending
	_pending = []
	_lock.unlock()
	return out


## What take() would hand over, left in place. For the crash handler, which may
## run while another thread holds the lock: then it gets nothing rather than wait.
func peek() -> Array[Dictionary]:
	if not _lock.try_lock():
		return []
	var out := _pending.duplicate()
	_lock.unlock()
	return out
