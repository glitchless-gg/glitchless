// The outbox file is written by a job on another thread in a game (Background, which the Unreal side gives its thread
// pool), so no frame waits on the disk: one job at a time, the newest file waiting for it; quitting, the background and
// a crash write at once; and neither a write at once nor the off switch can be undone by older text a job still holds.
// BeforeWrite holds the job, so each test sees a write on its way. Here Background is a thread of its own.

#include "CoreHarness.h"

#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

using namespace Glitchless;
using namespace GlitchlessTestHarness;

namespace
{
	void OnAThread(std::function<void()> Job) { std::thread(std::move(Job)).detach(); }

	// Holds the job at BeforeWrite until Open; Entered says it got there.
	struct FGate
	{
		std::mutex M;
		std::condition_variable Cv;
		bool Opened = false;
		int Arrived = 0;

		std::function<void()> Hold()
		{
			return [this]() {
				std::unique_lock<std::mutex> Lock(M);
				Arrived++;
				Cv.notify_all();
				Cv.wait_for(Lock, std::chrono::seconds(10), [this]() { return Opened; });
			};
		}

		bool Entered()
		{
			std::unique_lock<std::mutex> Lock(M);
			return Cv.wait_for(Lock, std::chrono::seconds(10), [this]() { return Arrived > 0; });
		}

		void Open()
		{
			std::lock_guard<std::mutex> Lock(M);
			Opened = true;
			Cv.notify_all();
		}
	};

	std::unique_ptr<FCore> WriterCore(FHarness& H)
	{
		H.Transport->Status = 0; // offline: every batch stays in the outbox
		std::unique_ptr<FCore> C = H.NewCore();
		C->Background = OnAThread;
		C->Init(FHarness::Options());
		return C;
	}

	void Pickup(FCore& C, const std::string& Item)
	{
		FValue A = FValue::Object();
		A.Set("item", Item);
		C.Track("pickup", std::move(A));
	}

	int SavedEvents(const std::string& Text)
	{
		FValue Saved;
		int N = 0;
		if (FValue::Parse(Text, Saved) && Saved.Find("batches"))
		{
			for (const FValue& B : Saved.Find("batches")->GetItems())
			{
				N += static_cast<int>(B.Find("events")->GetItems().size());
			}
		}
		return N;
	}
}

TEST(WorkerAFlushHandsTheFileToAJobAndTheNewestWaits)
{
	FHarness H;
	std::unique_ptr<FCore> C = WriterCore(H);
	FGate G;
	C->BeforeWrite = G.Hold();
	Pickup(*C, "coin");
	C->Flush();
	EXPECT(G.Entered());
	EXPECT(C->SaveOnItsWay()); // a flush hands the write to the job
	EXPECT(!Exists(H.Dir + "/outbox.json")); // and returns before the file is written
	Pickup(*C, "gem");
	C->Flush(); // waits for the job, as the newest file
	G.Open();
	C->WaitForSave();
	const std::string Text = ReadAll(H.Dir + "/outbox.json");
	EXPECT(Text.find("coin") != std::string::npos);
	EXPECT(Text.find("gem") != std::string::npos); // the job writes the newest file next
	EXPECT_EQ(SavedEvents(Text), C->OutboxEvents()); // every batch saved with all its events
	EXPECT(!Exists(H.Dir + "/outbox.json.tmp"));
}

TEST(WorkerTurningItOffDropsAWriteOnItsWay)
{
	FHarness H;
	std::unique_ptr<FCore> C = WriterCore(H);
	Pickup(*C, "coin");
	C->Flush();
	C->WaitForSave();
	EXPECT(Exists(H.Dir + "/outbox.json"));
	FGate G;
	C->BeforeWrite = G.Hold();
	Pickup(*C, "key");
	C->Flush();
	EXPECT(G.Entered());
	C->SetEnabled(false);
	EXPECT(!Exists(H.Dir + "/outbox.json")); // turning it off removes the file at once
	G.Open();
	C->WaitForSave();
	EXPECT(!Exists(H.Dir + "/outbox.json")); // and the write that was on its way doesn't put it back
}

TEST(WorkerQuittingWritesAtOnceAndAnOlderWriteCannotUndoIt)
{
	FHarness H;
	std::unique_ptr<FCore> C = WriterCore(H);
	FGate G;
	C->BeforeWrite = G.Hold();
	Pickup(*C, "coin");
	C->Flush();
	EXPECT(G.Entered()); // the job holds a file without the session's end
	C->Shutdown("quit");
	const std::string Text = ReadAll(H.Dir + "/outbox.json");
	EXPECT(Text.find("\"session_end\"") != std::string::npos); // written before Shutdown returns
	G.Open();
	C->WaitForSave();
	EXPECT_EQ(ReadAll(H.Dir + "/outbox.json"), Text); // the older file the job held is dropped
}

TEST(WorkerACrashWritesAtOnceAndAnOlderWriteCannotUndoIt)
{
	FHarness H;
	std::unique_ptr<FCore> C = WriterCore(H);
	FGate G;
	C->BeforeWrite = G.Hold();
	Pickup(*C, "coin");
	C->Flush();
	EXPECT(G.Entered());
	C->ReportCrash("crash", "EXCEPTION_ACCESS_VIOLATION reading address 0x0", "AFetchPawn::Tick");
	const std::string Text = ReadAll(H.Dir + "/outbox.json");
	EXPECT(Text.find("\"reason\":\"crash\"") != std::string::npos); // the crash is on disk before it returns
	G.Open();
	C->WaitForSave();
	EXPECT_EQ(ReadAll(H.Dir + "/outbox.json"), Text);
}

TEST(WorkerTheBackgroundWritesAtOnce)
{
	FHarness H;
	std::unique_ptr<FCore> C = WriterCore(H);
	std::mutex M;
	bool OnJob = false;
	C->BeforeWrite = [&M, &OnJob]() {
		std::lock_guard<std::mutex> Lock(M);
		OnJob = true;
	};
	Pickup(*C, "coin");
	C->OnBackground();
	EXPECT(!C->SaveOnItsWay()); // no job: the OS may stop the game before one finishes
	EXPECT(ReadAll(H.Dir + "/outbox.json").find("\"reason\":\"background\"") != std::string::npos);
	{
		std::lock_guard<std::mutex> Lock(M);
		EXPECT(!OnJob);
	}
	C->OnForeground();
	Pickup(*C, "gem");
	C->Flush();
	C->WaitForSave();
	{
		std::lock_guard<std::mutex> Lock(M);
		EXPECT(OnJob); // back in the foreground, saves go to the job again
	}
	EXPECT(ReadAll(H.Dir + "/outbox.json").find("gem") != std::string::npos);
}
