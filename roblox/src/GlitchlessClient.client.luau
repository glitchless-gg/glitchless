-- Glitchless: starts measuring on each player's device. Glitchless.init on the server puts a copy of this LocalScript
-- in StarterPlayerScripts, with a "Module" ObjectValue that points back at the Glitchless module; here, inside the
-- module, it doesn't run (LocalScripts don't run in ReplicatedStorage). With `client = false` in init's options, a
-- game starts the client itself instead: require(ReplicatedStorage.Glitchless).init() from a LocalScript.
local ref = script:WaitForChild("Module", 30)
if not ref or not ref:IsA("ObjectValue") then
	return
end
while not ref.Value do
	ref.Changed:Wait()
end
require(ref.Value).init()
