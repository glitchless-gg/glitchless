// The player's off switch (SPEC §4d): SetEnabled for a "Share performance data" toggle in the game's settings, the
// choice saved on the device and read before anything is kept on the next launch, and Opt In for a game that asks first.

#include "CoreHarness.h"
#include "GlitchlessRules.h"

#include <string>
#include <utility>

using namespace Glitchless;

namespace
{
	std::string Str(const FValue& E, const char* Key)
	{
		const FValue* V = E.Find(Key);
		return V && V->IsString() ? V->AsString() : "";
	}

	// Every event sent, by either kind of send, with the session it went under.
	std::vector<std::pair<std::string, FValue>> BySession(const FHarness& H)
	{
		std::vector<std::pair<std::string, FValue>> Out;
		for (const std::string& B : H.Transport->InOrder)
		{
			FValue Envelope;
			if (!FValue::Parse(B, Envelope))
			{
				continue;
			}
			for (const FValue& E : Envelope.Find("events")->GetItems())
			{
				Out.emplace_back(Envelope.Find("session_id")->AsString(), E);
			}
		}
		return Out;
	}

	size_t Requests(const FHarness& H)
	{
		return H.Transport->InOrder.size() + H.Transport->Gets.size();
	}

	// One of everything a game and Unreal report.
	void PlayEverything(FHarness& H, FCore& Core)
	{
		Core.LevelStart("Gallery");
		H.Frames(Core, 30);
		FFrameCost Slow = FHarness::Cost(120, 3, 2, 5);
		H.Now += 130;
		Core.Frame(130, Slow);
		H.Frames(Core, 3);
		Core.Track("door_opened");
		Core.Count("shot", FValue(), 3);
		Core.Death(1, 2, 3, "fell");
		Core.SetPosition(1, 2, 3);
		Core.SetContext("enemies", 12);
		Core.ReportError("log_error", "Something broke", "", FValue(), false, "LogTemp");
		Core.ReportError("ensure", "Ensure condition failed: Ptr", "", FValue(), false, "");
		FNetSample S;
		S.RttMs = 40;
		Core.NetSample(S);
		Core.OnInput("SpaceBar");
		Core.LevelFail("Gallery", "fell");
	}
}

TEST(TurningItOffDropsWhatIsWaitingAndSendsNothingMore)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options(EPrivacy::Install));
	const std::string Player = Core->GetPlayerId();
	Core->LevelStart("Gallery");
	H.Frames(*Core, 30);
	H.Transport->Status = 0; // offline: the batch waits in the outbox, on disk
	Core->Flush();
	Core->BugReport("the door won't open", ""); // a report waiting in it too
	// And an open window, events queued, a count held for the server's answer and a hitch waiting for its causes.
	H.Frames(*Core, 60);
	Core->Count("shot", FValue(), 2);
	Core->Track("door_opened");
	H.Now += 130;
	Core->Frame(130, FHarness::Cost(120, 3, 2, 5));
	EXPECT(Exists(H.Dir + "/outbox.json"));
	EXPECT(Core->OutboxEvents() > 0);
	EXPECT(!Core->Queued().empty());
	const size_t Before = Requests(H);

	Core->SetEnabled(false);
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "off");
	EXPECT(!Core->IsEnabled());
	EXPECT(Core->IsTurnedOff());
	EXPECT(!Exists(H.Dir + "/outbox.json")); // the bug report with it
	EXPECT_EQ(Core->OutboxEvents(), 0);
	EXPECT(Core->Queued().empty());
	EXPECT_EQ(Core->GetLevel().value_or(""), "Gallery"); // what the game said stays in memory

	// Nothing is measured, kept or sent from here: not the session's end, the level's abandon, nor a crash.
	H.Transport->Status = 202;
	H.Transport->Takes();
	PlayEverything(H, *Core);
	Core->BugReport("still broken", "");
	EXPECT(Core->MakeBugReport("").IsNull());
	Core->Flush();
	EXPECT(Core->Queued().empty());
	Core->OnBackground();
	Core->ReportCrash("crash", "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0", "");
	Core->Shutdown("quit");
	EXPECT_EQ(Requests(H), Before); // no batch, and no GET /v1/health either
	EXPECT(!Exists(H.Dir + "/outbox.json"));
	EXPECT_EQ(Core->GetStats().Errors, static_cast<int64_t>(0));
	EXPECT(Text::StartsWith(ReadAll(H.Dir + "/player_id"), Player)); // still one player if they turn it back on
}

TEST(AnAnswerOnItsWayWhenTurnedOffIsIgnored)
{
	FHarness H;
	H.Transport->HoldGets = true;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 30);
	H.Transport->Hold = true;
	H.Transport->Status = 503; // its answer would put the batch back for another try
	Core->Flush(); // on its way when the player says no
	EXPECT_EQ(H.Transport->Pending.size(), 1u);
	Core->SetEnabled(false);
	H.Transport->Wait(0);
	H.Transport->AnswerGets();
	EXPECT_EQ(Core->OutboxEvents(), 0);
	EXPECT(!Exists(H.Dir + "/outbox.json"));
	EXPECT(!Core->FeaturesKnown()); // asked again once it is on
	H.Frames(*Core, 400);
	Core->Shutdown("quit");
	EXPECT_EQ(H.Transport->Sent.size(), 1u);
	EXPECT(H.Transport->SentNow.empty());
}

TEST(TurningItBackOnStartsANewSessionWithItsPropertiesAndGroups)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->SetProperty("rank", FValue("gold"));
	Core->SetGroup("party", "party-0001");
	Core->LevelStart("Gallery");
	H.Frames(*Core, 30);
	Core->Flush();
	const std::string First = Core->GetSessionId();
	Core->SetEnabled(false);
	// What the game says while it is off is kept for the next session, unsent.
	Core->SetProperty("mode", FValue("squads"));
	Core->SetZone("docks");
	H.Now += 60000;
	Core->SetEnabled(true);
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "on");
	EXPECT(Core->IsEnabled());
	EXPECT(Core->GetSessionId() != First);
	H.Frames(*Core, 30);
	Core->Track("back");
	// The attempt that was going isn't open in the new session: its outcome would come without its start.
	Core->LevelComplete();
	Core->LevelFail("Gallery", "fell");
	Core->LevelAbandon();
	Core->Flush();
	bool Start = false, Group = false, Window = false, Back = false;
	for (const auto& E : BySession(H))
	{
		const std::string T = Str(E.second, "type");
		if (E.first == First)
		{
			EXPECT(T != "session_end" && T != "level_abandon" && T != "custom"); // the first session just went quiet
			continue;
		}
		EXPECT(T != "load" && T != "level_start" && T != "level_complete" && T != "level_fail" && T != "level_abandon");
		Start = Start || (T == "session_start" && E.second.Find("props")->Serialize() == R"({"rank":"gold","mode":"squads"})");
		Group = Group || (T == "group" && Str(E.second, "kind") == "party");
		Window = Window || (T == "frame_window" && Str(E.second, "level") == "Gallery" && Str(E.second, "zone") == "docks");
		Back = Back || (T == "custom" && Str(E.second, "name") == "back" && Str(E.second, "party") == Rules::HashGroupId("fetch", "party-0001"));
	}
	EXPECT(Start && Group && Window && Back);
	// The next attempt is the new session's own.
	Core->LevelStart("Gallery");
	Core->LevelComplete();
	Core->Flush();
	EXPECT_EQ(OfType(H.AllEvents(), "level_complete").size(), 1u);
}

TEST(ACallThatChangesNothingDoesNothing)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->ReadChoice();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 30);
	const std::string Session = Core->GetSessionId();
	const size_t Queued = Core->Queued().size();
	Core->SetEnabled(true); // the game passes its own saved setting as it starts
	EXPECT_EQ(Core->GetSessionId(), Session);
	EXPECT_EQ(Core->Queued().size(), Queued);
	EXPECT(Core->IsEnabled());
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "on"); // the game has said: saved
	Core->SetEnabled(false);
	Core->SetEnabled(false);
	Core->SetEnabled(true);
	const std::string Second = Core->GetSessionId();
	Core->SetEnabled(true);
	EXPECT_EQ(Core->GetSessionId(), Second);
	Core->Flush();
	EXPECT_EQ(OfType(H.AllEvents(), "session_start").size(), 1u); // the first never sent its own: it had nothing to say
	EXPECT_EQ(OfType(H.AllEvents(), "group").size(), 0u);
}

TEST(AChoiceOfOffIsReadBeforeAnythingIsKept)
{
	FHarness H;
	// An earlier launch left an outbox, a crash in it, and the player had turned Glitchless off.
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Frames(*First, 30);
	H.Transport->Status = 0;
	First->ReportCrash("crash", "Assertion failed: Ptr", "");
	EXPECT(Exists(H.Dir + "/outbox.json"));
	{
		std::FILE* F = std::fopen((H.Dir + "/enabled").c_str(), "wb");
		std::fputs("off\n", F);
		std::fclose(F);
	}
	H.Transport->Status = 202;
	H.Transport->Takes();
	const size_t Gets = H.Transport->Gets.size();

	auto Second = H.NewCore();
	Second->ReadChoice();
	EXPECT(!Exists(H.Dir + "/outbox.json")); // deleted unread
	Second->OnMapLoaded("Arena", 1);
	PlayEverything(H, *Second);
	EXPECT(Second->Queued().empty()); // nothing kept before Init either
	Second->Init(FHarness::Options());
	EXPECT(!Second->IsEnabled());
	Second->Flush();
	Second->ReportCrash("crash", "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0", "");
	EXPECT(!Exists(H.Dir + "/outbox.json")); // no crash written to it
	Second->Shutdown("quit");
	EXPECT(H.Transport->InOrder.empty());
	EXPECT_EQ(H.Transport->Gets.size(), Gets);
	FValue Measured;
	Second->Measure(1, [&Measured](const FValue& R) { Measured = R; });
	EXPECT(Str(Measured, "error").find("Glitchless is off") != std::string::npos);

	// The player turns it on again in a later launch: a session from there, the load not sent again.
	auto Third = H.NewCore();
	Third->ReadChoice();
	Third->OnMapLoaded("Arena", 1);
	H.Frames(*Third, 30);
	Third->Init(FHarness::Options());
	Third->SetEnabled(true);
	H.Frames(*Third, 30);
	Third->LevelComplete("Arena", 10, std::nullopt); // the map level started while it was off
	Third->Flush();
	const std::vector<FValue> Sent = H.Transport->Events();
	EXPECT_EQ(Type(Sent.at(0)), "session_start");
	EXPECT_EQ(OfType(Sent, "frame_window").size(), 1u);
	EXPECT_EQ(Str(OfType(Sent, "frame_window").at(0), "level"), "Arena");
	EXPECT(OfType(Sent, "load").empty());
	EXPECT(OfType(Sent, "level_complete").empty());
	EXPECT(H.Transport->Gets.size() > Gets); // now it may ask what the server takes
}

TEST(OptInStartsOffUntilTheGameTurnsItOn)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->ReadChoice(true);
	EXPECT(Core->IsTurnedOff());
	H.Frames(*Core, 30);
	Core->Track("before_asking");
	Core->Init(FHarness::Options());
	EXPECT(!Core->IsEnabled());
	EXPECT(!Exists(H.Dir + "/enabled")); // nothing saved until the game calls SetEnabled
	Core->Flush();
	EXPECT(H.Transport->InOrder.empty());
	Core->SetEnabled(true); // the player said yes
	EXPECT(Core->IsEnabled());
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "on");
	Core->Track("after_asking");
	H.Frames(*Core, 30);
	Core->Flush();
	const std::vector<FValue> Sent = H.Transport->Events();
	EXPECT_EQ(Type(Sent.at(0)), "session_start");
	EXPECT_EQ(OfType(Sent, "custom").size(), 1u);
	EXPECT_EQ(Str(OfType(Sent, "custom").at(0), "name"), "after_asking");

	// The next launch reads the answer: on from the first frame.
	auto Next = H.NewCore();
	Next->ReadChoice(true);
	EXPECT(!Next->IsTurnedOff());
	FOptions O = FHarness::Options();
	O.OptIn = true;
	Next->Init(O);
	EXPECT(Next->IsEnabled());

	// Opt In given to Init: what was kept before it is dropped there.
	FHarness H2;
	auto Late = H2.NewCore();
	H2.Frames(*Late, 30);
	Late->Track("kept");
	Late->Init(O);
	EXPECT(!Late->IsEnabled());
	EXPECT(Late->Queued().empty());
	// A server has no player to ask.
	auto Server = H2.NewCore();
	Server->Role = ERole::Server;
	Server->ReadChoice(true);
	Server->Init(O);
	EXPECT(Server->IsEnabled());
}

TEST(TheBuildsOwnOffStaysOff)
{
	FHarness H;
	auto Off = H.NewCore({"-glitchless-off"});
	Off->SetEnabled(false);
	Off->SetEnabled(true);
	Off->Init(FHarness::Options());
	EXPECT(!Off->IsEnabled());
	Off->SetEnabled(false);
	Off->SetEnabled(true);
	EXPECT(!Off->IsEnabled());
	EXPECT(!Off->IsTurnedOff());
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "on"); // the player's choice is still saved as theirs
	FOptions O = FHarness::Options();
	O.SendInDevelopmentBuilds = false;
	auto Dev = H.NewCore();
	Dev->Init(O);
	Dev->SetEnabled(true);
	EXPECT(!Dev->IsEnabled());
	O.SendInDevelopmentBuilds = true;
	O.Enabled = false;
	auto Disabled = H.NewCore();
	Disabled->Init(O);
	Disabled->SetEnabled(false);
	Disabled->SetEnabled(true);
	EXPECT(!Disabled->IsEnabled());
	for (auto* C : {Off.get(), Dev.get(), Disabled.get()})
	{
		H.Frames(*C, 400);
		C->Flush();
		C->Shutdown("quit");
	}
	EXPECT(H.Transport->InOrder.empty());
	EXPECT(H.Transport->Gets.empty());
}

TEST(AMeasureSaysGlitchlessIsOff)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 130);
	FValue Cut;
	Core->Measure(5, [&Cut](const FValue& R) { Cut = R; });
	H.Frames(*Core, 60);
	EXPECT(Cut.IsNull());
	Core->SetEnabled(false); // a measure going is answered at once: there are no more frames to measure
	EXPECT(Str(Cut, "error").find("Glitchless is off") != std::string::npos);
	FValue Later;
	Core->Measure(1, [&Later](const FValue& R) { Later = R; });
	EXPECT(Str(Later, "error").find("Glitchless is off") != std::string::npos);
	Core->SetEnabled(true);
	FValue On;
	Core->Measure(1, [&On](const FValue& R) { On = R; });
	H.Frames(*Core, 62);
	EXPECT_EQ(On.Find("frames")->AsInt(), 60); // from the next frame
}

TEST(AListenServersOwnSessionFollowsItsHostsSwitch)
{
	FHarness H;
	H.Transport->Takes();
	auto Server = H.NewCore();
	Server->Role = ERole::Server;
	Server->Init(FHarness::Options());
	auto Ticks = [&H, &Server](int N) {
		for (int I = 0; I < N; I++)
		{
			H.Now += 33.4;
			FFrameCost C;
			C.Game = 12;
			Server->Frame(33.4, C);
		}
	};
	Ticks(30);
	Server->Flush();
	const std::string First = Server->GetSessionId();
	H.Transport->Status = 0;
	Ticks(30);
	Server->Flush();
	EXPECT(Exists(H.Dir + "/outbox.json"));
	const size_t Before = H.Transport->InOrder.size();
	H.Transport->Status = 202;

	Server->SetEnabled(false, false); // the host turned it off: its own session goes quiet too
	EXPECT(!Exists(H.Dir + "/enabled")); // the host's choice is saved in the host's folder, not here
	EXPECT(!Exists(H.Dir + "/outbox.json"));
	Ticks(30);
	Server->EndSession("closed"); // and stopped hosting while it was off
	EXPECT(Server->IsEnded());
	Server->SetEnabled(true, false);
	EXPECT(Server->IsEnded()); // not hosting: nothing starts again (and the Unreal side feeds an ended session nothing)
	EXPECT_EQ(H.Transport->InOrder.size(), Before);
	Server->StartNewSession(); // hosting again
	Ticks(30);
	Server->Flush();
	const std::vector<std::pair<std::string, FValue>> Sent = BySession(H);
	EXPECT(Sent.size() > 0 && Sent.back().first != First);
	for (const auto& E : Sent)
	{
		EXPECT(Str(E.second, "type") != "session_end"); // neither session ended out loud
	}
	EXPECT_EQ(OfType(H.AllEvents(), "session_start").size(), 2u);
}
