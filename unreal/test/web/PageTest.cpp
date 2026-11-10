// The web page layer (Private/Web/GlitchlessWebPage.cpp) and the core's page rules, in a real page: built with em++
// as UE 5.9 builds a Wasm game (wasm64 lowered to 32-bit memory, pthreads, PROXY_TO_PTHREAD, so main() runs on a
// Worker as the game thread does), and played by unreal/test/web.mjs in Chromium. It does what the plugin's web
// transport does: reads the page, asks the server's health, sends batches and answers the page's events. Each step
// prints a "GLT <what> <json>" line the test reads from the console.
//
// The page's address carries the intake (?intake=http://127.0.0.1:port) and the session (?session=s_...).

#include "GlitchlessPage.h"
#include "GlitchlessWebPage.h"

#include <chrono>
#include <cstdio>
#include <string>
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
		B.Set("sdk", "glitchless-unreal/0.5.3");
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

int main()
{
	FValue Started = FValue::Object();
	Started.Set("web", GlitchlessWebPage::IsWeb());
	Print("start", Started);

	GlitchlessWebPage::Start();
	const std::string Json = GlitchlessWebPage::Facts(5000);
	Page::FFacts Facts;
	FValue Read = FValue::Object();
	Read.Set("parsed", Page::ParseFacts(Json, Facts));
	Read.Set("device", Page::Device(Facts, true));
	Read.Set("local", Page::IsLocal(Facts.Protocol, Facts.Host));
	Read.Set("flags", FValue::Strings(Page::Flags(Facts.Search)));
	Print("facts", Read);

	const std::string Intake = Param(Facts.Search, "intake");
	const std::string Session = Param(Facts.Search, "session");

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
