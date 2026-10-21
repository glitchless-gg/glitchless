// Per-level look: sky, fog, lights, palette.
export const THEMES = {
  backyard: {
    sky: { top: 0x3f9cff, mid: 0x8fd0ff, bottom: 0xe6f7ff },
    fog: { color: 0xd9f0ff, near: 38, far: 135 },
    hemi: { sky: 0xd7ecff, ground: 0x6e8f4c, intensity: 1.15 },
    sun: { color: 0xfff0d6, intensity: 2.6, offset: [-9, 16, 11] },
    exposure: 1.05,
    grass: [0x7fd65b, 0x72c950],
    dirt: [0x9b6a45, 0x8d5f3c],
    field: 0x86c95f,
    backWall: 0x6e4a32,
    leaves: [0x4fb34a, 0x63c457, 0x3f9e45, 0x7acb5c],
    trunk: 0x8a5a3b,
    hills: [0x7cc66a, 0x69b85f, 0x8fd078],
  },
  park: {
    sky: { top: 0x3a8ef0, mid: 0x9cd2ff, bottom: 0xfff0d2 },
    fog: { color: 0xf6ead2, near: 38, far: 135 },
    hemi: { sky: 0xfff1db, ground: 0x6b8a45, intensity: 1.1 },
    sun: { color: 0xffe2b5, intensity: 2.7, offset: [-10, 15, 10] },
    exposure: 1.05,
    grass: [0x6fd16a, 0x5ec05c],
    dirt: [0x96633f, 0x885a38],
    field: 0x7cc463,
    backWall: 0x6a4630,
    leaves: [0x5bbf4e, 0x48a84a, 0x8fd35a, 0xf2a65a],
    trunk: 0x7e5235,
    hills: [0x80c86b, 0x6cb75d, 0x9bd27e],
  },
  rooftops: {
    sky: { top: 0x241a5a, mid: 0x9a3f86, bottom: 0xffa25e },
    fog: { color: 0xc8708a, near: 24, far: 115 },
    hemi: { sky: 0xffc6a8, ground: 0x3a2b52, intensity: 1.0 },
    sun: { color: 0xffbe86, intensity: 2.3, offset: [-14, 9, 10] },
    exposure: 1.1,
    roof: [0x8d86a6, 0x847d9c],
    brick: [0xb85d4c, 0xa9523f, 0xc0684f],
    trim: 0xd9d0e6,
    skyline: [0x3b2c63, 0x4e3870, 0x6a4580],
    leaves: [0x4fa35a, 0x5fb36a],
    trunk: 0x6b4a33,
  },
};

export const COLORS = {
  purple: 0x632ca6, // the dog's body
  lavender: 0xc9b3f0,
  pink: 0xe0457b,
  bone: 0xf7eedc,
  gold: 0xffc83d,
  ball: 0xd8f23c,
};
