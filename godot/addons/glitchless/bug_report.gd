extends CanvasLayer
## The bug report form (SPEC §2 bug_report): a screenshot of the game as it
## was, a box for the player's note, Send and Cancel. The Glitchless autoload
## makes it the first time the hotkey (bug_reports in init options) or
## Glitchless.open_bug_report() opens it.
##
## The screenshot is taken before the form shows, so the form is never in it.
## While the form is open the game is paused (the "pause" option), so nothing
## the player types or clicks reaches it, and a captured mouse is set free.
## Esc cancels, Ctrl+Enter (Cmd+Enter on a Mac) sends.

const MAX_SCREENSHOT := 200000  # characters of data URL the server keeps (larger ones lose the picture)
const MAX_NOTE := 2000
# Tried in order until the JPEG fits: the longer side in pixels, quality.
const SIZES := [[960, 0.7], [800, 0.6], [640, 0.6], [480, 0.5], [320, 0.5]]

const BACK := Color(0.03, 0.05, 0.09, 0.55)
const PANEL := Color("14213d")
const FIELD := Color("0e182e")
const EDGE := Color("2a3c63")
const ACCENT := Color("2ee6a6")
const TEXT := Color("eef3fb")
const MUTED := Color("8fa1c4")

var is_open := false

var _gl: Node  # the Glitchless autoload
var _pause := true
var _screenshot: Variant = true
var _snap: Dictionary = {}
var _was_paused := false
var _mouse_mode := Input.MOUSE_MODE_VISIBLE
var _root: Control
var _note: TextEdit
var _send: Button
var _cancel: Button


func _init(glitchless: Node, opts: Dictionary) -> void:
	_gl = glitchless
	_pause = bool(opts.get("pause", true))
	_screenshot = opts.get("screenshot", true)
	name = "BugReport"
	layer = 128  # above everything the game draws
	process_mode = Node.PROCESS_MODE_ALWAYS  # it runs while it has the game paused


## Takes the screenshot, then shows the form.
func open() -> void:
	if is_open:
		return
	is_open = true
	var snap: Dictionary = _gl._bug_snapshot(_screenshot)
	_snap = snap
	_was_paused = get_tree().paused
	_mouse_mode = Input.mouse_mode
	Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
	if _pause:
		get_tree().paused = true
	_render("form")
	_gl.bug_report_opened.emit()


func close() -> void:
	if not is_open:
		return
	is_open = false
	_snap = {}
	if _root:
		_root.queue_free()
		_root = null
	if _pause:
		get_tree().paused = _was_paused
	Input.mouse_mode = _mouse_mode
	_gl.bug_report_closed.emit()


func toggle() -> void:
	if is_open:
		close()
	else:
		open()


func send() -> void:
	var snap := _snap
	if snap.is_empty() or _send == null or _send.disabled:
		return
	_send.disabled = true
	_send.text = "Sending…"
	var result: Dictionary = await _gl._send_report(snap, _note.text)
	if not is_same(_snap, snap):
		return  # closed meanwhile
	var reason: String = result.get("reason", "")
	var state := "sent" if result.sent else reason if reason in ["offline", "off"] else "failed"
	_render(state)
	await get_tree().create_timer(1.2 if result.sent else 2.5, true).timeout
	if is_same(_snap, snap):
		close()


# Before the game and the GUI see the key: Esc and Ctrl+Enter would otherwise
# go to the note box (Ctrl+Enter adds a blank line there).
func _input(event: InputEvent) -> void:
	if not is_open or not event is InputEventKey or not event.pressed or event.echo:
		return
	var k := event as InputEventKey
	if k.keycode == KEY_ESCAPE:
		close()
		get_viewport().set_input_as_handled()
	elif (k.keycode == KEY_ENTER or k.keycode == KEY_KP_ENTER) and (k.ctrl_pressed or k.meta_pressed):
		send()
		get_viewport().set_input_as_handled()


# ───────────────────────────── the form ─────────────────────────────

func _render(state: String) -> void:
	if _root:
		_root.queue_free()
	_root = Control.new()
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.mouse_filter = Control.MOUSE_FILTER_STOP  # no click goes through to the game
	_root.theme = _theme()
	add_child(_root)
	var back := ColorRect.new()
	back.color = BACK
	back.set_anchors_preset(Control.PRESET_FULL_RECT)
	back.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(back)
	var center := CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(center)
	var width := minf(380.0, get_viewport().get_visible_rect().size.x - 32.0)
	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(width, 0)
	center.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	panel.add_child(box)
	var title := Label.new()
	title.text = "Report a bug"
	title.add_theme_font_size_override("font_size", 16)
	var bold := FontVariation.new()
	bold.base_font = ThemeDB.fallback_font
	bold.variation_embolden = 0.6
	title.add_theme_font_override("font", bold)
	box.add_child(title)

	var done: String = {
		"sent": "Thanks! Your report was sent.",
		"offline": "Not sent: this build has no Glitchless intake.",
		"off": "Not sent: reports are turned off in the game's settings.",
		"failed": "Couldn't send it now. It will be sent with the game's next batch.",
	}.get(state, "")
	if done != "":
		var msg := _label(done, 14, TEXT)
		msg.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		msg.custom_minimum_size = Vector2(0, 64)
		msg.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		box.add_child(msg)
		_note = null
		_send = null
		_cancel = null
		return

	var shot := PanelContainer.new()
	shot.add_theme_stylebox_override("panel", _box(FIELD, FIELD, 6, 0))
	shot.custom_minimum_size = Vector2(0, roundf((width - 28.0) * 9.0 / 16.0))
	box.add_child(shot)
	var image: Image = _snap.get("image")
	if image != null:
		var preview := TextureRect.new()
		preview.texture = ImageTexture.create_from_image(image)
		preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		shot.add_child(preview)
	else:
		var none := _label("Screenshots are off for this game." if _screenshot is bool and not _screenshot else "No screenshot: this build can't take one.", 12, MUTED)
		none.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		none.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		shot.add_child(none)

	_note = TextEdit.new()
	_note.placeholder_text = "What went wrong? What did you expect?"
	_note.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_note.custom_minimum_size = Vector2(0, 92)
	_note.text_changed.connect(_cap_note)
	box.add_child(_note)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 8)
	box.add_child(row)
	var hint := _label("" if OS.has_feature("mobile") else "Ctrl+Enter sends · Esc cancels", 11, MUTED)
	hint.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hint.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	row.add_child(hint)
	_cancel = Button.new()
	_cancel.text = "Cancel"
	_cancel.pressed.connect(close)
	row.add_child(_cancel)
	_send = Button.new()
	_send.text = "Send"
	_send.theme_type_variation = "SendButton"
	_send.pressed.connect(send)
	row.add_child(_send)
	box.add_child(_label("Sends your note, the screenshot and where you are in the game to its developers.", 11, MUTED))
	_note.grab_focus.call_deferred()


func _cap_note() -> void:
	if _note.text.length() > MAX_NOTE:
		_note.text = _note.text.substr(0, MAX_NOTE)
		_note.set_caret_line(_note.get_line_count() - 1)
		_note.set_caret_column(_note.get_line(_note.get_line_count() - 1).length())


func _label(text: String, size: int, color: Color) -> Label:
	var l := Label.new()
	l.text = text
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	return l


func _theme() -> Theme:
	var t := Theme.new()
	t.default_font_size = 13
	t.set_stylebox("panel", "PanelContainer", _box(PANEL, Color(ACCENT, 0.35), 12, 14))
	t.set_color("font_color", "Label", TEXT)
	for s: String in ["normal", "read_only"]:
		t.set_stylebox(s, "TextEdit", _box(FIELD, EDGE, 6, 8))
	t.set_stylebox("focus", "TextEdit", _box(Color.TRANSPARENT, ACCENT, 6, 8))
	t.set_color("font_color", "TextEdit", TEXT)
	t.set_color("font_placeholder_color", "TextEdit", MUTED)
	t.set_color("caret_color", "TextEdit", ACCENT)
	t.set_stylebox("normal", "Button", _box(Color.TRANSPARENT, EDGE, 6, 8))
	t.set_stylebox("hover", "Button", _box(Color(EDGE, 0.5), EDGE, 6, 8))
	t.set_stylebox("pressed", "Button", _box(EDGE, EDGE, 6, 8))
	t.set_stylebox("disabled", "Button", _box(Color.TRANSPARENT, Color(EDGE, 0.5), 6, 8))
	t.set_stylebox("focus", "Button", StyleBoxEmpty.new())
	t.set_color("font_color", "Button", TEXT)
	t.set_color("font_hover_color", "Button", TEXT)
	t.set_color("font_pressed_color", "Button", TEXT)
	t.set_type_variation("SendButton", "Button")
	for s: String in ["normal", "hover", "pressed"]:
		t.set_stylebox(s, "SendButton", _box(ACCENT if s != "hover" else ACCENT.lightened(0.15), ACCENT, 6, 8))
	t.set_stylebox("disabled", "SendButton", _box(Color(ACCENT, 0.5), Color(ACCENT, 0.5), 6, 8))
	for c: String in ["font_color", "font_hover_color", "font_pressed_color", "font_disabled_color"]:
		t.set_color(c, "SendButton", PANEL)
	return t


static func _box(bg: Color, border: Color, radius: int, pad: int) -> StyleBoxFlat:
	var b := StyleBoxFlat.new()
	b.bg_color = bg
	b.border_color = border
	b.set_border_width_all(1)
	b.set_corner_radius_all(radius)
	b.set_content_margin_all(pad)
	return b


# ───────────────────────────── the screenshot ─────────────────────────────

## A JPEG data URL of at most max_chars characters, or "" when even the
## smallest size doesn't fit. Shrinks the image (its longer side) and lowers
## the quality until it fits, as the browser SDK does.
static func fit_screenshot(img: Image, max_chars: int = MAX_SCREENSHOT) -> String:
	if img == null or img.is_empty():
		return ""
	var rgb := img.duplicate() as Image
	if rgb.is_compressed():
		rgb.decompress()
	rgb.convert(Image.FORMAT_RGB8)
	var longest := maxi(rgb.get_width(), rgb.get_height())
	for size: Array in SIZES:
		var copy := rgb
		var scale := minf(1.0, float(size[0]) / longest)
		if scale < 1.0:
			copy = rgb.duplicate() as Image
			copy.resize(maxi(1, roundi(rgb.get_width() * scale)), maxi(1, roundi(rgb.get_height() * scale)), Image.INTERPOLATE_TRILINEAR)
		var url := "data:image/jpeg;base64," + Marshalls.raw_to_base64(copy.save_jpg_to_buffer(size[1]))
		if url.length() <= max_chars:
			return url
	return ""
