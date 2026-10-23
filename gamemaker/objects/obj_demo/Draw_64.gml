/// What the demo is doing, and the bug report key.
draw_set_colour(c_white);
draw_set_halign(fa_left);
draw_text(16, 16, room_get_name(room) + "   " + string(fps) + " fps   sparks: " + string(instance_number(obj_spark)));
draw_text(16, 40, "F8: report a bug");
