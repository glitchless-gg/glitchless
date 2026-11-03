// A session cut in two by the outbox (SPEC §2 session_start.continued). In anonymous mode the outbox is saved without
// the session ID, so the next launch sends an earlier session's batches under a new one. When that session's first
// batch, with its session_start, went out before the game closed or crashed, the rest arrived with no session_start:
// the server took a test phone's leftovers, or its crash, for a player's session with no device. The outbox now keeps
// each session's session_start, which holds no ID, and the next launch sends it first, marked continued.

#include "CoreHarness.h"

#include <string>
#include <vector>

using namespace Glitchless;

namespace
{
	std::string Str(const FValue& E, const char* Key)
	{
		const FValue* V = E.Find(Key);
		return V && V->IsString() ? V->AsString() : "";
	}

	std::vector<FValue> Bodies(const std::vector<std::string>& Sent, size_t From = 0)
	{
		std::vector<FValue> Out;
		for (size_t I = From; I < Sent.size(); I++)
		{
			FValue Envelope;
			FValue::Parse(Sent[I], Envelope);
			Out.push_back(Envelope);
		}
		return Out;
	}

	const std::vector<FValue>& EventsOf(const FValue& Body) { return Body.Find("events")->GetItems(); }

	bool HasStart(const FValue& Body)
	{
		for (const FValue& E : EventsOf(Body))
		{
			if (Type(E) == "session_start")
			{
				return true;
			}
		}
		return false;
	}

	// The first body with an event of this type (and name, for custom events and errors' kinds), or -1.
	int Find(const std::vector<FValue>& Bodies, const std::string& T, const std::string& Name = "")
	{
		for (size_t I = 0; I < Bodies.size(); I++)
		{
			for (const FValue& E : EventsOf(Bodies[I]))
			{
				if (Type(E) == T && (Name.empty() || Str(E, "name") == Name || Str(E, "kind") == Name))
				{
					return static_cast<int>(I);
				}
			}
		}
		return -1;
	}

	FValue SavedOutbox(const FHarness& H)
	{
		FValue Saved;
		FValue::Parse(ReadAll(H.Dir + "/outbox.json"), Saved);
		return Saved;
	}

	// What the next launch sends of the session cut before it: the start sent again, alone in its own batch, marked
	// continued, with the session's own type and device, under the same new ID as the rest that follows it.
	void ExpectContinuedBefore(const std::vector<FValue>& Bodies, int Rest, const std::string& OldSid, const std::string& NewSid)
	{
		EXPECT(Rest > 0);
		if (Rest <= 0)
		{
			return;
		}
		const FValue& Again = Bodies[Rest - 1];
		EXPECT_EQ(EventsOf(Again).size(), static_cast<size_t>(1));
		const FValue& Start = EventsOf(Again).at(0);
		EXPECT_EQ(Type(Start), std::string("session_start"));
		EXPECT(Start.Find("continued") && Start.Find("continued")->AsBool());
		EXPECT_EQ(Str(Start, "session_type"), std::string("synthetic"));
		EXPECT_EQ(Str(*Start.Find("device"), "os"), std::string("macOS"));
		EXPECT_EQ(Str(Again, "session_id"), Str(Bodies[Rest], "session_id"));
		EXPECT(Str(Again, "session_id") != OldSid);
		EXPECT(Str(Again, "session_id") != NewSid);
		EXPECT(Str(Again, "batch_id") != Str(Bodies[Rest], "batch_id"));
		EXPECT(IsBatchId(Str(Again, "batch_id")));
	}
}

TEST(TheRestOfASessionWhoseFirstBatchWentGetsItsStartAgainFirst)
{
	FHarness H;
	auto First = H.NewCore({"-glitchless-synthetic"});
	First->Init(FHarness::Options());
	First->Track("bone_collected");
	First->Flush(); // the first batch goes, session_start in it
	EXPECT(HasStart(Bodies(H.Transport->Sent).at(0)));
	H.Transport->Status = 0; // then the network goes, and the game closes with the rest waiting
	First->Track("powerup");
	First->Shutdown("quit");
	const std::string File = ReadAll(H.Dir + "/outbox.json");
	const FValue Saved = SavedOutbox(H);
	for (const FValue& B : Saved.Find("batches")->GetItems())
	{
		EXPECT(!HasStart(B)); // the rest is saved without its session_start
	}
	const FValue* Starts = Saved.Find("starts");
	EXPECT(Starts && Starts->Size() == 1); // its session_start is saved beside it
	if (Starts && Starts->Size() == 1)
	{
		const FValue& Event = *Starts->GetItems()[0].Find("event");
		EXPECT_EQ(Type(Event), std::string("session_start"));
		EXPECT_EQ(Str(Event, "session_type"), std::string("synthetic"));
	}
	EXPECT(File.find(First->GetSessionId()) == std::string::npos); // and still no ID on disk
	EXPECT(File.find("\"sid\"") == std::string::npos);

	H.Transport->Status = 202;
	const size_t Before = H.Transport->Sent.size();
	H.Now += 60000; // a later launch: its session starts at a time of its own
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	const std::vector<FValue> Sent = Bodies(H.Transport->Sent, Before);
	ExpectContinuedBefore(Sent, Find(Sent, "custom", "powerup"), First->GetSessionId(), Second->GetSessionId());
	for (const FValue& B : Sent)
	{
		if (Str(B, "session_id") == Second->GetSessionId() && HasStart(B))
		{
			EXPECT(!EventsOf(B).at(0).Has("continued")); // this launch's own start isn't
			EXPECT_EQ(Str(EventsOf(B).at(0), "session_type"), std::string("user"));
		}
	}
	EXPECT(!Exists(H.Dir + "/outbox.json"));
}

TEST(ACrashSentOnTheNextLaunchComesWithItsSessionsStart)
{
	FHarness H;
	auto First = H.NewCore({"-glitchless-synthetic"});
	First->Init(FHarness::Options());
	H.Frames(*First, 200);
	First->Flush(); // the session's first batch went
	H.Frames(*First, 30);
	First->ReportCrash("crash", "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000028", "");
	const FValue Saved = SavedOutbox(H);
	EXPECT(Saved.Find("starts") && Saved.Find("starts")->Size() == 1);

	const size_t Before = H.Transport->Sent.size();
	H.Now += 60000; // a later launch: its session starts at a time of its own
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	const std::vector<FValue> Sent = Bodies(H.Transport->Sent, Before);
	const int Crash = Find(Sent, "error", "crash");
	ExpectContinuedBefore(Sent, Crash, First->GetSessionId(), Second->GetSessionId());
}

TEST(ASessionCutAgainOnTheNextLaunchStillGetsItsStart)
{
	FHarness H;
	auto First = H.NewCore({"-glitchless-synthetic"});
	First->Init(FHarness::Options());
	First->Flush(); // the first batch goes
	H.Transport->Status = 0;
	First->Track("powerup");
	First->Shutdown("quit");

	// The next launch sends the start again, then loses the network before the rest goes.
	H.Transport->Status = 202;
	H.Transport->Hold = true;
	H.Transport->AnswerOnWait = false;
	H.Now += 60000; // a later launch: its session starts at a time of its own
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	H.Frames(*Second, 1);
	EXPECT_EQ(H.Transport->Pending.size(), static_cast<size_t>(1));
	if (H.Transport->Pending.size() != 1)
	{
		return;
	}
	const FValue Held = Bodies(H.Transport->Sent).back();
	EXPECT(EventsOf(Held).at(0).Find("continued") != nullptr);
	auto Took = H.Transport->Pending[0];
	Took(202);
	EXPECT_EQ(H.Transport->Pending.size(), static_cast<size_t>(2)); // the rest, on its way
	auto Lost = H.Transport->Pending[1];
	Lost(0);
	H.Transport->Pending.clear();
	H.Transport->Hold = false;
	H.Transport->Status = 0;
	Second->Shutdown("quit");
	EXPECT(SavedOutbox(H).Find("starts") != nullptr); // the earlier session's start is saved again with the rest

	H.Transport->Status = 202;
	const size_t Before = H.Transport->Sent.size();
	H.Now += 60000; // a later launch: its session starts at a time of its own
	auto Third = H.NewCore();
	Third->Init(FHarness::Options());
	Third->Flush();
	const std::vector<FValue> Sent = Bodies(H.Transport->Sent, Before);
	const int Rest = Find(Sent, "custom", "powerup");
	ExpectContinuedBefore(Sent, Rest, Str(Held, "session_id"), Third->GetSessionId());
	EXPECT(Rest > 0 && Str(Sent[Rest], "session_id") != First->GetSessionId()); // a third ID: nothing on the device ties the launches
}

TEST(ASessionSavedWholeGetsNoStartAdded)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options());
	H.Transport->Status = 0; // nothing goes
	First->Track("bone_collected");
	First->Shutdown("quit");
	H.Transport->Status = 202;
	const size_t Before = H.Transport->Sent.size();
	H.Now += 60000; // a later launch: its session starts at a time of its own
	auto Second = H.NewCore();
	Second->Init(FHarness::Options());
	Second->Flush();
	int Starts = 0;
	for (const FValue& B : Bodies(H.Transport->Sent, Before))
	{
		for (const FValue& E : EventsOf(B))
		{
			if (Type(E) == "session_start" && Str(B, "session_id") != Second->GetSessionId())
			{
				Starts++;
				EXPECT(!E.Has("continued"));
			}
		}
	}
	EXPECT_EQ(Starts, 1); // its one session_start, from its own batch
}

TEST(InstallModeSavesNoStartsAndAddsNone)
{
	FHarness H;
	auto First = H.NewCore();
	First->Init(FHarness::Options(EPrivacy::Install));
	First->Flush(); // the first batch goes
	H.Transport->Status = 0;
	First->Track("powerup");
	First->Shutdown("quit");
	EXPECT(SavedOutbox(H).Find("starts") == nullptr); // the session ID is saved: the rest keeps its session
	H.Transport->Status = 202;
	const size_t Before = H.Transport->Sent.size();
	H.Now += 60000; // a later launch: its session starts at a time of its own
	auto Second = H.NewCore();
	Second->Init(FHarness::Options(EPrivacy::Install));
	Second->Flush();
	int Replayed = 0;
	for (const FValue& B : Bodies(H.Transport->Sent, Before))
	{
		if (Str(B, "session_id") == First->GetSessionId())
		{
			Replayed++;
			EXPECT(!HasStart(B)); // nothing added
		}
	}
	EXPECT(Replayed > 0);
}
