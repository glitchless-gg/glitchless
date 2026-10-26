// The genre additions (docs/design/genre-coverage.md A4 to A9): booleans and lists in attributes, counts,
// properties, groups, level attributes and zones, the connection and its disconnects, and a server's own session.

#include "CoreHarness.h"
#include "GlitchlessRules.h"

#include <initializer_list>
#include <string>
#include <utility>

using namespace Glitchless;

namespace
{
	FValue Obj(std::initializer_list<std::pair<const char*, FValue>> Pairs)
	{
		FValue O = FValue::Object();
		for (const auto& P : Pairs)
		{
			O.Set(P.first, P.second);
		}
		return O;
	}

	// Every event sent, with the session it went under.
	std::vector<std::pair<std::string, FValue>> BySession(const std::vector<std::string>& Bodies)
	{
		std::vector<std::pair<std::string, FValue>> Out;
		for (const std::string& B : Bodies)
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

	std::string Str(const FValue& E, const char* Key)
	{
		const FValue* V = E.Find(Key);
		return V && V->IsString() ? V->AsString() : "";
	}

	FValue ServerInfo()
	{
		return Obj({{"tick_hz", 30}, {"max_players", 100}, {"build", "dedicated"}, {"host", Obj({{"os", "Linux"}, {"cores", 16}, {"memory_gb", 32}})}});
	}

	// Seconds of server ticks at 30 Hz, each doing WorkMs of work (the one at SlowAt takes 50 ms), with a sample a second.
	void ServerTicks(FHarness& H, FCore& Core, int Seconds, double WorkMs = 12, int SlowAt = 5)
	{
		for (int S = 0; S < Seconds; S++)
		{
			FServerSample Sample;
			Sample.Players = 60 + S;
			Sample.TickHz = 30;
			Sample.InKbps = 400;
			Sample.OutKbps = 1200;
			Sample.CpuPct = 80;
			Sample.MemMb = 2048;
			Sample.NetObjects = 900;
			Sample.RttMs = {30, 40, 250};
			Core.ServerSample(Sample);
			for (int T = 0; T < 30; T++)
			{
				H.Now += 33.4;
				FFrameCost C;
				C.Game = T == SlowAt ? 50 : WorkMs;
				Core.Frame(33.4, C);
			}
		}
	}
}

TEST(GroupIdsAreHashedWithSha1AsEveryEngineHashesThem)
{
	EXPECT_EQ(Rules::Sha1Hex(""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
	EXPECT_EQ(Rules::Sha1Hex("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
	EXPECT_EQ(Rules::Sha1Hex(std::string(64, 'x')), "bb2fa3ee7afb9f54c6dfb5d021f14b1ffe40c163");
	std::string Accents;
	for (int I = 0; I < 40; I++)
	{
		Accents += "\xc3\xa9";
	}
	EXPECT_EQ(Rules::Sha1Hex(Accents), "bf062a63a7d2c435d92958148cee870333de681d");
	// The vector the Unity SDK builds to: the service lowercased, ":", then the game's own ID.
	EXPECT_EQ(Rules::HashGroupId("Zoomies", "m_8f2c91d04ab7"), "h_d8a6ac978165726ac21a722b");
	EXPECT(Rules::IsGroupId("m_8f2c91d04ab7"));
	EXPECT(Rules::IsGroupId("lobby:eu-west.0001"));
	EXPECT(!Rules::IsGroupId("short"));
	EXPECT(!Rules::IsGroupId("match 0001"));
	EXPECT(!Rules::IsGroupId(std::string(65, 'a')));
}

TEST(EventsCarryBooleansAndLists)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	FValue Attrs = FValue::Object();
	Attrs.Set("won", true);
	Attrs.Set("deck", FValue::Strings({"hog_rider", "fireball"}));
	Attrs.Set("duration_s", 184.0);
	Core->Track("battle_end", Attrs);
	Core->Flush();
	const FValue E = OfType(H.Transport->Events(), "custom").at(0);
	EXPECT_EQ(E.Find("attrs")->Serialize(), R"({"won":true,"deck":["hog_rider","fireball"],"duration_s":184})");
}

TEST(CountsAreAddedUpOnTheDeviceAndSentOnceAWindow)
{
	FHarness H;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("nmd_ghoa");
	for (int I = 0; I < 37; I++)
	{
		Core->Count("kill", Obj({{"monster", "elite"}}));
	}
	Core->Count("kill", Obj({{"monster", "boss"}}), 2);
	Core->Count("gold", Obj({{"source", "loot"}, {"amount", 35.0}}), 3); // each call's numbers as given, whatever its N
	Core->Count("gold", Obj({{"source", "loot"}, {"amount", 15.0}}));
	// Four strings and booleans say which; four numbers are summed; a list says nothing.
	Core->Count("hit", Obj({{"a", "1"}, {"b", true}, {"c", "3"}, {"d", "4"}, {"e", "5"}, {"deck", FValue::Strings({"x"})}, {"n1", 1.0}, {"n2", 2.0}, {"n3", 3.0}, {"n4", 4.0}, {"n5", 5.0}}));
	Core->Count("nothing", FValue(), 0);
	H.Frames(*Core, 10);
	Core->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	EXPECT(OfType(Events, "custom").empty()); // counts are never custom events
	const std::vector<FValue> Sent = OfType(Events, "counts");
	EXPECT_EQ(Sent.size(), 1u);
	const FValue& C = Sent.at(0);
	EXPECT_EQ(Str(C, "level"), "nmd_ghoa");
	EXPECT_EQ(C.Find("dropped")->AsInt(), 0);
	EXPECT(C.Find("duration_s")->AsNumber() > 0);
	EXPECT(C.Find("ts")->AsInt() > 0);
	const FValue& List = *C.Find("counts");
	EXPECT_EQ(List.Size(), 4u);
	EXPECT_EQ(Str(List[0], "name"), "kill");
	EXPECT_EQ(List[0].Find("attrs")->Serialize(), R"({"monster":"elite"})");
	EXPECT_EQ(List[0].Find("n")->AsInt(), 37);
	EXPECT(!List[0].Has("sums"));
	EXPECT(List[0].Find("first_ts")->AsInt() >= C.Find("ts")->AsInt());
	EXPECT_EQ(List[1].Find("n")->AsInt(), 2);
	EXPECT_EQ(List[2].Find("n")->AsInt(), 4);
	EXPECT_EQ(List[2].Find("attrs")->Serialize(), R"({"source":"loot"})");
	EXPECT_EQ(List[2].Find("sums")->Serialize(), R"({"amount":50})");
	EXPECT_EQ(List[3].Find("attrs")->Serialize(), R"({"a":"1","b":true,"c":"3","d":"4"})");
	EXPECT_EQ(List[3].Find("sums")->Serialize(), R"({"n1":1,"n2":2,"n3":3,"n4":4})");
	// The next window starts again from nothing.
	H.Frames(*Core, 10);
	Core->Flush();
	EXPECT_EQ(OfType(H.Transport->Events(), "counts").size(), 1u);
}

TEST(AWindowCountsSixtyFourThingsAtMost)
{
	FHarness H;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	for (int I = 0; I < 64; I++)
	{
		Core->Count("item_" + std::to_string(I));
	}
	Core->Count("late_name", FValue(), 5); // a new name: dropped, and counted as such
	Core->Count("item_3", Obj({{"rarity", "rare"}})); // a new group of a name already counted: under (other)
	Core->Count("item_3", Obj({{"rarity", "epic"}}), 2);
	Core->Count("item_3"); // its own group is still there
	Core->Flush();
	const FValue C = OfType(H.Transport->Events(), "counts").at(0);
	const FValue& List = *C.Find("counts");
	EXPECT_EQ(List.Size(), 65u);
	EXPECT_EQ(C.Find("dropped")->AsInt(), 5);
	EXPECT_EQ(List[3].Find("n")->AsInt(), 2);
	EXPECT_EQ(Str(List[64], "name"), "item_3");
	EXPECT_EQ(List[64].Find("attrs")->Serialize(), R"j({"rarity":"(other)"})j");
	EXPECT_EQ(List[64].Find("n")->AsInt(), 3);
	Core->Count("late_name");
	Core->Flush();
	const std::vector<FValue> Both = OfType(H.Transport->Events(), "counts");
	EXPECT_EQ(Str((*Both.at(1).Find("counts"))[0], "name"), "late_name");
	EXPECT_EQ(Both.at(1).Find("dropped")->AsInt(), 0);
}

TEST(CountsWaitForTheServerToSayItTakesThem)
{
	FHarness H;
	H.Transport->HoldGets = true;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	EXPECT_EQ(H.Transport->Gets.size(), 1u);
	EXPECT_EQ(H.Transport->Gets.at(0), "http://localhost:7777/v1/health");
	Core->Count("kill");
	Core->Flush();
	EXPECT(OfType(H.Transport->Events(), "counts").empty());
	EXPECT_EQ(H.Transport->Gets.size(), 1u); // asked once, still waiting
	H.Transport->AnswerGets();
	EXPECT(Core->HasFeature("counts") && Core->HasFeature("server_mode"));
	Core->Flush();
	const std::vector<FValue> Sent = OfType(H.Transport->Events(), "counts");
	EXPECT_EQ(Sent.size(), 1u);
	EXPECT_EQ(Str((*Sent.at(0).Find("counts"))[0], "name"), "kill");
}

TEST(AnOlderServerGetsNoCountsAndTheGameOneWarning)
{
	FHarness H;
	H.Transport->HealthStatus = 0; // offline first: asked again at each flush
	auto Core = H.NewCore();
	std::vector<std::string> Logged;
	Core->Log = [&Logged](const std::string& S) { Logged.push_back(S); };
	Core->Init(FHarness::Options());
	Core->Count("kill");
	Core->Flush();
	EXPECT_EQ(H.Transport->Gets.size(), 2u);
	EXPECT(!Core->FeaturesKnown());
	H.Transport->HealthStatus = 200;
	H.Transport->HealthBody = R"({"ok":true,"store":"file"})"; // a server from before features
	Core->Count("kill");
	Core->Flush();
	Core->Count("kill");
	Core->Flush();
	EXPECT(Core->FeaturesKnown());
	EXPECT(OfType(H.Transport->Events(), "counts").empty());
	int Warnings = 0;
	for (const std::string& L : Logged)
	{
		Warnings += L.find("doesn't take counts") != std::string::npos ? 1 : 0;
	}
	EXPECT_EQ(Warnings, 1);
	// Features may come as an object of booleans too.
	FHarness H2;
	H2.Transport->HealthStatus = 200;
	H2.Transport->HealthBody = R"({"ok":true,"features":{"counts":true,"server_mode":false}})";
	auto Core2 = H2.NewCore();
	Core2->Init(FHarness::Options());
	EXPECT(Core2->HasFeature("counts") && !Core2->HasFeature("server_mode"));
}

TEST(PropertiesGoWithTheSessionStartThenAsChanges)
{
	FHarness H;
	auto Core = H.NewCore();
	FOptions O = FHarness::Options();
	O.Properties = Obj({{"mode", "squads"}});
	Core->SetProperty("rank", FValue("gold")); // before Init: kept for the session's start
	Core->Init(O);
	Core->Flush();
	const FValue Start = OfType(H.Transport->Events(), "session_start").at(0);
	EXPECT_EQ(Start.Find("props")->Serialize(), R"({"rank":"gold","mode":"squads"})");
	EXPECT(OfType(H.Transport->Events(), "props").empty());
	Core->SetProperty("rank", FValue("platinum"));
	Core->SetProperty("rank", FValue("diamond"));
	Core->SetProperty("mode", FValue());
	Core->SetProperty("region", FValue("eu-west"));
	Core->SetProperty("region", FValue("eu-west"));
	Core->SetProperty("level_band", FValue(30.0));
	Core->Flush();
	std::vector<FValue> Changes = OfType(H.Transport->Events(), "props");
	EXPECT_EQ(Changes.size(), 1u);
	EXPECT_EQ(Changes.at(0).Find("props")->Serialize(), R"({"rank":"diamond","mode":null,"region":"eu-west","level_band":30})");
	Core->SetProperty("rank", FValue("diamond")); // no change, no event
	Core->SetProperty("unset", FValue()); // removing what was never set
	Core->Flush();
	EXPECT_EQ(OfType(H.Transport->Events(), "props").size(), 1u);
	// A session without properties says nothing of them.
	FHarness H2;
	auto Core2 = H2.NewCore();
	Core2->Init(FHarness::Options());
	Core2->Flush();
	EXPECT(!OfType(H2.Transport->Events(), "session_start").at(0).Has("props"));
}

TEST(PropertiesThatCouldSayWhoSomeoneIsAreDropped)
{
	for (const std::string& K : std::vector<std::string>{"email", "user_id", "steam_id", "name", "age", "level", "platform", "zone", "match", "run", "steam_branch", "Rank", "2fast", "with space", std::string(33, 'a'), ""})
	{
		if (Rules::PropertyKeyProblem(K).empty())
		{
			GlitchlessTest::Fail("key kept: " + K, __FILE__, __LINE__);
		}
	}
	for (const std::string K : {"rank", "level_band", "class", "trophy_band", "region", "input"})
	{
		EXPECT_EQ(Rules::PropertyKeyProblem(K), "");
	}
	for (const std::string V : {"someone@example.com", "https://x.gg/p", "www.example.com", "+44 20 7946 0958", "(555) 123-4567", "555-123-4567", "1234567", "player 76561198000000000",
			 "d1b2c3a4-5e6f-4a7b-8c9d-0e1f2a3b4c5d", "deadbeefcafef00d", "aGVsbG8Xd29ybGQ1"})
	{
		if (!Rules::LooksIdentifying(V))
		{
			GlitchlessTest::Fail("value kept: " + V, __FILE__, __LINE__);
		}
	}
	for (const std::string V : {"3000-3499", "summer_2026", "diamond", "30-39", "eu-west", "Arena 7", "squads", "ranked_solo_queue"})
	{
		if (Rules::LooksIdentifying(V))
		{
			GlitchlessTest::Fail("value dropped: " + V, __FILE__, __LINE__);
		}
	}
	FValue Out;
	std::string Why;
	EXPECT(!Rules::PropertyValue(FValue(1.5), Out, Why));
	EXPECT(!Rules::PropertyValue(FValue(2000000), Out, Why));
	EXPECT(!Rules::PropertyValue(FValue(""), Out, Why));
	EXPECT(!Rules::PropertyValue(FValue::Strings({"a"}), Out, Why));
	EXPECT(Rules::PropertyValue(FValue(42.0), Out, Why) && Out.Serialize() == "42");
	EXPECT(Rules::PropertyValue(FValue(true), Out, Why) && Out.Serialize() == "true");
	EXPECT(Rules::PropertyValue(FValue("  diamond  "), Out, Why) && Out.AsString() == "diamond");
	EXPECT(Rules::PropertyValue(FValue(std::string(80, 'z')), Out, Why) && Out.AsString().size() == 64);

	// In the core: dropped with one warning a key in a development build, and twelve keys a session.
	FHarness H;
	auto Core = H.NewCore();
	std::vector<std::string> Logged;
	Core->Log = [&Logged](const std::string& S) { Logged.push_back(S); };
	Core->Init(FHarness::Options());
	Core->SetProperty("email", FValue("a@b.co"));
	Core->SetProperty("email", FValue("c@d.co"));
	Core->SetProperty("rank", FValue("someone@example.com"));
	for (int I = 0; I < 13; I++)
	{
		Core->SetProperty("p" + std::to_string(I), FValue(I));
	}
	Core->SetProperty("p0", FValue()); // a removal leaves its key counted
	Core->SetProperty("p12", FValue(12));
	Core->Flush();
	const FValue Start = OfType(H.Transport->Events(), "session_start").at(0);
	EXPECT_EQ(Start.Find("props")->Size(), 11u); // p1 to p11
	EXPECT(!Start.Find("props")->Has("p12"));
	EXPECT_EQ(Logged.size(), 3u); // email, rank, p12
}

TEST(MatchAndPartyIdsMarkEveryEventAndGoHashed)
{
	FHarness H;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 10); // a window before the match
	const std::string Sent = Core->SetGroup("match", "m_8f2c91d04ab7", Obj({{"mode", "squads"}, {"players", 100}}));
	EXPECT_EQ(Sent, Rules::HashGroupId("fetch", "m_8f2c91d04ab7"));
	EXPECT_EQ(Core->SetGroup("match", "m_8f2c91d04ab7"), Sent); // the same match again: nothing new
	Core->Track("landed", Obj({{"where", "docks"}}));
	Core->Count("shot");
	H.Frames(*Core, 10);
	Core->ClearGroup("match");
	Core->Track("menu");
	H.Frames(*Core, 10);
	Core->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	const std::vector<FValue> Groups = OfType(Events, "group");
	EXPECT_EQ(Groups.size(), 2u);
	EXPECT_EQ(Str(Groups.at(0), "kind"), "match");
	EXPECT_EQ(Str(Groups.at(0), "id"), Sent);
	EXPECT_EQ(Groups.at(0).Find("attrs")->Serialize(), R"({"mode":"squads","players":100})");
	EXPECT(Groups.at(1).Find("id")->IsNull());
	for (const FValue& E : Events)
	{
		const std::string T = Str(E, "type");
		if (T == "custom")
		{
			EXPECT_EQ(Str(E, "match"), Str(E, "name") == "landed" ? Sent : "");
		}
	}
	const std::vector<FValue> Windows = OfType(Events, "frame_window");
	EXPECT_EQ(Windows.size(), 3u); // before, during and after: a window never spans two matches
	EXPECT(!Windows.at(0).Has("match"));
	EXPECT_EQ(Str(Windows.at(1), "match"), Sent);
	EXPECT(!Windows.at(2).Has("match"));
	EXPECT_EQ(Str(OfType(Events, "counts").at(0), "match"), Sent);
	// IDs the server couldn't have made, and kinds there aren't, are dropped.
	EXPECT_EQ(Core->SetGroup("match", "has space!"), "");
	EXPECT_EQ(Core->SetGroup("match", "short"), "");
	EXPECT_EQ(Core->SetGroup("guild", "guild-0001"), "");
	EXPECT_EQ(Core->GetGroup("match"), "");
	// Sent as they are when the game asks, to look them up in its own server logs.
	FHarness H2;
	auto Core2 = H2.NewCore();
	FOptions O = FHarness::Options();
	O.HashGroupIds = false;
	Core2->Init(O);
	EXPECT_EQ(Core2->SetGroup("party", "p_12345678"), "p_12345678");
	EXPECT_EQ(Core2->GetGroup("party"), "p_12345678");
}

TEST(RunsAreTheSdksAndResumeOnlyOutsideAnonymousMode)
{
	{
		FHarness H;
		auto Core = H.NewCore();
		Core->Init(FHarness::Options());
		const std::string Run = Core->SetGroup("run", "");
		EXPECT(Text::StartsWith(Run, "r_") && Run.size() == 14);
		const std::string Again = Core->SetGroup("run", "r_saved000001"); // anonymous: nothing ties two launches
		EXPECT(Again != "r_saved000001" && Text::StartsWith(Again, "r_"));
		Core->Flush();
		const std::vector<FValue> Groups = OfType(H.Transport->Events(), "group");
		EXPECT(!Groups.at(0).Has("resumed"));
		EXPECT(Groups.at(1).Find("resumed")->AsBool());
		EXPECT_EQ(Str(Groups.at(1), "id"), Again);
	}
	{
		FHarness H;
		auto Core = H.NewCore();
		Core->Init(FHarness::Options(EPrivacy::Install));
		EXPECT_EQ(Core->SetGroup("run", "r_saved000001"), "r_saved000001"); // never hashed: the SDK made it
		Core->Flush();
		EXPECT(OfType(H.Transport->Events(), "group").at(0).Find("resumed")->AsBool());
	}
}

TEST(ZonesStampEventsAndWindowsAsLevelsDo)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->SetZone("westfall");
	H.Frames(*Core, 10);
	Core->Track("level_up");
	Core->SetZone("westfall"); // the same zone: the window goes on
	H.Frames(*Core, 10);
	Core->SetZone("elwynn");
	H.Frames(*Core, 10);
	Core->SetZone("");
	Core->Track("menu");
	Core->Flush();
	const std::vector<FValue> Events = H.Transport->Events();
	const std::vector<FValue> Windows = OfType(Events, "frame_window");
	EXPECT_EQ(Windows.size(), 2u);
	EXPECT_EQ(Str(Windows.at(0), "zone"), "westfall");
	EXPECT_EQ(Windows.at(0).Find("frames")->AsInt(), 20);
	EXPECT_EQ(Str(Windows.at(1), "zone"), "elwynn");
	const std::vector<FValue> Custom = OfType(Events, "custom");
	EXPECT_EQ(Str(Custom.at(0), "zone"), "westfall");
	EXPECT(!Custom.at(1).Has("zone"));
	EXPECT(OfType(Events, "zone").empty());
	EXPECT(!Core->GetZone());
}

TEST(ALevelStartSaysWhatTheAttemptIs)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("nmd_ghoa", Obj({{"tier", "pit_80"}, {"party_size", 3}, {"build", FValue::Strings({"blood_surge", "corpse_explosion"})}}));
	Core->LevelFail("nmd_ghoa", "timer");
	Core->LevelStart("nmd_ghoa");
	Core->Flush();
	const std::vector<FValue> Starts = OfType(H.Transport->Events(), "level_start");
	EXPECT_EQ(Starts.at(0).Find("attrs")->Serialize(), R"({"tier":"pit_80","party_size":3,"build":["blood_surge","corpse_explosion"]})");
	EXPECT(!Starts.at(1).Has("attrs"));
	EXPECT(!OfType(H.Transport->Events(), "level_fail").at(0).Has("attrs")); // the server pairs the outcome with its start
}

TEST(EachWindowCarriesTheConnection)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	H.Frames(*Core, 60);
	Core->Flush(); // a window before connecting: no net
	for (int I = 0; I < 4; I++)
	{
		FNetSample S;
		S.RttMs = 40 + I * 10;
		S.LossPct = 1;
		S.JitterMs = 3;
		S.InKbps = 90;
		S.OutKbps = 30;
		S.Transport = "unreal";
		S.Link = "wifi";
		Core->NetSample(S);
		S.RttMs = 900; // a second sample in the same second is left out
		Core->NetSample(S);
		H.Frames(*Core, 60);
	}
	Core->Flush();
	const std::vector<FValue> Windows = OfType(H.Transport->Events(), "frame_window");
	EXPECT(!Windows.at(0).Has("net"));
	const FValue& Net = *Windows.at(1).Find("net");
	EXPECT_EQ(Net.Find("samples")->AsInt(), 4);
	EXPECT_EQ(Net.Find("rtt")->Find("a")->AsNumber(), 0.05);
	EXPECT_EQ(Net.Find("rtt")->Find("n")->AsInt(), 4);
	EXPECT_EQ(Net.Find("rtt_max")->AsNumber(), 70.0);
	EXPECT_NEAR(Net.Find("rtt_p50")->AsNumber(), 50, 3);
	EXPECT_NEAR(Net.Find("rtt_p95")->AsNumber(), 60, 3); // the sketch's rank of four samples
	EXPECT_EQ(Net.Find("loss_pct")->AsNumber(), 1.0);
	EXPECT_EQ(Net.Find("jitter_ms")->AsNumber(), 3.0);
	EXPECT_EQ(Net.Find("in_kbps")->AsNumber(), 90.0);
	EXPECT_EQ(Net.Find("out_kbps")->AsNumber(), 30.0);
	EXPECT_EQ(Str(Net, "transport"), "unreal");
	EXPECT_EQ(Str(Net, "link"), "wifi");
	EXPECT(!Net.Find("host")->AsBool());
	// Still connected in the next window, with nothing sampled yet: net, with no numbers.
	H.Frames(*Core, 10);
	Core->Flush();
	const FValue Quiet = OfType(H.Transport->Events(), "frame_window").at(2);
	EXPECT_EQ(Quiet.Find("net")->Find("samples")->AsInt(), 0);
	EXPECT(Quiet.Find("net")->Find("rtt_p95")->IsNull());
	// Leaving the match the normal way is no disconnect, and the windows after it have no net.
	H.Frames(*Core, 10);
	Core->NetEnded();
	Core->Flush();
	H.Frames(*Core, 10);
	Core->Flush();
	EXPECT(OfType(H.Transport->Events(), "disconnect").empty());
	EXPECT(!OfType(H.Transport->Events(), "frame_window").back().Has("net"));
}

TEST(TheHostOfAListenServerHasNoRoundTrip)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	FNetSample S;
	S.RttMs = 0;
	S.Host = true;
	S.Transport = "unreal";
	Core->NetSample(S);
	H.Frames(*Core, 30);
	Core->Flush();
	const FValue Window = OfType(H.Transport->Events(), "frame_window").at(0);
	const FValue& Net = *Window.Find("net");
	EXPECT(Net.Find("host")->AsBool());
	EXPECT_EQ(Net.Find("rtt_p95")->AsNumber(), 0.0);
	EXPECT(Net.Find("link")->IsNull());
}

TEST(ADisconnectEndsTheAttemptAndAReconnectTakesItBack)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->LevelStart("rift");
	for (int I = 0; I < 3; I++)
	{
		FNetSample S;
		S.RttMs = 200;
		S.LossPct = 12;
		S.Transport = "unreal";
		Core->NetSample(S);
		H.Frames(*Core, 60);
	}
	Core->Disconnect("timeout");
	Core->Disconnect("connection_lost"); // the same failure, said twice
	H.Now += 9000;
	FNetSample Back;
	Back.RttMs = 50;
	Core->NetSample(Back); // connected again
	Core->LevelComplete("rift");
	Core->Shutdown("quit");
	const std::vector<FValue> Events = H.AllEvents();
	const std::vector<FValue> Lost = OfType(Events, "disconnect");
	EXPECT_EQ(Lost.size(), 1u);
	EXPECT_EQ(Str(Lost.at(0), "reason"), "timeout");
	EXPECT_NEAR(Lost.at(0).Find("connected_s")->AsNumber(), 3.0, 0.1);
	EXPECT_NEAR(Lost.at(0).Find("rtt_p95")->AsNumber(), 200, 10);
	EXPECT_EQ(Lost.at(0).Find("loss_pct")->AsNumber(), 12.0);
	const std::vector<FValue> Abandons = OfType(Events, "level_abandon");
	EXPECT_EQ(Abandons.size(), 1u); // played on after the reconnect and completed: no abandon at the quit
	EXPECT_EQ(Str(Abandons.at(0), "reason"), "disconnect");
	EXPECT_EQ(Str(Abandons.at(0), "level"), "rift");
	EXPECT(OfType(Events, "level_fail").empty()); // never a fail
	const std::vector<FValue> Again = OfType(Events, "reconnect");
	EXPECT_EQ(Again.size(), 1u);
	EXPECT_NEAR(Again.at(0).Find("after_s")->AsNumber(), 9.0, 0.1);
	EXPECT_EQ(OfType(Events, "level_complete").size(), 1u);
}

TEST(AFailedConnectionIsADisconnectAndTwentyIsTheMost)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->Disconnect("failed_to_connect");
	H.Now += 6000;
	Core->Disconnect("checksum"); // a word Glitchless doesn't know is "other"
	for (int I = 0; I < 30; I++)
	{
		H.Now += 6000;
		Core->Reconnect();
		Core->Disconnect("timeout");
	}
	Core->Flush();
	const std::vector<FValue> Lost = OfType(H.Transport->Events(), "disconnect");
	EXPECT_EQ(Lost.size(), 20u);
	EXPECT_EQ(Str(Lost.at(0), "reason"), "failed_to_connect");
	EXPECT_EQ(Lost.at(0).Find("connected_s")->AsNumber(), 0.0);
	EXPECT(Lost.at(0).Find("rtt_p95")->IsNull());
	EXPECT_EQ(Str(Lost.at(1), "reason"), "other");
}

TEST(AServerSendsItsOwnSessionWithServerWindows)
{
	FHarness H;
	H.Transport->Takes();
	auto Core = H.NewCore({"-glitchless-region=eu-west"});
	Core->Role = ERole::Server;
	Core->ServerInfo = ServerInfo;
	FOptions O = FHarness::Options(EPrivacy::Install);
	O.ServerRegion = "us-east"; // every server's setting: the command line's wins
	Core->Init(O);
	Core->OnMapLoaded("Island", 1);
	Core->SetGroup("match", "match-0001");
	ServerTicks(H, *Core, 4);
	Core->Track("match_start", Obj({{"players", 64}}));
	Core->Count("shot", Obj({{"weapon", "ar"}}), 3);
	Core->Flush();
	const FValue Env = H.Envelope();
	EXPECT_EQ(Str(Env, "role"), "server");
	EXPECT_EQ(Str(Env, "service"), "fetch"); // the game's own: intake files it under fetch.server
	EXPECT(Env.Find("player_id")->IsNull()); // a server has no player, in every mode
	const std::vector<FValue> Events = H.Transport->Events();
	const FValue Start = OfType(Events, "session_start").at(0);
	EXPECT_EQ(Str(Start, "session_type"), "user");
	EXPECT_EQ(Start.Find("server")->Serialize(), R"({"tick_hz":30,"max_players":100,"build":"dedicated","host":{"os":"Linux","cores":16,"memory_gb":32},"region":"eu-west"})");
	EXPECT_EQ(Start.Find("device")->Serialize(), R"({"browser":"Unreal","browser_version":"5.8.0","os":"macOS"})");
	for (const char* T : {"frame_window", "hitch", "load", "pos"})
	{
		EXPECT(OfType(Events, T).empty());
	}
	const FValue W = OfType(Events, "server_window").at(0);
	EXPECT_EQ(Str(W, "level"), "Island");
	EXPECT_EQ(Str(W, "match"), Rules::HashGroupId("fetch", "match-0001"));
	EXPECT_EQ(W.Find("ticks")->AsInt(), 120);
	EXPECT_NEAR(W.Find("tick_hz")->AsNumber(), 30, 1);
	EXPECT_EQ(W.Find("late")->AsInt(), 4); // one 50 ms tick a second, over the 33.3 ms a 30 Hz tick has
	EXPECT_NEAR(W.Find("tick_p50")->AsNumber(), 12, 0.5);
	EXPECT_EQ(W.Find("tick_max")->AsNumber(), 50.0);
	EXPECT_EQ(W.Find("tick")->Find("n")->AsInt(), 120);
	EXPECT_EQ(W.Find("players")->AsInt(), 63);
	EXPECT_EQ(W.Find("players_max")->AsInt(), 63);
	EXPECT_EQ(W.Find("net_objects")->AsInt(), 900);
	EXPECT_EQ(W.Find("in_kbps")->AsNumber(), 400.0);
	EXPECT_EQ(W.Find("out_kbps")->AsNumber(), 1200.0);
	EXPECT_EQ(W.Find("cpu_pct")->AsNumber(), 80.0);
	EXPECT_EQ(W.Find("mem_mb")->AsNumber(), 2048.0);
	EXPECT_EQ(W.Find("rtt_p95")->AsNumber(), 250.0);
	EXPECT_EQ(Str(OfType(Events, "custom").at(0), "name"), "match_start");
	// A window with no sample in it (cut short as the server quits) has the last sample's numbers.
	for (int T = 0; T < 3; T++)
	{
		H.Now += 33.4;
		FFrameCost C;
		C.Game = 12;
		Core->Frame(33.4, C);
	}
	Core->Flush();
	const FValue Short = OfType(H.Transport->Events(), "server_window").back();
	EXPECT_EQ(Short.Find("ticks")->AsInt(), 3);
	EXPECT_EQ(Short.Find("cpu_pct")->AsNumber(), 80.0);
	EXPECT_EQ(Short.Find("rtt_p95")->AsNumber(), 250.0);
	EXPECT_EQ(OfType(Events, "counts").size(), 1u);
	// The map a server hosts is never abandoned: quitting ends the session only.
	Core->Shutdown("quit");
	EXPECT(OfType(H.AllEvents(), "level_abandon").empty());
	EXPECT_EQ(Str(OfType(H.AllEvents(), "session_end").at(0), "reason"), "quit");
}

TEST(AServerSendsNothingUntilTheGlitchlessServerTakesServerSessions)
{
	FHarness H;
	H.Transport->HoldGets = true;
	H.Transport->Takes(R"(["counts","props","groups","net"])");
	auto Core = H.NewCore();
	std::vector<std::string> Logged;
	Core->Log = [&Logged](const std::string& S) { Logged.push_back(S); };
	Core->Role = ERole::Server;
	Core->Init(FHarness::Options());
	ServerTicks(H, *Core, 2);
	Core->Flush();
	EXPECT(H.Transport->Sent.empty()); // waiting for the answer, in the outbox
	EXPECT(Exists(H.Dir + "/outbox.json"));
	H.Transport->AnswerGets();
	ServerTicks(H, *Core, 2);
	Core->Flush();
	Core->Shutdown("quit");
	EXPECT(H.Transport->InOrder.empty()); // an older server would file it among the players'
	EXPECT(!Exists(H.Dir + "/outbox.json"));
	EXPECT(!Core->IsEnabled());
	EXPECT_EQ(Logged.size(), 1u);

	// The same with a server that takes them: what waited goes.
	FHarness H2;
	H2.Transport->HoldGets = true;
	H2.Transport->Takes();
	auto Core2 = H2.NewCore();
	Core2->Role = ERole::Server;
	Core2->Init(FHarness::Options());
	ServerTicks(H2, *Core2, 2);
	Core2->Flush();
	EXPECT(H2.Transport->Sent.empty());
	H2.Transport->AnswerGets();
	EXPECT_EQ(OfType(H2.Transport->Events(), "server_window").size(), 1u);
}

TEST(AServerSessionIsCutEverySixHoursAndCanLastOneMatch)
{
	FHarness H;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Role = ERole::Server;
	Core->Init(FHarness::Options());
	Core->SetProperty("mode", FValue("squads"));
	Core->SetGroup("match", "match-0001");
	ServerTicks(H, *Core, 2);
	Core->Flush();
	const std::string First = H.Envelope().Find("session_id")->AsString();
	H.Now += 6 * 3600 * 1000.0;
	ServerTicks(H, *Core, 2);
	Core->Flush();
	const std::vector<std::pair<std::string, FValue>> Sent = BySession(H.Transport->InOrder);
	bool Cut = false, Again = false, Props = false;
	for (const auto& E : Sent)
	{
		Cut = Cut || (E.first == First && Str(E.second, "type") == "session_end" && Str(E.second, "reason") == "max_duration");
		Again = Again || (E.first != First && Str(E.second, "type") == "group" && Str(E.second, "kind") == "match");
		Props = Props || (E.first != First && Str(E.second, "type") == "session_start" && E.second.Find("props")->Serialize() == R"({"mode":"squads"})");
	}
	EXPECT(Cut && Again && Props);

	// A session per match, for a server that hosts one at a time.
	FHarness H2;
	H2.Transport->Takes();
	auto Core2 = H2.NewCore();
	Core2->Role = ERole::Server;
	FOptions O = FHarness::Options();
	O.ServerSessionPerMatch = true;
	Core2->Init(O);
	Core2->SetGroup("match", "match-0001");
	ServerTicks(H2, *Core2, 1);
	const std::string Before = Core2->GetSessionId();
	Core2->ClearGroup("match");
	EXPECT(Core2->GetSessionId() != Before);
	bool Ended = false;
	for (const auto& E : BySession(H2.Transport->InOrder))
	{
		Ended = Ended || (E.first == Before && Str(E.second, "type") == "session_end" && Str(E.second, "reason") == "match_end");
	}
	EXPECT(Ended);
}

TEST(ANewSessionAfterTheBackgroundKeepsItsPropertiesAndGroups)
{
	FHarness H;
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->SetProperty("rank", FValue("gold"));
	Core->SetGroup("party", "party-0001");
	Core->Flush();
	const std::string First = Core->GetSessionId();
	Core->OnBackground();
	H.Now += 400000;
	Core->OnForeground();
	Core->Track("back");
	Core->Flush();
	EXPECT(Core->GetSessionId() != First);
	bool Props = false, Group = false, Marked = false;
	for (const auto& E : BySession(H.Transport->InOrder))
	{
		if (E.first == First)
		{
			continue;
		}
		Props = Props || (Str(E.second, "type") == "session_start" && E.second.Find("props")->Serialize() == R"({"rank":"gold"})");
		Group = Group || (Str(E.second, "type") == "group" && Str(E.second, "kind") == "party");
		Marked = Marked || (Str(E.second, "name") == "back" && Str(E.second, "party") == Rules::HashGroupId("fetch", "party-0001"));
	}
	EXPECT(Props && Group && Marked);
}

TEST(TrackingAStreamWarnsOnceToCountIt)
{
	FHarness H;
	auto Core = H.NewCore();
	std::vector<std::string> Logged;
	Core->Log = [&Logged](const std::string& S) { Logged.push_back(S); };
	Core->Init(FHarness::Options());
	for (int I = 0; I < 50; I++)
	{
		H.Now += 10;
		Core->Track("shot");
	}
	EXPECT_EQ(Logged.size(), 1u);
	EXPECT(Logged.at(0).find("Count(\"shot\")") != std::string::npos);
	// A shipping build says nothing.
	FHarness H2;
	auto Core2 = H2.NewCore();
	Core2->IsDevelopmentBuild = false;
	std::vector<std::string> Quiet;
	Core2->Log = [&Quiet](const std::string& S) { Quiet.push_back(S); };
	Core2->Init(FHarness::Options());
	for (int I = 0; I < 50; I++)
	{
		H2.Now += 10;
		Core2->Track("shot");
	}
	EXPECT(Quiet.empty());
}

TEST(LiveSaysTheGroupsZoneAndProperties)
{
	FHarness H;
	H.Transport->Takes();
	auto Core = H.NewCore();
	Core->Init(FHarness::Options());
	Core->SetZone("docks");
	Core->SetProperty("mode", FValue("squads"));
	Core->SetGroup("party", "party-0001");
	const FValue L = Core->Live();
	EXPECT_EQ(Str(L, "role"), "player");
	EXPECT_EQ(Str(L, "zone"), "docks");
	EXPECT_EQ(L.Find("properties")->Serialize(), R"({"mode":"squads"})");
	EXPECT_EQ(Str(*L.Find("groups"), "party"), Rules::HashGroupId("fetch", "party-0001"));
	EXPECT_EQ(L.Find("features")->Size(), 5u);
}
