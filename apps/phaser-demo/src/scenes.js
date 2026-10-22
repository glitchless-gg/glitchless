// The game's scenes. Built by a function because each class must extend the Phaser.Scene of whichever
// Phaser version is running (3 or 4).
//
// Scene keys matter to Glitchless: instrumentPhaser reports "level-1", "level-2" and "level-3" as levels
// on its own, and leaves "Boot", "Menu", "HUD" and "GameOver" out because they read as a loader, a
// menu, an overlay and an end screen.
import { LEVELS, GROUND_Y, VIEW, groundSegments } from './levels.js';
import { Bot } from './bot.js';

const SPEED = 260;
const ZOOMIES_SPEED = 390;
const JUMP_VY = -720;
const LIVES = 3;
const COYOTE_MS = 90;
const BUFFER_MS = 110;

const POWERUPS = {
  tennis_ball: { boost: ZOOMIES_SPEED, seconds: 3 },
  // GLITCHLESS-DEMO: no entry for 'frisbee', so catching one throws (see catchToy).
};

export function makeScenes(Phaser, { params, tel, onDone }) {
  const state = { score: 0, lives: LIVES, level: null, attempt: 0, startedAt: 0, confetti: 0, bursts: 0 };
  const bot = params.autoplay ? new Bot({ skill: params.skill, seed: params.seed }) : null;

  class Boot extends Phaser.Scene {
    constructor() {
      super('Boot');
    }
    create() {
      // Every picture is drawn here, so the game needs no asset files.
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      const tex = (key, w, h, draw) => {
        g.clear();
        draw(g);
        g.generateTexture(key, w, h);
      };
      tex('dog', 44, 34, (d) => {
        d.fillStyle(0x7b5cff).fillRoundedRect(2, 8, 38, 22, 8);
        d.fillStyle(0x7b5cff).fillRoundedRect(26, 0, 18, 18, 6);
        d.fillStyle(0x4a33b8).fillRect(28, 0, 6, 10);
        d.fillStyle(0xffffff).fillCircle(38, 7, 3);
        d.fillStyle(0x14213d).fillCircle(39, 7, 1.5);
        d.fillStyle(0x4a33b8).fillRect(6, 28, 6, 6).fillRect(28, 28, 6, 6);
      });
      tex('bone', 26, 12, (d) => {
        d.fillStyle(0xfff4d6).fillRect(5, 4, 16, 4);
        for (const [x, y] of [[4, 3], [4, 9], [22, 3], [22, 9]]) d.fillCircle(x, y, 3.5);
      });
      tex('ball', 20, 20, (d) => d.fillStyle(0xd7f04a).fillCircle(10, 10, 9).lineStyle(2, 0xffffff).strokeCircle(10, 10, 6));
      tex('hydrant', 24, 40, (d) => {
        d.fillStyle(0xe63946).fillRoundedRect(3, 6, 18, 34, 4);
        d.fillStyle(0xe63946).fillRect(0, 16, 24, 6);
        d.fillStyle(0xb02a35).fillRoundedRect(5, 0, 14, 9, 3);
      });
      tex('squirrel', 32, 28, (d) => {
        d.fillStyle(0x9c6b3c).fillEllipse(14, 18, 22, 16);
        d.fillStyle(0xb8834e).fillEllipse(26, 10, 14, 18);
        d.fillStyle(0x9c6b3c).fillCircle(8, 10, 6);
        d.fillStyle(0x14213d).fillCircle(6, 9, 1.5);
      });
      tex('frisbee', 32, 12, (d) => d.fillStyle(0xff7ab6).fillEllipse(16, 6, 32, 10).fillStyle(0xffffff).fillEllipse(16, 5, 14, 4));
      tex('flag', 30, 90, (d) => {
        d.fillStyle(0xffffff).fillRect(2, 0, 4, 90);
        d.fillStyle(0x2ec4b6).fillTriangle(6, 2, 30, 14, 6, 26);
      });
      tex('dirt', 64, 64, (d) => {
        d.fillStyle(0x6b4f3a).fillRect(0, 0, 64, 64);
        d.fillStyle(0x4caf50).fillRect(0, 0, 64, 12);
        d.fillStyle(0x5a4130).fillRect(10, 30, 8, 6).fillRect(40, 44, 10, 6);
      });
      g.destroy();
      this.scene.start(params.autoplay ? `level-${params.level}` : 'Menu');
    }
  }

  class Menu extends Phaser.Scene {
    constructor() {
      super('Menu');
    }
    create() {
      this.add.text(VIEW.width / 2, 190, 'Fetch!', { fontFamily: 'system-ui, sans-serif', fontSize: '84px', fontStyle: 'bold', color: '#ffd166' }).setOrigin(0.5);
      this.add.text(VIEW.width / 2, 290, 'Space, ↑ or tap to jump. Get to the flag.', { fontFamily: 'system-ui, sans-serif', fontSize: '22px', color: '#ffffff' }).setOrigin(0.5);
      this.add.text(VIEW.width / 2, 340, 'Press Space to start', { fontFamily: 'system-ui, sans-serif', fontSize: '22px', color: '#2ec4b6' }).setOrigin(0.5);
      this.add.image(VIEW.width / 2, 420, 'dog').setScale(2);
      const go = () => this.scene.start(`level-${params.level}`);
      this.input.keyboard.once('keydown-SPACE', go);
      this.input.once('pointerdown', go);
    }
  }

  class Level extends Phaser.Scene {
    constructor(index) {
      super(LEVELS[index].id);
      this.index = index;
      this.data_ = LEVELS[index];
    }

    init() {
      this.lives = LIVES;
      this.dead = false;
      this.boostUntil = 0;
      this.respawnUntil = 0;
      this.checkpoint = 120;
      this.lastGrounded = 0;
      this.jumpAt = -1e9;
      this.squirrels = [];
      state.level = this.data_.id;
      state.lives = LIVES;
      state.attempt++;
      state.startedAt = this.time.now;
      bot?.newAttempt();
    }

    create() {
      const L = this.data_;
      this.physics.world.setBounds(0, 0, L.length + 200, VIEW.height + 400);
      this.physics.world.setBoundsCollision(true, true, false, false);
      this.sky = this.add.graphics().setScrollFactor(0).setDepth(-10);
      // GLITCHLESS-DEMO: listener leak. Scene events outlive a restart, so every restart adds one more
      // copy of this handler and the sky is redrawn once per copy, every frame.
      this.events.on('update', this.drawSky, this);

      this.ground = this.physics.add.staticGroup();
      for (const [a, b] of groundSegments(L)) {
        const tile = this.add.tileSprite((a + b) / 2, GROUND_Y + 60, b - a, 120, 'dirt');
        this.ground.add(tile);
      }
      this.hydrants = this.physics.add.staticGroup();
      for (const x of L.hydrants) this.hydrants.create(x, GROUND_Y - 20, 'hydrant');
      this.bones = this.physics.add.staticGroup();
      for (const [x, h] of L.bones) this.bones.create(x, GROUND_Y - h, 'bone');
      this.balls = this.physics.add.staticGroup();
      for (const x of L.balls) this.balls.create(x, GROUND_Y - 30, 'ball');
      this.frisbees = this.physics.add.staticGroup();
      for (const [x, h] of L.frisbees) this.frisbees.create(x, GROUND_Y - h, 'frisbee');
      this.flag = this.physics.add.staticImage(L.goal, GROUND_Y - 45, 'flag');

      this.critters = this.physics.add.group({ allowGravity: false, immovable: true });
      L.squirrels.forEach(([x, range], i) => {
        const s = this.critters.create(x, GROUND_Y - 14, 'squirrel');
        s.setData({ home: x, range, id: i });
        s.setVelocityX(-80);
        this.squirrels.push(s);
      });

      this.dog = this.physics.add.sprite(this.checkpoint, GROUND_Y - 40, 'dog');
      this.dog.body.setSize(36, 30).setOffset(4, 4);
      this.physics.add.collider(this.dog, this.ground);
      this.physics.add.overlap(this.dog, this.hydrants, () => this.die('hydrant'));
      this.physics.add.overlap(this.dog, this.critters, (dog, s) => this.hitSquirrel(s));
      this.physics.add.overlap(this.dog, this.bones, (dog, bone) => this.collectBone(bone));
      this.physics.add.overlap(this.dog, this.balls, (dog, ball) => this.fetchBall(ball));
      this.physics.add.overlap(this.dog, this.frisbees, (dog, toy) => this.catchToy(toy, 'frisbee'));
      this.physics.add.overlap(this.dog, this.flag, () => this.finish());

      this.cameras.main.setBounds(0, 0, L.length + 200, VIEW.height);
      this.cameras.main.startFollow(this.dog, true, 1, 0, -260, 0);

      this.keys = this.input.keyboard.addKeys('SPACE,UP,W,R');
      this.input.on('pointerdown', () => (this.jumpAt = this.time.now));
      if (!this.scene.isActive('HUD')) this.scene.launch('HUD');
      this.scene.bringToTop('HUD');
      this.registry.set({ score: state.score, lives: this.lives, level: L.name });
    }

    drawSky() {
      const sky = this.sky;
      if (!sky?.active) return;
      const scroll = this.cameras.main.scrollX;
      sky.clear();
      sky.fillStyle(0x8ecae6).fillRect(0, 0, VIEW.width, VIEW.height);
      for (let i = 0; i < 40; i++) {
        const x = ((i * 173 - scroll * 0.2) % (VIEW.width + 200)) - 100;
        sky.fillStyle(0xffffff, 0.8).fillEllipse(x < -100 ? x + VIEW.width + 200 : x, 60 + ((i * 37) % 140), 90, 28);
      }
      for (let i = 0; i < 24; i++) {
        const x = ((i * 211 - scroll * 0.5) % (VIEW.width + 240)) - 120;
        sky.fillStyle(0x2a9d8f).fillTriangle(x, GROUND_Y, x + 70, GROUND_Y - 120 - (i % 3) * 30, x + 140, GROUND_Y);
      }
    }

    update(time) {
      if (this.dead) return;
      const dog = this.dog;
      const body = dog.body;
      const grounded = body.blocked.down || body.touching.down;
      if (grounded) this.lastGrounded = time;
      const speed = time < this.respawnUntil ? 0 : time < this.boostUntil ? ZOOMIES_SPEED : SPEED;
      dog.setVelocityX(speed);

      let wantJump = Phaser.Input.Keyboard.JustDown(this.keys.SPACE) || Phaser.Input.Keyboard.JustDown(this.keys.UP) || Phaser.Input.Keyboard.JustDown(this.keys.W);
      if (bot && bot.wantsJump({ x: dog.x, speed: speed || SPEED, grounded, level: this.data_, squirrels: this.squirrels.map((s) => ({ id: s.getData('id'), x: s.x, alive: s.active })) })) wantJump = true;
      if (wantJump) this.jumpAt = time;
      if (time - this.jumpAt < BUFFER_MS && time - this.lastGrounded < COYOTE_MS) {
        dog.setVelocityY(JUMP_VY);
        this.jumpAt = -1e9;
        this.lastGrounded = -1e9;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.R)) return this.giveUp('restart');

      for (const s of this.squirrels) {
        if (!s.active) continue;
        const { home, range } = s.data.values;
        if (s.x < home - range) s.setVelocityX(80);
        else if (s.x > home + range) s.setVelocityX(-80);
        s.setFlipX(s.body.velocity.x > 0);
      }
      for (const c of this.data_.checkpoints) if (dog.x > c && this.checkpoint < c) this.checkpoint = c;
      if (dog.y > VIEW.height + 60) this.die('fell');

      const g = tel();
      g?.setPosition({ x: dog.x, y: dog.y, z: 0 });
      g?.setContext({ confetti: state.confetti });
    }

    hitSquirrel(s) {
      const dog = this.dog;
      if (dog.body.velocity.y > 0 && dog.body.bottom <= s.body.top + 12) {
        s.disableBody(true, true);
        dog.setVelocityY(-480);
        tel()?.track('stomp', { enemy: 'squirrel' });
      } else this.die('squirrel');
    }

    collectBone(bone) {
      bone.disableBody(true, true);
      state.score += 10;
      this.registry.set('score', state.score);
      tel()?.track('bone_collected');
    }

    fetchBall(ball) {
      ball.disableBody(true, true);
      this.boostUntil = this.time.now + POWERUPS.tennis_ball.seconds * 1000;
      tel()?.track('powerup', { kind: 'tennis_ball' });
      this.confettiBurst(this.dog.x, this.dog.y);
    }

    // GLITCHLESS-DEMO: confetti leak. Every burst bakes its sparkle sheet again (a new 512×512 texture)
    // and throws 600 physics bodies with their own ground collider. They fade out but are never
    // destroyed, so the physics step keeps simulating every piece ever thrown.
    confettiBurst(x, y) {
      const key = `sparkles-${state.bursts++}`;
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      for (let i = 0; i < 3000; i++) g.fillStyle(0xffffff, 0.5 + Math.random() * 0.5).fillRect(Math.random() * 512, Math.random() * 512, 3 + Math.random() * 6, 3 + Math.random() * 6);
      g.generateTexture(key, 512, 512);
      g.destroy();
      const colors = [0xff006e, 0xffd166, 0x06d6a0, 0x118ab2, 0x8338ec, 0xfb5607];
      const bits = this.physics.add.group({ bounceY: 0.5, dragX: 40 });
      for (let i = 0; i < 600; i++) {
        const bit = bits.create(x, y - 10, key);
        bit.setDisplaySize(6 + Math.random() * 8, 6 + Math.random() * 8).setTint(colors[i % 6]).setAngle(Math.random() * 360);
        bit.setVelocity((Math.random() - 0.25) * 700, -150 - Math.random() * 650);
        state.confetti++;
      }
      this.physics.add.collider(bits, this.ground);
      this.tweens.add({ targets: bits.getChildren(), alpha: 0, delay: 600, duration: 1600 });
    }

    catchToy(toy, kind) {
      toy.disableBody(true, true);
      const p = POWERUPS[kind];
      this.boostUntil = this.time.now + p.seconds * 1000; // TypeError: there is no POWERUPS.frisbee
      tel()?.track('powerup', { kind });
    }

    die(cause) {
      if (this.dead) return;
      this.dead = true;
      const dog = this.dog;
      tel()?.death({ x: dog.x, y: dog.y, cause });
      this.lives--;
      this.registry.set('lives', this.lives);
      dog.setVelocity(0, 0).setTint(0xff4fa3);
      dog.body.enable = false;
      const quit = bot?.died(dog.x);
      this.time.delayedCall(600, () => {
        if (quit) return onDone('quit');
        if (this.lives <= 0) return this.giveUp(cause);
        dog.clearTint();
        dog.body.enable = true;
        dog.body.reset(this.checkpoint, GROUND_Y - 60);
        this.boostUntil = 0;
        this.respawnUntil = this.time.now + 400; // land before running again
        this.dead = false;
      });
    }

    giveUp(cause) {
      tel()?.levelFail(this.data_.id, { cause });
      this.scene.restart();
    }

    finish() {
      if (this.dead) return;
      this.dead = true;
      tel()?.levelComplete(this.data_.id, { durationS: (this.time.now - state.startedAt) / 1000, score: state.score });
      this.dog.setVelocity(0, 0);
      this.time.delayedCall(500, () => {
        if (this.index + 1 < LEVELS.length) this.scene.start(LEVELS[this.index + 1].id);
        else {
          this.scene.stop('HUD');
          this.scene.start('GameOver', { won: true });
        }
      });
    }

    // For agents and the console.
    agentState() {
      const dog = this.dog;
      return {
        level: this.data_.id,
        x: Math.round(dog.x),
        y: Math.round(dog.y),
        grounded: dog.body.blocked.down,
        lives: this.lives,
        score: state.score,
        zoomies: this.time.now < this.boostUntil,
        confetti_images: state.confetti,
        listeners_on_update: this.events.listenerCount('update'),
        attempt: state.attempt,
      };
    }
  }

  class HUD extends Phaser.Scene {
    constructor() {
      super('HUD');
    }
    create() {
      const style = { fontFamily: 'system-ui, sans-serif', fontSize: '20px', color: '#14213d', fontStyle: 'bold' };
      const text = this.add.text(16, 12, '', style);
      const paint = () => text.setText(`${this.registry.get('level') ?? ''}   bones ${this.registry.get('score') ?? 0}   lives ${this.registry.get('lives') ?? LIVES}`);
      paint();
      this.registry.events.on('changedata', paint);
      this.events.once('shutdown', () => this.registry.events.off('changedata', paint));
    }
  }

  class GameOver extends Phaser.Scene {
    constructor() {
      super('GameOver');
    }
    create({ won }) {
      this.add.text(VIEW.width / 2, 220, won ? 'Good dog!' : 'Fetch!', { fontFamily: 'system-ui, sans-serif', fontSize: '72px', fontStyle: 'bold', color: '#ffd166' }).setOrigin(0.5);
      this.add.text(VIEW.width / 2, 310, `${state.score} bones`, { fontFamily: 'system-ui, sans-serif', fontSize: '28px', color: '#ffffff' }).setOrigin(0.5);
      if (won) onDone('won');
    }
  }

  return { scenes: [Boot, Menu, ...LEVELS.map((_, i) => class extends Level {
    constructor() {
      super(i);
    }
  }), HUD, GameOver], state };
}
