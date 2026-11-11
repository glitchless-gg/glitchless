// What a web build's page keeps (the core's Page; Private/Web/GlitchlessWebPage's Kept, Keep and Forget in a real
// page): the install ID and the player's choice, as well as in Saved, because a web build's Saved folder doesn't
// always outlast the page (GlitchlessCore.h's Page says where). Here the page is a map, and a reload is a new core on
// an emptied folder. unreal/test/web.mjs reloads a real page, and web-game.mjs a real Unreal one.

#include "CoreHarness.h"

#include <filesystem>
#include <map>
#include <string>

using namespace Glitchless;

namespace
{
	using FKept = std::map<std::string, std::string>;

	// A core whose page keeps what it is given in Kept.
	std::unique_ptr<FCore> OnPage(FHarness& H, FKept& Kept)
	{
		std::unique_ptr<FCore> Core = H.NewCore();
		Core->Page.Read = [&Kept](const std::string& Name, std::string& Out) {
			const auto It = Kept.find(Name);
			if (It == Kept.end())
			{
				return false;
			}
			Out = It->second;
			return true;
		};
		Core->Page.Write = [&Kept](const std::string& Name, const std::string& Text) { Kept[Name] = Text; };
		Core->Page.Remove = [&Kept](const std::string& Name) { Kept.erase(Name); };
		return Core;
	}

	// The page reloads where Saved is in memory: every file is gone, and the page's own storage is all that is left.
	void Reload(FHarness& H)
	{
		std::error_code Error;
		std::filesystem::remove_all(H.Dir, Error);
		std::filesystem::create_directories(H.Dir, Error);
		H.Transport->Sent.clear();
		H.Transport->SentNow.clear();
		H.Transport->InOrder.clear();
		H.Transport->Gets.clear();
	}

	std::string PlayerOf(const FHarness& H)
	{
		const FValue Envelope = H.Envelope();
		const FValue* Id = Envelope.Find("player_id");
		return Id && Id->IsString() ? Id->AsString() : "";
	}
}

TEST(PageKeepsTheInstallIdWhenSavedIsGone)
{
	FHarness H;
	FKept Kept;
	auto First = OnPage(H, Kept);
	First->Init(FHarness::Options(EPrivacy::Install));
	First->Flush();
	const std::string Player = First->GetPlayerId();
	EXPECT(Text::StartsWith(Player, "p_"));
	EXPECT_EQ(PlayerOf(H), Player);
	EXPECT_EQ(Kept["player_id"], Player);
	EXPECT_EQ(ReadAll(H.Dir + "/player_id"), Player); // in Saved too, where Saved lasts

	Reload(H);
	auto Second = OnPage(H, Kept);
	Second->Init(FHarness::Options(EPrivacy::Install));
	Second->Flush();
	EXPECT_EQ(Second->GetPlayerId(), Player); // one player, not a new one for each page load
	EXPECT_EQ(PlayerOf(H), Player);
	EXPECT(Second->GetSessionId() != First->GetSessionId());

	Reload(H);
	auto Full = OnPage(H, Kept);
	Full->Init(FHarness::Options(EPrivacy::Full));
	EXPECT_EQ(Full->GetPlayerId(), Player);
	EXPECT_EQ(Kept.size(), 1u); // the ID and nothing else: no session ID, no outbox
}

TEST(PageTakesOverAnIdSavedBeforeItKeptAny)
{
	FHarness H;
	// A build from before the page kept anything, on a browser where Saved lasts.
	auto Before = H.NewCore();
	Before->Init(FHarness::Options(EPrivacy::Install));
	const std::string Player = Before->GetPlayerId();

	FKept Kept;
	auto Now = OnPage(H, Kept);
	Now->Init(FHarness::Options(EPrivacy::Install));
	EXPECT_EQ(Now->GetPlayerId(), Player); // the same player after the update
	EXPECT_EQ(Kept["player_id"], Player);

	// What the page keeps isn't an ID: a new one, kept in both places.
	Kept["player_id"] = "not an id";
	auto Next = OnPage(H, Kept);
	Next->Init(FHarness::Options(EPrivacy::Install));
	EXPECT(Text::StartsWith(Next->GetPlayerId(), "p_"));
	EXPECT_EQ(Kept["player_id"], Next->GetPlayerId());
	EXPECT_EQ(ReadAll(H.Dir + "/player_id"), Next->GetPlayerId());
}

TEST(AnonymousModeKeepsNoIdInThePage)
{
	FHarness H;
	FKept Kept;
	auto Anon = OnPage(H, Kept);
	Anon->Init(FHarness::Options());
	H.Frames(*Anon, 30);
	Anon->Track("bone_collected");
	Anon->Flush();
	EXPECT(H.Envelope().Find("player_id")->IsNull());
	EXPECT(Kept.empty()); // no ID of any kind, and no choice until the game asks
	H.Transport->Status = 0;
	Anon->Track("offline");
	Anon->Shutdown("quit");
	EXPECT(Exists(H.Dir + "/outbox.json"));
	EXPECT(Kept.empty()); // the outbox is Saved's alone

	// An install-mode build of the game left an ID with the page: anonymous mode forgets it there too.
	Reload(H);
	H.Transport->Status = 202;
	Kept["player_id"] = "p_abcdefghijkl";
	auto Later = OnPage(H, Kept);
	Later->Init(FHarness::Options());
	Later->Flush();
	EXPECT(H.Envelope().Find("player_id")->IsNull());
	EXPECT(Kept.empty());
	EXPECT(!Exists(H.Dir + "/player_id"));
}

TEST(OffStaysOffWhenSavedIsGone)
{
	FHarness H;
	FKept Kept;
	auto First = OnPage(H, Kept);
	First->ReadChoice();
	First->Init(FHarness::Options(EPrivacy::Install));
	H.Frames(*First, 30);
	First->Flush();
	const std::string Player = First->GetPlayerId();
	First->SetEnabled(false);
	EXPECT_EQ(Kept["enabled"], "off");
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "off");

	// The page reloads, and Saved went with it: nothing is measured, kept or sent from the first frame.
	Reload(H);
	H.Transport->Takes();
	auto Second = OnPage(H, Kept);
	Second->ReadChoice();
	EXPECT(Second->IsTurnedOff());
	Second->OnMapLoaded("Arena", 1);
	H.Frames(*Second, 30);
	EXPECT(Second->Queued().empty());
	Second->Init(FHarness::Options(EPrivacy::Install));
	EXPECT(!Second->IsEnabled());
	H.Frames(*Second, 400);
	Second->Track("while_off");
	Second->ReportError("error", "Planted error while off", "");
	Second->Flush();
	Second->Shutdown("quit");
	EXPECT(H.Transport->InOrder.empty());
	EXPECT(H.Transport->Gets.empty());
	EXPECT(!Exists(H.Dir + "/outbox.json"));
	EXPECT_EQ(Kept["enabled"], "off");
	EXPECT_EQ(Kept["player_id"], Player); // the ID stays while it is off, so turning it on again is still one player

	// On again, in a later page load: kept as "on", and the same player.
	Reload(H);
	auto Third = OnPage(H, Kept);
	Third->ReadChoice();
	Third->Init(FHarness::Options(EPrivacy::Install));
	Third->SetEnabled(true);
	EXPECT_EQ(Kept["enabled"], "on");
	H.Frames(*Third, 30);
	Third->Flush();
	EXPECT_EQ(PlayerOf(H), Player);

	Reload(H);
	auto Fourth = OnPage(H, Kept);
	Fourth->ReadChoice(true); // a game that asks first has its answer: on
	EXPECT(!Fourth->IsTurnedOff());
}

TEST(OffStaysOffInAnonymousModeAndTheChoiceIsAllThePageKeeps)
{
	FHarness H;
	FKept Kept;
	auto First = OnPage(H, Kept);
	First->ReadChoice();
	First->Init(FHarness::Options());
	First->SetEnabled(false);
	EXPECT_EQ(Kept.size(), 1u);
	EXPECT_EQ(Kept["enabled"], "off"); // "off" and nothing else: the same on every device that chose it

	Reload(H);
	auto Second = OnPage(H, Kept);
	Second->ReadChoice();
	Second->Init(FHarness::Options());
	H.Frames(*Second, 400);
	Second->Track("while_off");
	Second->Flush();
	EXPECT(H.Transport->InOrder.empty());
	EXPECT_EQ(Kept.size(), 1u);
}

TEST(ACoreWithoutAPageKeepsToItsFiles)
{
	// Everywhere but the web: nothing changes.
	FHarness H;
	auto First = H.NewCore();
	First->ReadChoice();
	First->Init(FHarness::Options(EPrivacy::Install));
	First->SetEnabled(false);
	EXPECT_EQ(ReadAll(H.Dir + "/enabled"), "off");
	EXPECT(Text::StartsWith(ReadAll(H.Dir + "/player_id"), "p_"));
	auto Second = H.NewCore();
	Second->ReadChoice();
	EXPECT(Second->IsTurnedOff());
}
