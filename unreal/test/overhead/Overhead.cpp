// What the Unreal plugin's core costs the game thread, measured. It plays the core frame by frame on a clock it
// moves itself (about 16.7 ms a frame, as at 60 fps), timing each FCore::Frame call, and sorts the frames into plain ones,
// the ones that closed a frame window (every 5 seconds) and the ones that flushed (every 15: the events become a
// batch, saved, gzipped and sent). Then the network goes away, batches pile up to the outbox's 4,000-event cap as on
// a phone with no signal, and the flushes then are timed, and quitting with it all waiting. Nothing leaves the
// machine: a stand-in transport answers at once, or holds every request once offline. The outbox is written with the
// core's own file calls (stdio, the same as a crash writes it) to a folder of its own, on a thread standing in for
// Unreal's thread pool. unreal/test/overhead.mjs builds
// it with Unreal's flags and runs it; the plugin README's "What it costs" quotes it.
//
// What it leaves out: the plugin's engine side reads Unreal's frame counters (GGameThreadTime and the like) and takes a
// lock around Frame, which this doesn't time, and the engine's own file layer, which the game uses in place of stdio.

#include "GlitchlessCore.h"

#include <zlib.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <filesystem>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using namespace Glitchless;

namespace
{
	class FStandIn : public ITransport
	{
	public:
		bool Online = true;
		std::vector<std::function<void(int64_t)>> Pending;

		void Send(const std::string&, std::vector<uint8_t>, const std::string&, std::function<void(int64_t)> Done) override
		{
			if (Online)
			{
				Done(202);
			}
			else
			{
				Pending.push_back(std::move(Done)); // never answered: as a request lost on a phone with no signal
			}
		}
		void Get(const std::string&, std::function<void(int64_t, const std::string&)> Done) override { Done(200, "{\"ok\":true,\"features\":[\"counts\",\"props\",\"groups\",\"net\"]}"); }
		int64_t SendNow(const std::string&, const std::vector<uint8_t>&, const std::string&, int) override { return Online ? 202 : 0; }
		void Abort() override {}
	};

	// A thread waiting for jobs, as Unreal's thread pool (AsyncTask) runs the plugin's Background.
	class FPool
	{
	public:
		FPool()
			: Thread([this]() {
				  for (;;)
				  {
					  std::function<void()> Job;
					  {
						  std::unique_lock<std::mutex> Lock(M);
						  Cv.wait(Lock, [this]() { return Stop || !Jobs.empty(); });
						  if (Jobs.empty())
						  {
							  return;
						  }
						  Job = std::move(Jobs.front());
						  Jobs.pop_front();
					  }
					  Job();
				  }
			  })
		{
		}
		~FPool()
		{
			{
				std::lock_guard<std::mutex> Lock(M);
				Stop = true;
			}
			Cv.notify_one();
			Thread.join();
		}
		void Run(std::function<void()> Job)
		{
			{
				std::lock_guard<std::mutex> Lock(M);
				Jobs.push_back(std::move(Job));
			}
			Cv.notify_one();
		}

	private:
		std::mutex M;
		std::condition_variable Cv;
		std::deque<std::function<void()>> Jobs;
		bool Stop = false;
		std::thread Thread;
	};

	// The plugin gzips with the engine's FCompression (zlib); this is zlib too.
	bool Gzip(const std::string& In, std::vector<uint8_t>& Out)
	{
		z_stream S = {};
		if (deflateInit2(&S, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK)
		{
			return false;
		}
		Out.resize(deflateBound(&S, static_cast<uLong>(In.size())) + 32);
		S.next_in = reinterpret_cast<Bytef*>(const_cast<char*>(In.data()));
		S.avail_in = static_cast<uInt>(In.size());
		S.next_out = Out.data();
		S.avail_out = static_cast<uInt>(Out.size());
		const bool Ok = deflate(&S, Z_FINISH) == Z_STREAM_END;
		Out.resize(S.total_out);
		deflateEnd(&S);
		return Ok;
	}

	double Us(std::chrono::steady_clock::duration D) { return std::chrono::duration<double, std::micro>(D).count(); }

	double Median(std::vector<double> V)
	{
		if (V.empty())
		{
			return 0;
		}
		std::sort(V.begin(), V.end());
		return V[V.size() / 2];
	}

	std::string List(const std::vector<double>& V)
	{
		std::string S = "[";
		for (size_t I = 0; I < V.size(); I++)
		{
			char Buf[32];
			std::snprintf(Buf, sizeof(Buf), "%s%.0f", I ? ", " : "", V[I]);
			S += Buf;
		}
		return S + "]";
	}
}

int main()
{
	std::error_code Error;
	const std::filesystem::path Dir = std::filesystem::temp_directory_path(Error) / ("glitchless-unreal-overhead-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
	std::filesystem::create_directories(Dir, Error);

	double Now = 1000;
	auto T = std::make_shared<FStandIn>();
	FPool Pool;
	FCore C;
	C.Clock = [&Now]() { return Now; };
	C.UnixNow = [&Now]() { return static_cast<int64_t>(1761000000000LL + static_cast<int64_t>(Now)); };
	C.Transport = T;
	C.SaveDir = Dir.generic_string();
	C.Gzip = Gzip;
	C.Background = [&Pool](std::function<void()> Job) { Pool.Run(std::move(Job)); };
	C.Device = [](bool) {
		FValue D = FValue::Object();
		D.Set("os", "macOS");
		D.Set("mobile", false);
		return D;
	};
	FOptions O;
	O.Service = "overhead";
	O.Version = "1.0.0";
	O.Env = "prod";
	O.Intake = "http://127.0.0.1:9";
	C.Init(O);
	C.LevelStart("level_1");

	FFrameCost Cost;
	Cost.Game = 6;
	Cost.Render = 5;
	Cost.Rhi = 4;
	Cost.Gpu = 7;
	Cost.Calls = 900;
	Cost.Triangles = 400000;
	Cost.PsoCompiles = 0;
	Cost.PackagesLoaded = 0;

	// One frame, timed. Which kind it was shows in what it left: a flush sends (online) or grows the outbox (offline),
	// a window close adds a frame_window to the queue.
	// Frame times wander between 14.7 and 18.7 ms, as a real game's do, so the sketch sees more than one bucket.
	enum EKind { Plain, Window, Flushed };
	uint32_t Seed = 7;
	auto Frame = [&](EKind& Kind) {
		const int64_t Sent = C.GetStats().Sent;
		const int Waiting = C.OutboxEvents();
		const size_t Queued = C.Queued().size();
		Seed = Seed * 1664525u + 1013904223u;
		const double Dt = 14.7 + (Seed >> 8) % 4000 / 1000.0;
		Now += Dt;
		const auto At = std::chrono::steady_clock::now();
		C.Frame(Dt, Cost);
		const double Took = Us(std::chrono::steady_clock::now() - At);
		Kind = C.GetStats().Sent != Sent || C.OutboxEvents() != Waiting ? Flushed : C.Queued().size() > Queued ? Window : Plain;
		return Took;
	};

	// Two clock reads, which each frame's time includes.
	double ClockOnly = 1e9;
	for (int Run = 0; Run < 5; Run++)
	{
		double Sum = 0;
		for (int I = 0; I < 36000; I++)
		{
			const auto A = std::chrono::steady_clock::now();
			Sum += Us(std::chrono::steady_clock::now() - A);
		}
		ClockOnly = std::min(ClockOnly, Sum / 36000);
	}

	// Online: five runs of 10 minutes of play each; the plain frames' average in the best run, and every run's
	// windows and flushes. A pickup a second, so batches have game events in them.
	double Best = 1e9;
	std::vector<double> Windows, Flushes;
	for (int Run = 0; Run < 5; Run++)
	{
		double Sum = 0;
		int N = 0;
		for (int I = 0; I < 36000; I++)
		{
			if (I % 60 == 0)
			{
				FValue A = FValue::Object();
				A.Set("item", "coin");
				C.Track("pickup", std::move(A));
			}
			EKind Kind;
			const double Took = Frame(Kind);
			if (Kind == Plain)
			{
				Sum += Took;
				N++;
			}
			else
			{
				(Kind == Window ? Windows : Flushes).push_back(Took);
			}
		}
		Best = std::min(Best, Sum / N);
	}

	// Offline: every request is held, so batches pile up to the cap. 19 game events every 5 seconds.
	T->Online = false;
	std::vector<double> OfflineFlushes;
	int Loop = 0;
	while (OfflineFlushes.size() < 5)
	{
		if (Loop % 300 == 0)
		{
			for (int J = 0; J < 19; J++)
			{
				FValue A = FValue::Object();
				A.Set("item", "coin");
				A.Set("n", J);
				C.Track("pickup_" + std::to_string(Loop / 300), std::move(A));
			}
		}
		Loop++;
		EKind Kind;
		const double Took = Frame(Kind);
		if (Kind == Flushed && C.OutboxEvents() >= 3800)
		{
			OfflineFlushes.push_back(Took);
		}
	}
	C.WaitForSave();
	const int Waiting = C.OutboxEvents();
	const auto Size = std::filesystem::file_size(Dir / "outbox.json", Error);
	const auto At = std::chrono::steady_clock::now();
	C.Shutdown("quit"); // written at once, as quitting does
	const double Quit = Us(std::chrono::steady_clock::now() - At);
	C.WaitForSave();

	std::printf("Unreal core %s, clang -O2 as Unreal builds it, %s\n", FCore::SdkVersion,
#if defined(__aarch64__) || defined(__arm64__)
		"arm64"
#else
		"x86-64"
#endif
	);
	std::printf("each frame: %.2f us (%.0f ns, the clock read around it included)\n", Best, Best * 1000);
	std::printf("two clock reads alone: %.0f ns\n", ClockOnly * 1000);
	std::printf("frame that closes a window (every 5 s): median %.0f us of %zu\n", Median(Windows), Windows.size());
	std::printf("frame that flushes and sends, online (every 15 s): median %.0f us of %zu, %s\n", Median(Flushes), Flushes.size(), List(std::vector<double>(Flushes.begin(), Flushes.begin() + std::min<size_t>(8, Flushes.size()))).c_str());
	std::printf("frame that flushes with %d events waiting offline (%llu KB): %s us\n", Waiting, static_cast<unsigned long long>(Size / 1024), List(OfflineFlushes).c_str());
	std::printf("quitting with them waiting (written at once): %.0f us\n", Quit);
	std::filesystem::remove_all(Dir, Error);
	return 0;
}
