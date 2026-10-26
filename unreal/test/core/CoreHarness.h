#pragma once

// What the core's tests share: a transport that keeps what was sent and answers as told, and a core on a clock the
// test moves, saving in a fresh folder.

#include "GlitchlessCore.h"
#include "TestMain.h"

#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <random>

namespace GlitchlessTestHarness
{
	using namespace Glitchless;
	/** A transport that answers with whatever status the test sets, and keeps what was sent. */
	class FFakeTransport : public ITransport
	{
	public:
		int64_t Status = 202;
		std::vector<std::string> Sent;
		std::vector<std::string> SentNow;
		std::vector<std::string> InOrder; // both, in the order they went
		std::vector<std::vector<uint8_t>> Raw;
		int Aborts = 0;
		// Hold: the server gets each request, but its answer waits for Wait (or, with AnswerOnWait off, never comes).
		bool Hold = false;
		bool AnswerOnWait = true;
		std::vector<std::function<void(int64_t)>> Pending;
		// Runs as each blocking send starts, before it is answered: what is on disk then is what a game stopped there leaves.
		std::function<void()> BeforeSendNow;
		// GET /v1/health: no answer (0) unless a test gives one. HoldGets keeps the answer until AnswerGets.
		int64_t HealthStatus = 0;
		std::string HealthBody;
		std::vector<std::string> Gets;
		bool HoldGets = false;
		std::vector<std::function<void(int64_t, const std::string&)>> PendingGets;

		void Get(const std::string& Url, std::function<void(int64_t, const std::string&)> Done) override
		{
			Gets.push_back(Url);
			if (HoldGets)
			{
				PendingGets.push_back(std::move(Done));
				return;
			}
			Done(HealthStatus, HealthBody);
		}

		void AnswerGets()
		{
			std::vector<std::function<void(int64_t, const std::string&)>> Answer = std::move(PendingGets);
			PendingGets.clear();
			for (auto& Done : Answer)
			{
				Done(HealthStatus, HealthBody);
			}
		}

		/** A server that takes every addition. */
		void Takes(const std::string& FeaturesJson = "[\"counts\",\"props\",\"groups\",\"net\",\"server_mode\"]")
		{
			HealthStatus = 200;
			HealthBody = "{\"ok\":true,\"features\":" + FeaturesJson + "}";
		}

		void Send(const std::string&, std::vector<uint8_t> Body, const std::string&, std::function<void(int64_t)> Done) override
		{
			Raw.push_back(Body);
			Sent.push_back(Text(Body));
			InOrder.push_back(Sent.back());
			if (Hold)
			{
				Pending.push_back(std::move(Done));
				return;
			}
			Done(Status);
		}

		bool Wait(int) override
		{
			if (Pending.empty())
			{
				return true;
			}
			if (!AnswerOnWait)
			{
				return false;
			}
			std::vector<std::function<void(int64_t)>> Answer = std::move(Pending);
			Pending.clear();
			for (auto& Done : Answer)
			{
				Done(Status);
			}
			return true;
		}

		int64_t SendNow(const std::string&, const std::vector<uint8_t>& Body, const std::string&, int) override
		{
			if (BeforeSendNow)
			{
				BeforeSendNow();
			}
			SentNow.push_back(Text(Body));
			InOrder.push_back(SentNow.back());
			return Status;
		}

		void Abort() override { Aborts++; }

		// The tests' "gzip" is the gzip magic bytes and then the text as it was.
		static std::string Text(const std::vector<uint8_t>& Body)
		{
			if (Body.size() >= 2 && Body[0] == 0x1f && Body[1] == 0x8b)
			{
				return std::string(Body.begin() + 2, Body.end());
			}
			return std::string(Body.begin(), Body.end());
		}

		std::vector<FValue> Events(const std::vector<std::string>* Bodies = nullptr) const
		{
			std::vector<FValue> Out;
			for (const std::string& B : Bodies ? *Bodies : Sent)
			{
				FValue Envelope;
				if (!FValue::Parse(B, Envelope))
				{
					continue;
				}
				for (const FValue& E : Envelope.Find("events")->GetItems())
				{
					Out.push_back(E);
				}
			}
			return Out;
		}
	};

	inline std::string Type(const FValue& E) { return E.Find("type") ? E.Find("type")->AsString() : ""; }

	// The batch_id of a request as it was sent.
	inline std::string BatchId(const std::string& Body)
	{
		FValue Envelope;
		const FValue* Id = FValue::Parse(Body, Envelope) ? Envelope.Find("batch_id") : nullptr;
		return Id && Id->IsString() ? Id->AsString() : "";
	}

	// b_ and 16 of [a-z0-9] (SPEC §2 batch_id).
	inline bool IsBatchId(const std::string& Id)
	{
		if (Id.size() != 18 || Id.compare(0, 2, "b_") != 0)
		{
			return false;
		}
		return std::all_of(Id.begin() + 2, Id.end(), [](char C) { return (C >= 'a' && C <= 'z') || (C >= '0' && C <= '9'); });
	}

	inline std::vector<FValue> OfType(const std::vector<FValue>& Events, const std::string& T)
	{
		std::vector<FValue> Out;
		for (const FValue& E : Events)
		{
			if (Type(E) == T)
			{
				Out.push_back(E);
			}
		}
		return Out;
	}

	inline bool Contains(const FValue& List, const std::string& S)
	{
		for (const FValue& V : List.GetItems())
		{
			if (V.AsString() == S)
			{
				return true;
			}
		}
		return false;
	}

	// The error_code overloads: these tests build without exceptions, as Unreal does.
	inline std::string TempDir()
	{
		static std::mt19937 Rng(std::random_device{}());
		std::error_code Error;
		const std::filesystem::path Base = std::filesystem::temp_directory_path(Error);
		const std::filesystem::path Dir = (Error ? std::filesystem::path(".") : Base) / ("glitchless-unreal-tests-" + std::to_string(Rng()));
		if (!std::filesystem::create_directories(Dir, Error))
		{
			std::printf("    cannot make %s\n", Dir.string().c_str());
		}
		return Dir.generic_string();
	}

	inline bool Exists(const std::string& Path)
	{
		std::FILE* F = std::fopen(Path.c_str(), "rb");
		if (F)
		{
			std::fclose(F);
		}
		return F != nullptr;
	}

	inline std::string ReadAll(const std::string& Path)
	{
		std::string Out;
		std::FILE* F = std::fopen(Path.c_str(), "rb");
		if (!F)
		{
			return Out;
		}
		char Buf[4096];
		size_t N;
		while ((N = std::fread(Buf, 1, sizeof(Buf), F)) > 0)
		{
			Out.append(Buf, N);
		}
		std::fclose(F);
		return Out;
	}

	/** A core on a clock the test moves, sending through a fake transport, saving in a fresh folder. */
	struct FHarness
	{
		double Now = 1000;
		std::shared_ptr<FFakeTransport> Transport = std::make_shared<FFakeTransport>();
		std::string Dir = TempDir();

		~FHarness()
		{
			std::error_code Error;
			std::filesystem::remove_all(Dir, Error);
			if (Error)
			{
				std::printf("    cannot remove %s\n", Dir.c_str());
			}
		}

		std::unique_ptr<FCore> NewCore(std::vector<std::string> Args = {})
		{
			std::unique_ptr<FCore> Core(new FCore());
			Core->Transport = Transport;
			Core->SaveDir = Dir;
			Core->Clock = [this]() { return Now; };
			Core->UnixNow = [this]() { return static_cast<int64_t>(1761000000000LL + static_cast<int64_t>(Now)); };
			Core->Args = std::move(Args);
			Core->Log = [](const std::string&) {};
			Core->Device = [](bool Detailed) {
				FValue D = FValue::Object();
				D.Set("browser", "Unreal");
				D.Set("browser_version", "5.8.0");
				D.Set("os", "macOS");
				D.Set("mobile", false);
				D.Set("device_tier", "high");
				D.Set("gpu_tier", "high");
				if (Detailed)
				{
					D.Set("gpu", "Apple M3 Max");
					D.Set("cores", 16);
				}
				return D;
			};
			Core->Gzip = [](const std::string& In, std::vector<uint8_t>& Out) {
				Out = {0x1f, 0x8b};
				Out.insert(Out.end(), In.begin(), In.end());
				return true;
			};
			Core->AppVersion = "1.2.3";
			Core->IsDevelopmentBuild = true;
			return Core;
		}

		static FOptions Options(EPrivacy Privacy = EPrivacy::Anonymous)
		{
			FOptions O;
			O.Service = "Fetch";
			O.Intake = "http://localhost:7777/";
			O.Privacy = Privacy;
			return O;
		}

		static FFrameCost Cost(double Game = 4, double Render = 3, double Rhi = 2, double Gpu = 6, int64_t Calls = 40)
		{
			FFrameCost C;
			C.Game = Game;
			C.Render = Render;
			C.Rhi = Rhi;
			C.Gpu = Gpu;
			C.Calls = Calls;
			C.Triangles = 9000;
			C.PsoCompiles = 0;
			C.ShaderCompiles = 0;
			C.PackagesLoaded = 0;
			return C;
		}

		// Plays Count frames of Dt ms each, moving the clock along with them.
		void Frames(FCore& Core, int Count, double Dt = 16.7, const FFrameCost* C = nullptr)
		{
			const FFrameCost Default = Cost();
			for (int I = 0; I < Count; I++)
			{
				Now += Dt;
				Core.Frame(Dt, C ? *C : Default);
			}
		}

		// Every event that went, by either kind of send, in order.
		std::vector<FValue> AllEvents() const { return Transport->Events(&Transport->InOrder); }

		FValue Envelope(size_t I = 0) const
		{
			FValue E;
			FValue::Parse(Transport->Sent.at(I), E);
			return E;
		}
	};
}

using namespace GlitchlessTestHarness;
