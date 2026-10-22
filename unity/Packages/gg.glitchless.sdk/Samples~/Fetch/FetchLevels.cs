namespace GlitchlessSamples.Fetch
{
    /// <summary>
    /// The levels, in metres. The ground's top is at y = 0; x grows to the right. The same courses as
    /// the Phaser demo (apps/phaser-demo), scaled from pixels by 1/100.
    /// </summary>
    public sealed class FetchLevel
    {
        public string Id, Name;
        public float Length, Goal;
        public float[][] Pits; // [start, end] gaps in the ground
        public float[] Hydrants; // x of a hydrant to jump over
        public float[][] Squirrels; // [x, patrol half-width]
        public float[][] Bones; // [x, height above the ground]
        public float[] Balls; // a tennis ball: zoomies, and confetti
        public float[][] Frisbees; // [x, height above the ground]
        public float[] Checkpoints;

        public static readonly FetchLevel[] All =
        {
            new FetchLevel
            {
                Id = "level-1", Name = "Backyard", Length = 36, Goal = 34.5f,
                Pits = new[] { new[] { 9f, 10.1f }, new[] { 17f, 18.2f }, new[] { 26f, 27.3f } },
                Hydrants = new[] { 6f, 13.5f, 21.5f, 30.5f },
                Squirrels = new[] { new[] { 23.5f, 0.9f } },
                Bones = new[] { new[] { 4f, 0.3f }, new[] { 4.5f, 0.3f }, new[] { 5f, 0.3f }, new[] { 9.55f, 1.5f }, new[] { 12f, 0.3f }, new[] { 17.6f, 1.5f }, new[] { 20f, 0.3f }, new[] { 26.65f, 1.5f }, new[] { 32f, 0.3f } },
                Balls = new[] { 13f },
                Frisbees = new float[0][],
                Checkpoints = new[] { 12f, 24.9f },
            },
            new FetchLevel
            {
                Id = "level-2", Name = "Dog Park", Length = 44, Goal = 42.5f,
                // GLITCHLESS-DEMO: the Long Jump, the last pit (33 to 34.9): 1.9 m when a jump covers about 2.08 m.
                Pits = new[] { new[] { 7f, 8.3f }, new[] { 15f, 16.4f }, new[] { 24.5f, 26f }, new[] { 33f, 34.9f } },
                Hydrants = new[] { 10f, 19f, 28.5f, 35.6f, 40.8f },
                Squirrels = new[] { new[] { 12.8f, 0.5f }, new[] { 22f, 1f }, new[] { 37.8f, 0.8f } },
                Bones = new[] { new[] { 3f, 0.3f }, new[] { 3.5f, 0.3f }, new[] { 7.65f, 1.5f }, new[] { 15.7f, 1.5f }, new[] { 20.5f, 0.3f }, new[] { 25.25f, 1.5f }, new[] { 33.95f, 1.6f }, new[] { 41.5f, 0.3f } },
                Balls = new[] { 6f, 20f },
                Frisbees = new float[0][],
                Checkpoints = new[] { 14f, 27f },
            },
            new FetchLevel
            {
                Id = "level-3", Name = "Rooftops", Length = 40, Goal = 38.5f,
                Pits = new[] { new[] { 6.5f, 7.8f }, new[] { 11.5f, 12.9f }, new[] { 20.5f, 22f }, new[] { 29f, 30.5f } },
                Hydrants = new[] { 9.5f, 15.5f, 24.5f, 33f, 36f },
                Squirrels = new[] { new[] { 18f, 0.9f }, new[] { 26.5f, 0.8f } },
                Bones = new[] { new[] { 4f, 0.3f }, new[] { 7.15f, 1.5f }, new[] { 12.2f, 1.5f }, new[] { 16.5f, 0.3f }, new[] { 21.25f, 1.5f }, new[] { 29.75f, 1.5f }, new[] { 34.5f, 0.3f } },
                Balls = new[] { 16.5f },
                Frisbees = new[] { new[] { 15.7f, 1.25f } }, // GLITCHLESS-DEMO: catching it throws
                Checkpoints = new[] { 10f, 23f },
            },
        };
    }
}
