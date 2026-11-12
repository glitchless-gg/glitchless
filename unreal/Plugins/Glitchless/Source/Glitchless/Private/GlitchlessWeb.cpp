// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessWeb.h"

#if GLITCHLESS_WEB

#include "Core/GlitchlessPage.h"
#include "GlitchlessStrings.h"
#include "Misc/EngineVersion.h"
#include "Misc/ScopeLock.h"
#include "Web/GlitchlessWebPage.h"

#include <memory>

namespace
{
	/** Batches by the page's fetch (Web/GlitchlessWebPage). Answers run on the game thread, with the core's lock held,
	 * from Poll each frame, or from Wait and SendNow, which may wait here: the page's main thread does the fetching. */
	class FWebTransport : public Glitchless::ITransport
	{
	public:
		explicit FWebTransport(FCriticalSection* InCoreLock)
			: CoreLock(InCoreLock)
		{
		}

		virtual ~FWebTransport() override
		{
			GlitchlessWebPage::Release(Current);
			GlitchlessWebPage::Release(Health);
		}

		virtual void Send(const std::string& Url, std::vector<uint8_t> Body, const std::string& ContentType, std::function<void(int64_t)> Done) override
		{
			GlitchlessWebPage::Release(Current); // the core has one batch on its way at a time
			Current = GlitchlessWebPage::Post(Url, Body.data(), Body.size(), ContentType, 10000);
			CurrentDone = std::move(Done);
		}

		virtual void Get(const std::string& Url, std::function<void(int64_t, const std::string&)> Done) override
		{
			GlitchlessWebPage::Release(Health);
			Health = GlitchlessWebPage::Get(Url, 10000);
			HealthDone = std::move(Done);
		}

		virtual int64_t SendNow(const std::string& Url, const std::vector<uint8_t>& Body, const std::string& ContentType, int TimeoutMs) override
		{
			GlitchlessWebPage::FRequest* R = GlitchlessWebPage::Post(Url, Body.data(), Body.size(), ContentType, FMath::Max(100, TimeoutMs));
			const int Status = GlitchlessWebPage::Wait(R, TimeoutMs);
			GlitchlessWebPage::Release(R);
			return Status > 0 ? Status : 0;
		}

		virtual void Abort() override
		{
			GlitchlessWebPage::Release(Current); // it may still land: the server keeps a batch once, by its batch_id
			Current = nullptr;
			CurrentDone = nullptr;
		}

		virtual bool Wait(int TimeoutMs) override
		{
			if (!Current)
			{
				return true;
			}
			GlitchlessWebPage::Wait(Current, TimeoutMs);
			Poll();
			return Current == nullptr;
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
					FScopeLock Guard(CoreLock);
					Done(Status); // may Send the next batch
				}
			}
			if (Health && GlitchlessWebPage::Status(Health) != -1)
			{
				const int64_t Status = GlitchlessWebPage::Status(Health);
				const std::string Text = GlitchlessWebPage::Text(Health);
				std::function<void(int64_t, const std::string&)> Done = std::move(HealthDone);
				GlitchlessWebPage::Release(Health);
				Health = nullptr;
				HealthDone = nullptr;
				if (Done)
				{
					FScopeLock Guard(CoreLock);
					Done(Status, Text);
				}
			}
		}

	private:
		FCriticalSection* CoreLock;
		GlitchlessWebPage::FRequest* Current = nullptr;
		std::function<void(int64_t)> CurrentDone;
		GlitchlessWebPage::FRequest* Health = nullptr;
		std::function<void(int64_t, const std::string&)> HealthDone;
	};

	std::weak_ptr<FWebTransport> GTransport;
	Glitchless::Page::FFacts GFacts;
}

namespace GlitchlessWeb
{
	void Configure(Glitchless::FCore& C, FCriticalSection* CoreLock)
	{
		// What the page keeps is named by the game's own Saved folder ("glitchless:/<Project>/Saved/Glitchless/enabled"),
		// as Unreal's files in the browser are: one origin may serve many games.
		GlitchlessWebPage::Start("glitchless:" + C.SaveDir + "/");
		const bool bRead = Glitchless::Page::ParseFacts(GlitchlessWebPage::Facts(2000), GFacts);

		// The install ID and the player's choice are the page's to keep as well: Saved doesn't always outlast it.
		C.Page.Read = [](const std::string& Name, std::string& Out) { return GlitchlessWebPage::Kept(Name, Out, 2000); };
		C.Page.Write = [](const std::string& Name, const std::string& Text) { GlitchlessWebPage::Keep(Name, Text); };
		C.Page.Remove = [](const std::string& Name) { GlitchlessWebPage::Forget(Name); };

		const std::shared_ptr<FWebTransport> Transport = std::make_shared<FWebTransport>(CoreLock);
		GTransport = Transport;
		C.Transport = Transport;

		// The device is the browser, as every web game's; the engine's renderer and driver go beside it.
		const std::function<Glitchless::FValue(bool)> Native = C.Device;
		C.Device = [Native](bool bDetailed) {
			Glitchless::FValue D = Glitchless::Page::Device(GFacts, bDetailed);
			if (Native)
			{
				const Glitchless::FValue Engine = Native(false);
				for (const char* Key : {"renderer", "driver"})
				{
					if (const Glitchless::FValue* V = Engine.Find(Key))
					{
						D.Set(Key, *V);
					}
				}
			}
			return D;
		};
		Glitchless::FValue Engine = Glitchless::FValue::Object();
		Engine.Set("name", "unreal");
		Engine.Set("version", GlitchlessText::Utf8(FEngineVersion::Current().ToString(EVersionComponent::Patch)));
		Engine.Set("renderer", "webgpu");
		C.EngineInfo = Engine;

		if (bRead)
		{
			// A web build has no command line of its own: the page's address stands in, for Glitchless's own flags only.
			for (const std::string& Flag : Glitchless::Page::Flags(GFacts.Search))
			{
				C.Args.push_back(Flag);
			}
			// A page anywhere but the developer's own machine is played by players, whatever the build: jam entries
			// on itch.io are often Development builds.
			if (!Glitchless::Page::IsLocal(GFacts.Protocol, GFacts.Host))
			{
				C.IsDevelopmentBuild = false;
			}
			C.IsMobile = Glitchless::Page::ParseUserAgent(GFacts.Ua, GFacts.UadMobile).Mobile;
			// Where it is played (an itch.io frame, a Reddit post, its own site), as the browser SDK says it.
			C.Address = Glitchless::Page::Address(GFacts);
		}
	}

	void Poll()
	{
		if (const std::shared_ptr<FWebTransport> Transport = GTransport.lock())
		{
			Transport->Poll();
		}
	}
}

#endif
