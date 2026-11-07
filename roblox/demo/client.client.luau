-- The test place's client: a game event, a gauge, a ProximityPrompt, and an error in a LocalScript (Glitchless itself
-- is started by the GlitchlessClient script the server puts in StarterPlayerScripts, which may run after this one:
-- what is said before it starts waits for it).
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Glitchless = require(ReplicatedStorage:WaitForChild("Glitchless"))

Glitchless.track("client_ready")

task.wait(3)
Glitchless.track("settings_opened", { from = "pause" })
Glitchless.setContext({ particles = 120 })
-- The garage kiosk's prompt, pressed as a player pressing its key would once it shows (the server counts it with
-- prompts on).
local pressed = false
local function press(prompt: ProximityPrompt)
	if pressed or prompt.ObjectText ~= "Garage" then
		return
	end
	pressed = true
	print("[demo] the garage prompt shows: pressing it")
	prompt:InputHoldBegin()
	task.wait(0.2)
	prompt:InputHoldEnd()
end
game:GetService("ProximityPromptService").PromptShown:Connect(press)
task.wait(6)
local hud = nil
print(hud.Text) -- an error a player's client sends: attempt to index nil with 'Text'
