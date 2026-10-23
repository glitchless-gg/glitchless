/// A spark flies off in a random direction.
var _angle = random(360);
var _speed = random_range(50, 300);
vx = lengthdir_x(_speed, _angle);
vy = lengthdir_y(_speed, _angle);
colour = make_colour_hsv(irandom(255), 200, 255);
