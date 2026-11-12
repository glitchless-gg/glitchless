// The web page layer (Private/Web/GlitchlessWebPage.cpp) and the core's page rules, in a real page: built with em++
// as UE 5.9 builds a Wasm game (wasm64 lowered to 32-bit memory, pthreads, PROXY_TO_PTHREAD, so main() runs on a
// Worker as the game thread does), and played by unreal/test/web.mjs in Chromium. It does what the plugin's web
// transport does: reads the page, asks the server's health, sends batches and answers the page's events. Each step
// prints a "GLT <what> <json>" line the test reads from the console.
//
// The page's address carries the intake (?intake=http://127.0.0.1:port) and the session (?session=s_...).
//
// With ?player=install or ?player=anonymous it is the game instead: the plugin's core (Private/Core) on this page,
// sending through it and keeping the install ID and the player's choice with it, as GlitchlessWeb.cpp sets a web
// build up. Its Saved folder is /saved, in memory here, so a reload takes every file with it, as it does wherever
// Unreal keeps a web build's Saved in memory. ?act=off or ?act=on is the player's switch, two seconds in;
// ?act=sneak sends by the page layer alone, as a game thread that hasn't read the choice would.

#include "GlitchlessCore.h"
#include "GlitchlessPage.h"
#include "GlitchlessWebPage.h"

#include <chrono>
#include <cstdio>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

using namespace Glitchless;

namespace
{
	std::string Param(const std::string& Search, const std::string& Key)
	{
		const std::string S = Search.size() > 0 && Search[0] == '?' ? Search.substr(1) : Search;
		size_t From = 0;
		while (From <= S.size())
		{
			size_t Amp = S.find('&', From);
			if (Amp == std::string::npos)
			{
				Amp = S.size();
			}
			const std::string Pair = S.substr(From, Amp - From);
			const size_t Eq = Pair.find('=');
			if (Eq != std::string::npos && Pair.substr(0, Eq) == Key)
			{
				return Pair.substr(Eq + 1);
			}
			From = Amp + 1;
		}
		return std::string();
	}

	long long NowMs()
	{
		return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
	}

	void Print(const char* What, const FValue& V)
	{
		std::printf("GLT %s %s\n", What, V.Serialize().c_str());
		std::fflush(stdout);
	}

	// A batch as the plugin sends it (SPEC §2), with one custom event named Name.
	std::string Batch(const std::string& Session, int Number, const std::string& Name)
	{
		FValue Event = FValue::Object();
		Event.Set("type", "custom");
		Event.Set("ts", static_cast<long long>(NowMs()));
		Event.Set("name", Name);
		FValue B = FValue::Object();
		B.Set("sdk", "glitchless-unreal/0.5.6");
		B.Set("service", "glitchless-unreal-webtest");
		B.Set("version", "1");
		B.Set("env", "dev");
		B.Set("session_id", Session);
		B.Set("batch_id", "b_webtest" + std::to_string(1000000 + Number));
		B.Set("player_id", FValue());
		B.Set("events", FValue::List({Event}));
		return B.Serialize();
	}

	// Sends a batch and, unless bWait is false, waits for its answer as the plugin's SendNow does.
	int Send(const std::string& Intake, const std::string& Session, int Number, const std::string& Name, bool bWait)
	{
		const std::string Body = Batch(Session, Number, Name);
		GlitchlessWebPage::FRequest* R = GlitchlessWebPage::Post(Intake + "/v1/intake?token=gl_pub_dev", reinterpret_cast<const uint8_t*>(Body.data()), Body.size(), "text/plain", 10000);
		const int Status = bWait ? GlitchlessWebPage::Wait(R, 5000) : -1;
		GlitchlessWebPage::Release(R);
		return Status;
	}
}

// ───────────── the game: the core on the page ─────────────

namespace
{
	const char* SaveDir = "/saved";
	const char* KeptUnder = "glitchless:/saved/"; // as GlitchlessWeb.cpp names what the page keeps: by the Saved folder

	/** The plugin's web transport (GlitchlessWeb.cpp's FWebTransport) without Unreal: one batch on its way at a time,
	 * answered from Poll. */
	class FPageTransport : public ITransport
	{
	public:
		~FPageTransport() override
		{
			GlitchlessWebPage::Release(Current);
			GlitchlessWebPage::Release(Health);
		}

		void Send(const std::string& Url, std::vector<uint8_t> Body, const std::string& ContentType, std::function<void(int64_t)> Done) override
		{
			GlitchlessWebPage::Release(Current);
			Current = GlitchlessWebPage::Post(Url, Body.data(), Body.size(), ContentType, 10000);
			CurrentDone = std::move(Done);
		}

		void Get(const std::string& Url, std::function<void(int64_t, const std::string&)> Done) override
		{
			GlitchlessWebPage::Release(Health);
			Health = GlitchlessWebPage::Get(Url, 10000);
			HealthDone = std::move(Done);
		}

		int64_t SendNow(const std::string& Url, const std::vector<uint8_t>& Body, const std::string& ContentType, int TimeoutMs) override
		{
			GlitchlessWebPage::FRequest* R = GlitchlessWebPage::Post(Url, Body.data(), Body.size(), ContentType, TimeoutMs);
			const int Status = GlitchlessWebPage::Wait(R, TimeoutMs);
			GlitchlessWebPage::Release(R);
			return Status > 0 ? Status : 0;
		}

		void Abort() override
		{
			GlitchlessWebPage::Release(Current);
			Current = nullptr;
			CurrentDone = nullptr;
		}

		void Poll()
		{
			if (Current && GlitchlessWebPage::Status(Current) != -1)
			{
				const int64_t Status = GlitchlessWebPage::Status(Current);
				std::function<void(int64_t)> Done = std::move(CurrentDone);
				GlitchlessWebPage::Release(Current);
				Current = nullptr;
				CurrentDone = nullptr;
				if (Done)
				{
					Done(Status);
				}
			}
			if (Health && GlitchlessWebPage::Status(Health) != -1)
			{
				const int64_t Status = GlitchlessWebPage::Status(Health);
				const std::string Answer = GlitchlessWebPage::Text(Health);
				std::function<void(int64_t, const std::string&)> Done = std::move(HealthDone);
				GlitchlessWebPage::Release(Health);
				Health = nullptr;
				HealthDone = nullptr;
				if (Done)
				{
					Done(Status, Answer);
				}
			}
		}

	private:
		GlitchlessWebPage::FRequest* Current = nullptr;
		std::function<void(int64_t)> CurrentDone;
		GlitchlessWebPage::FRequest* Health = nullptr;
		std::function<void(int64_t, const std::string&)> HealthDone;
	};

	bool Exists(const std::string& Path)
	{
		std::FILE* F = std::fopen(Path.c_str(), "rb");
		if (F)
		{
			std::fclose(F);
		}
		return F != nullptr;
	}

	// A game thread that hasn't read the choice: the page layer alone, asked to send. While the page keeps "off",
	// nothing may leave it: not a batch, not the health question, not the parting batch as the page goes.
	void Sneak(const std::string& Intake)
	{
		FValue Out = FValue::Object();
		Out.Set("post", Send(Intake, "s_websneak00000000", 1, "sneak", true));
		GlitchlessWebPage::FRequest* Health = GlitchlessWebPage::Get(Intake + "/v1/health", 3000);
		Out.Set("get", GlitchlessWebPage::Wait(Health, 3000));
		GlitchlessWebPage::Release(Health);
		const std::string Parting = Batch("s_websneak00000000", 2, "sneak_leaving");
		GlitchlessWebPage::SetParting(Intake + "/v1/intake?token=gl_pub_dev", reinterpret_cast<const uint8_t*>(Parting.data()), Parting.size());
		usleep(300000); // the parting batch reaches the page
		Print("played", Out);
		usleep(60000000);
	}

	void PlayTheGame(const Page::FFacts& Facts, const std::string& Intake, const std::string& Privacy, const std::string& Act)
	{
		mkdir(SaveDir, 0777);
		FValue Began = FValue::Object();
		// Saved as the page found it: nothing, on a first load and on every reload (it is in memory here).
		Began.Set("saved_before", Exists(std::string(SaveDir) + "/player_id") || Exists(std::string(SaveDir) + "/enabled"));

		const std::shared_ptr<FPageTransport> Transport = std::make_shared<FPageTransport>();
		FCore Core;
		Core.Clock = []() { return static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()) / 1000.0; };
		Core.UnixNow = []() { return static_cast<int64_t>(NowMs()); };
		Core.Transport = Transport;
		Core.SaveDir = SaveDir;
		Core.Page.Read = [](const std::string& Name, std::string& Out) { return GlitchlessWebPage::Kept(Name, Out, 2000); };
		Core.Page.Write = [](const std::string& Name, const std::string& Text) { GlitchlessWebPage::Keep(Name, Text); };
		Core.Page.Remove = [](const std::string& Name) { GlitchlessWebPage::Forget(Name); };
		Core.Device = [Facts](bool bDetailed) { return Page::Device(Facts, bDetailed); };
		Core.Address = Page::Address(Facts);
		Core.AppVersion = "1";
		// The player's choice first, before anything is kept, as the plugin's runtime reads it.
		Core.ReadChoice();
		FOptions Options;
		Options.Service = "glitchless-unreal-webtest";
		Options.Intake = Intake;
		Options.Privacy = Privacy == "install" ? EPrivacy::Install : EPrivacy::Anonymous;
		Options.FlushIntervalSeconds = 1;
		Core.Init(Options);
		Began.Set("player_id", Core.GetPlayerId());
		Began.Set("off", Core.IsTurnedOff());
		Began.Set("saved_after", Exists(std::string(SaveDir) + "/player_id"));
		Print("game", Began);

		FFrameCost Cost;
		Cost.Game = 4;
		Cost.Render = 3;
		const long long Start = NowMs();
		int Step = 0;
		for (long long End = Start + 60000; NowMs() < End;)
		{
			Core.Frame(16.0, Cost);
			Transport->Poll();
			const long long At = NowMs() - Start;
			if (Step == 0 && At >= 1000)
			{
				Step = 1;
				Core.Track("before_act");
				Core.Flush();
			}
			else if (Step == 1 && At >= 2000)
			{
				Step = 2;
				if (Act == "off")
				{
					Core.SetEnabled(false);
				}
				else if (Act == "on")
				{
					Core.SetEnabled(true);
				}
				Core.Track("after_act");
				Core.Flush();
			}
			else if (Step == 2 && At >= 3500)
			{
				Step = 3;
				FValue Played = FValue::Object();
				Played.Set("player_id", Core.GetPlayerId());
				Played.Set("off", Core.IsTurnedOff());
				Played.Set("session_id", Core.GetSessionId());
				Print("played", Played);
			}
			usleep(16000); // a frame
		}
	}
}

int main()
{
	FValue Started = FValue::Object();
	Started.Set("web", GlitchlessWebPage::IsWeb());
	Print("start", Started);

	GlitchlessWebPage::Start(KeptUnder);
	const std::string Json = GlitchlessWebPage::Facts(5000);
	Page::FFacts Facts;
	FValue Read = FValue::Object();
	Read.Set("parsed", Page::ParseFacts(Json, Facts));
	Read.Set("device", Page::Device(Facts, true));
	Read.Set("local", Page::IsLocal(Facts.Protocol, Facts.Host));
	Read.Set("flags", FValue::Strings(Page::Flags(Facts.Search)));
	Read.Set("address", Page::Address(Facts));
	Print("facts", Read);

	const std::string Intake = Param(Facts.Search, "intake");
	const std::string Session = Param(Facts.Search, "session");
	if (!Param(Facts.Search, "player").empty())
	{
		if (Param(Facts.Search, "act") == "sneak")
		{
			Sneak(Intake);
		}
		else
		{
			PlayTheGame(Facts, Intake, Param(Facts.Search, "player"), Param(Facts.Search, "act"));
		}
		return 0;
	}

	// The server's health, once a session, as the plugin asks it.
	GlitchlessWebPage::FRequest* Health = GlitchlessWebPage::Get(Intake + "/v1/health", 5000);
	FValue H = FValue::Object();
	H.Set("status", GlitchlessWebPage::Wait(Health, 5000));
	H.Set("text", GlitchlessWebPage::Text(Health));
	GlitchlessWebPage::Release(Health);
	Print("health", H);

	// A batch, waited on; one released while on its way (the plugin's Abort), which must still land; a large one,
	// over keepalive's budget; and one to an address with nothing behind it.
	FValue Sent = FValue::Object();
	Sent.Set("first", Send(Intake, Session, 1, "first", true));
	Send(Intake, Session, 2, "released", false);
	const std::string Big(200000, 'x');
	Sent.Set("large", Send(Intake, Session, 3, Big, true));
	GlitchlessWebPage::FRequest* Nowhere = GlitchlessWebPage::Post("http://127.0.0.1:9/v1/intake?token=gl_pub_dev", reinterpret_cast<const uint8_t*>("{}"), 2, "text/plain", 2000);
	Sent.Set("nowhere", GlitchlessWebPage::Wait(Nowhere, 4000));
	GlitchlessWebPage::Release(Nowhere);
	Print("sent", Sent);

	// The page's events, answered as the plugin does: hidden sends what waits, plays on, and hands the page its
	// parting batch (the session's end), which the page sends from its own pagehide handler; shown takes it back.
	int Number = 10;
	for (long long End = NowMs() + 60000; NowMs() < End;)
	{
		for (int Event : GlitchlessWebPage::TakeEvents())
		{
			FValue E = FValue::Object();
			E.Set("event", Event);
			if (Event == GlitchlessWebPage::Hidden)
			{
				E.Set("status", Send(Intake, Session, Number++, "hidden", true));
				const std::string Parting = Batch(Session, Number++, "leaving");
				GlitchlessWebPage::SetParting(Intake + "/v1/intake?token=gl_pub_dev", reinterpret_cast<const uint8_t*>(Parting.data()), Parting.size());
			}
			else if (Event == GlitchlessWebPage::Shown)
			{
				GlitchlessWebPage::ClearParting();
			}
			Print("event", E);
		}
		usleep(16000); // a frame
	}
	return 0;
}
