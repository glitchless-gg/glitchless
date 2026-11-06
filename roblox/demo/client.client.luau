-- The test place's client: a game event, a gauge, and an error in a LocalScript (Glitchless itself is started by the
-- GlitchlessClient script the server puts in StarterPlayerScripts).
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Glitchless = require(ReplicatedStorage:WaitForChild("Glitchless"))

task.wait(3)
Glitchless.track("settings_opened", { from = "pause" })
Glitchless.setContext({ particles = 120 })
task.wait(6)
local hud = nil
print(hud.Text) -- an error a player's client sends: attempt to index nil with 'Text'
