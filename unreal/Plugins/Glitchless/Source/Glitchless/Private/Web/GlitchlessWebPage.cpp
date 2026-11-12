// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessWebPage.h"

#if defined(__EMSCRIPTEN__)

#include <atomic>
#include <cstring>
#include <map>
#include <set>
#include <emscripten/em_js.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <unistd.h>

namespace
{
	constexpr int FactsCapacity = 8192;
	constexpr int KeptCapacity = 4096;
	constexpr size_t KeptLine = 200; // the longest name or text the page keeps
	constexpr int AnswerCapacity = 8192;
	constexpr int RingSize = 16; // GlitchlessWeb_ReadPage's ring: 16 events, then the count

	// Written by the main thread, read by the game thread. std::atomic<int32_t> is a plain int32 in memory, so the
	// page's Atomics reach it.
	char GFacts[FactsCapacity];
	std::atomic<int32_t> GFactsLength{-1}; // -1 until the page has been read
	char GKept[KeptCapacity]; // what the page keeps, a line for each name and a line for its text
	std::atomic<int32_t> GKeptLength{-1}; // -1 until the page has been read; set before GFactsLength
	std::string GKeptUnder; // written by Start before the main thread is asked to read
	std::atomic<int32_t> GRing[RingSize + 1]; // the page's events, then how many were ever written
	std::atomic<int> GStarted{0};

	// The game thread's alone.
	int32_t GRead = 0;
	std::vector<GlitchlessWebPage::FRequest*> GReleased; // released while on their way
	std::map<std::string, std::string> GKeptNow; // what the page keeps, as far as the game thread knows
	std::set<std::string> GKeptChanged; // kept or forgotten here: what the page read of these, if it comes later, is older
	bool GKeptTaken = false; // the page's reading is in GKeptNow
	bool GKeptWaited = false;

	double Address(const void* P) { return static_cast<double>(reinterpret_cast<uintptr_t>(P)); }
}

struct GlitchlessWebPage::FRequest
{
	std::atomic<int32_t> State{-1}; // the status, set by the main thread once the request lands
	std::atomic<int32_t> AnswerLength{0};
	bool bGet = false;
	int TimeoutMs = 10000;
	std::string Url;
	std::string ContentType;
	std::vector<uint8_t> Body;
	char Answer[AnswerCapacity];
};

// The page's facts as JSON, and its events, which go into the ring as they happen. On the browser's main thread.
// (No regular expressions or backslashes here: EM_JS bodies are C strings.)
// What the page keeps goes first (a line for each name under Under and a line for its text), so it is there once
// the facts are; and glitchlessOff, which the page's own sends ask: true while the page keeps "off" as the choice.
EM_JS(void, GlitchlessWeb_ReadPage, (double Facts, double FactsLength, int Capacity, double Ring, double Under, double Kept, double KeptLength, int KeptSize, int LineSize), {
	var under = "";
	var kept = "";
	try {
		under = UTF8ToString(Under);
		var newline = String.fromCharCode(10);
		for (var i = 0; under && i < localStorage.length; i++) {
			var key = localStorage.key(i);
			if (key.indexOf(under) !== 0) continue;
			var name = key.slice(under.length);
			var text = localStorage.getItem(key) || "";
			if (!name || name.length > LineSize || text.length > LineSize || name.indexOf(newline) >= 0 || text.indexOf(newline) >= 0) continue;
			kept += name + newline + text + newline;
		}
	} catch (e) {
		kept = "";
	}
	globalThis.glitchlessKeptUnder = under;
	globalThis.glitchlessOff = function() {
		try {
			return !!globalThis.glitchlessKeptUnder && localStorage.getItem(globalThis.glitchlessKeptUnder + "enabled") === "off";
		} catch (e) {
			return false;
		}
	};
	var keptBytes = new TextEncoder().encode(kept);
	var keptLength = keptBytes.length <= KeptSize ? keptBytes.length : 0;
	new Uint8Array(HEAP8.buffer, Kept, keptLength).set(keptBytes.subarray(0, keptLength));
	Atomics.store(new Int32Array(HEAP8.buffer, KeptLength, 1), 0, keptLength);
	var f = { ua: "", mobile: null, dpr: null, screen: null, cores: null, memory: null, gpu: "", vendor: "", protocol: "", host: "", search: "", url: "", referrer: "" };
	try {
		var nav = navigator;
		f.ua = nav.userAgent || "";
		if (nav.userAgentData && typeof nav.userAgentData.mobile === "boolean") f.mobile = nav.userAgentData.mobile;
		if (typeof nav.hardwareConcurrency === "number") f.cores = nav.hardwareConcurrency;
		if (typeof nav.deviceMemory === "number") f.memory = nav.deviceMemory;
		if (typeof devicePixelRatio === "number" && devicePixelRatio > 0) f.dpr = devicePixelRatio;
		if (typeof screen !== "undefined" && screen.width > 0) f.screen = [screen.width, screen.height];
		f.protocol = location.protocol;
		f.host = location.hostname;
		f.search = location.search;
		f.url = location.origin + location.pathname;
		if (document.referrer) f.referrer = new URL(document.referrer).origin;
	} catch (e) {}
	try {
		var canvas = document.createElement("canvas");
		var gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
		if (gl) {
			var ext = gl.getExtension("WEBGL_debug_renderer_info");
			f.gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
			f.vendor = String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || "");
			var lose = gl.getExtension("WEBGL_lose_context");
			if (lose) lose.loseContext();
		}
	} catch (e) {}
	var push = function(event) {
		var ring = new Int32Array(HEAP8.buffer, Ring, 17);
		var written = Atomics.load(ring, 16);
		Atomics.store(ring, written % 16, event);
		Atomics.store(ring, 16, written + 1);
	};
	try {
		document.addEventListener("visibilitychange", function() { push(document.visibilityState === "hidden" ? 0 : 1); });
		window.addEventListener("pagehide", function() {
			var parting = globalThis.glitchlessParting;
			globalThis.glitchlessParting = null;
			if (parting && !globalThis.glitchlessOff()) {
				var sent = false;
				try { sent = navigator.sendBeacon(parting.url, new Blob([parting.body], { type: "text/plain" })); } catch (e) {}
				if (!sent) {
					try { fetch(parting.url, { method: "POST", body: parting.body, headers: { "Content-Type": "text/plain" }, mode: "cors", credentials: "omit", keepalive: true }); } catch (e) {}
				}
			}
			push(2);
		});
		window.addEventListener("pageshow", function(e) { if (e.persisted) push(3); });
		if (document.visibilityState === "hidden") push(0); // opened in a background tab: no event says so
	} catch (e) {}
	var bytes = new TextEncoder().encode(JSON.stringify(f));
	var n = bytes.length <= Capacity ? bytes.length : 0;
	new Uint8Array(HEAP8.buffer, Facts, n).set(bytes.subarray(0, n));
	Atomics.store(new Int32Array(HEAP8.buffer, FactsLength, 1), 0, n);
});

// One request, by the page's fetch, on the browser's main thread. The URL, type and body are copied before this
// returns; the answer's text (a GET's) and then the status go into wasm memory when it lands.
EM_JS(void, GlitchlessWeb_Fetch, (double State, double AnswerLength, double Answer, int Capacity, double Url, double ContentType, double Body, double Size, int bGet, int TimeoutMs), {
	var finish = function(status) { Atomics.store(new Int32Array(HEAP8.buffer, State, 1), 0, status); };
	var timer = 0;
	if (globalThis.glitchlessOff && globalThis.glitchlessOff()) {
		finish(0); // the player said no: nothing leaves the page
		return;
	}
	try {
		var init = { method: bGet ? "GET" : "POST", mode: "cors", credentials: "omit" };
		if (!bGet) {
			init.body = HEAPU8.slice(Body, Body + Size);
			init.headers = { "Content-Type": UTF8ToString(ContentType) };
			init.keepalive = Size <= 60000; // browsers keep about 64 KB of keepalive requests in flight for a page
		}
		var controller = typeof AbortController === "function" ? new AbortController() : null;
		if (controller) init.signal = controller.signal;
		timer = setTimeout(function() { if (controller) controller.abort(); }, TimeoutMs);
		fetch(UTF8ToString(Url), init).then(function(response) {
			if (!bGet) {
				clearTimeout(timer);
				finish(response.status);
				return;
			}
			return response.text().then(function(text) {
				clearTimeout(timer);
				var bytes = new TextEncoder().encode(text);
				var n = bytes.length < Capacity ? bytes.length : Capacity;
				new Uint8Array(HEAP8.buffer, Answer, n).set(bytes.subarray(0, n));
				Atomics.store(new Int32Array(HEAP8.buffer, AnswerLength, 1), 0, n);
				finish(response.status);
			});
		}).catch(function() {
			clearTimeout(timer);
			finish(0);
		});
	} catch (e) {
		clearTimeout(timer);
		finish(0);
	}
});

// The request the page sends from its pagehide handler, copied now; then the request's memory is the game thread's again.
EM_JS(void, GlitchlessWeb_SetParting, (double State, double Url, double Body, double Size), {
	globalThis.glitchlessParting = { url: UTF8ToString(Url), body: HEAPU8.slice(Body, Body + Size) };
	Atomics.store(new Int32Array(HEAP8.buffer, State, 1), 0, 1);
});

EM_JS(void, GlitchlessWeb_ClearParting, (), {
	globalThis.glitchlessParting = null;
});

// Keeps the text under the name in the page's localStorage, or with bForget keeps nothing there. A browser that
// refuses (storage blocked, or full) throws, and nothing is kept past this page.
EM_JS(void, GlitchlessWeb_Keep, (double State, double Name, double Text, double Size, int bForget), {
	try {
		var under = globalThis.glitchlessKeptUnder;
		if (under) {
			var key = under + UTF8ToString(Name);
			if (bForget) localStorage.removeItem(key);
			else localStorage.setItem(key, new TextDecoder().decode(HEAPU8.slice(Text, Text + Size)));
		}
	} catch (e) {}
	Atomics.store(new Int32Array(HEAP8.buffer, State, 1), 0, 1);
});

namespace
{
	void ReadPageOnMainThread(void*)
	{
		GlitchlessWeb_ReadPage(Address(GFacts), Address(&GFactsLength), FactsCapacity, Address(GRing), Address(GKeptUnder.c_str()), Address(GKept),
			Address(&GKeptLength), KeptCapacity, static_cast<int>(KeptLine));
	}

	void FetchOnMainThread(void* Arg)
	{
		GlitchlessWebPage::FRequest* R = static_cast<GlitchlessWebPage::FRequest*>(Arg);
		GlitchlessWeb_Fetch(Address(&R->State), Address(&R->AnswerLength), Address(R->Answer), AnswerCapacity, Address(R->Url.c_str()),
			Address(R->ContentType.c_str()), Address(R->Body.data()), static_cast<double>(R->Body.size()), R->bGet ? 1 : 0, R->TimeoutMs);
	}

	void SetPartingOnMainThread(void* Arg)
	{
		GlitchlessWebPage::FRequest* R = static_cast<GlitchlessWebPage::FRequest*>(Arg);
		GlitchlessWeb_SetParting(Address(&R->State), Address(R->Url.c_str()), Address(R->Body.data()), static_cast<double>(R->Body.size()));
	}

	void ClearPartingOnMainThread(void*)
	{
		GlitchlessWeb_ClearParting();
	}

	// A request stands in for the change: its Url the name, its Body the text, bGet for forgetting.
	void KeepOnMainThread(void* Arg)
	{
		GlitchlessWebPage::FRequest* R = static_cast<GlitchlessWebPage::FRequest*>(Arg);
		GlitchlessWeb_Keep(Address(&R->State), Address(R->Url.c_str()), Address(R->Body.data()), static_cast<double>(R->Body.size()), R->bGet ? 1 : 0);
	}

	// Runs Fn(Request) on the browser's main thread, after whatever was sent there before (the queue keeps order).
	void OnMainThread(void (*Fn)(void*), GlitchlessWebPage::FRequest* Request)
	{
		if (emscripten_is_main_browser_thread())
		{
			Fn(Request);
		}
		else if (!emscripten_proxy_async(emscripten_proxy_get_system_queue(), emscripten_main_runtime_thread_id(), Fn, Request) && Request)
		{
			Request->State.store(0); // the main thread can't be reached: as a request that never got an answer
		}
	}

	// Frees the released requests that have landed (the main thread is done with their memory then).
	void Sweep()
	{
		for (size_t I = 0; I < GReleased.size();)
		{
			if (GReleased[I]->State.load() != -1)
			{
				delete GReleased[I];
				GReleased[I] = GReleased.back();
				GReleased.pop_back();
			}
			else
			{
				I++;
			}
		}
	}

	GlitchlessWebPage::FRequest* Begin(GlitchlessWebPage::FRequest* R)
	{
		Sweep();
		OnMainThread(FetchOnMainThread, R);
		return R;
	}

	// Takes what the main thread read of the page's storage, once it has: names changed here since are newer.
	void TakeKept()
	{
		const int32_t N = GKeptLength.load();
		if (GKeptTaken || N < 0)
		{
			return;
		}
		GKeptTaken = true;
		const std::string All(GKept, static_cast<size_t>(N));
		for (size_t From = 0; From < All.size();)
		{
			const size_t NameEnd = All.find('\n', From);
			const size_t TextEnd = NameEnd == std::string::npos ? NameEnd : All.find('\n', NameEnd + 1);
			if (TextEnd == std::string::npos)
			{
				break;
			}
			const std::string Name = All.substr(From, NameEnd - From);
			if (!GKeptChanged.count(Name))
			{
				GKeptNow[Name] = All.substr(NameEnd + 1, TextEnd - NameEnd - 1);
			}
			From = TextEnd + 1;
		}
	}

	void Change(const std::string& Name, const std::string& Text, bool bForget)
	{
		Sweep();
		GlitchlessWebPage::FRequest* R = new GlitchlessWebPage::FRequest();
		R->Url = Name;
		R->Body.assign(Text.begin(), Text.end());
		R->bGet = bForget;
		OnMainThread(KeepOnMainThread, R);
		GlitchlessWebPage::Release(R); // freed once the page has it
	}
}

namespace GlitchlessWebPage
{
	bool IsWeb()
	{
		return true;
	}

	void Start(const std::string& KeptUnder)
	{
		if (GStarted.exchange(1) != 0)
		{
			return;
		}
		GKeptUnder = KeptUnder;
		for (std::atomic<int32_t>& Slot : GRing)
		{
			Slot.store(0);
		}
		OnMainThread(ReadPageOnMainThread, nullptr);
	}

	std::string Facts(int TimeoutMs)
	{
		for (int Waited = 0; GFactsLength.load() < 0 && Waited < TimeoutMs && !emscripten_is_main_browser_thread(); Waited++)
		{
			usleep(1000);
		}
		const int32_t N = GFactsLength.load();
		return N > 0 ? std::string(GFacts, static_cast<size_t>(N)) : std::string();
	}

	bool Kept(const std::string& Name, std::string& Out, int TimeoutMs)
	{
		for (int Waited = 0; !GKeptWaited && GKeptLength.load() < 0 && Waited < TimeoutMs && !emscripten_is_main_browser_thread(); Waited++)
		{
			usleep(1000);
		}
		GKeptWaited = true;
		TakeKept();
		const auto It = GKeptNow.find(Name);
		if (It == GKeptNow.end())
		{
			return false;
		}
		Out = It->second;
		return true;
	}

	void Keep(const std::string& Name, const std::string& Text)
	{
		if (GKeptUnder.empty() || Name.empty() || Name.size() > KeptLine || Text.size() > KeptLine || Name.find('\n') != std::string::npos || Text.find('\n') != std::string::npos)
		{
			return;
		}
		TakeKept();
		GKeptChanged.insert(Name);
		GKeptNow[Name] = Text;
		Change(Name, Text, false);
	}

	void Forget(const std::string& Name)
	{
		if (GKeptUnder.empty() || Name.empty())
		{
			return;
		}
		TakeKept();
		GKeptChanged.insert(Name);
		GKeptNow.erase(Name);
		Change(Name, std::string(), true);
	}

	std::vector<int> TakeEvents()
	{
		Sweep();
		std::vector<int> Out;
		const int32_t Written = GRing[RingSize].load();
		if (Written - GRead > RingSize)
		{
			GRead = Written - RingSize; // more than the ring holds came at once: the oldest are gone
		}
		for (; GRead < Written; GRead++)
		{
			Out.push_back(GRing[GRead % RingSize].load());
		}
		return Out;
	}

	void SetParting(const std::string& Url, const uint8_t* Body, size_t Size)
	{
		Sweep();
		FRequest* R = new FRequest();
		R->Url = Url;
		R->Body.assign(Body, Body + Size);
		OnMainThread(SetPartingOnMainThread, R);
		Release(R); // freed once the page has its copy
	}

	void ClearParting()
	{
		OnMainThread(ClearPartingOnMainThread, nullptr);
	}

	FRequest* Post(const std::string& Url, const uint8_t* Body, size_t Size, const std::string& ContentType, int TimeoutMs)
	{
		FRequest* R = new FRequest();
		R->Url = Url;
		R->ContentType = ContentType;
		R->Body.assign(Body, Body + Size);
		R->TimeoutMs = TimeoutMs > 0 ? TimeoutMs : 1;
		return Begin(R);
	}

	FRequest* Get(const std::string& Url, int TimeoutMs)
	{
		FRequest* R = new FRequest();
		R->bGet = true;
		R->Url = Url;
		R->TimeoutMs = TimeoutMs > 0 ? TimeoutMs : 1;
		return Begin(R);
	}

	int Status(const FRequest* Request)
	{
		return Request ? Request->State.load() : 0;
	}

	int Wait(const FRequest* Request, int TimeoutMs)
	{
		if (!Request)
		{
			return 0;
		}
		for (int Waited = 0; Request->State.load() == -1 && Waited < TimeoutMs && !emscripten_is_main_browser_thread(); Waited++)
		{
			usleep(1000);
		}
		return Request->State.load();
	}

	std::string Text(const FRequest* Request)
	{
		if (!Request || Request->State.load() == -1)
		{
			return std::string();
		}
		return std::string(Request->Answer, static_cast<size_t>(Request->AnswerLength.load()));
	}

	void Release(FRequest* Request)
	{
		if (!Request)
		{
			return;
		}
		if (Request->State.load() != -1)
		{
			delete Request;
		}
		else
		{
			GReleased.push_back(Request);
		}
	}
}

#else

// Not a web build: no page, and nothing to send through one.
namespace GlitchlessWebPage
{
	struct FRequest
	{
	};
	bool IsWeb() { return false; }
	void Start(const std::string&) {}
	std::string Facts(int) { return std::string(); }
	bool Kept(const std::string&, std::string&, int) { return false; }
	void Keep(const std::string&, const std::string&) {}
	void Forget(const std::string&) {}
	std::vector<int> TakeEvents() { return {}; }
	void SetParting(const std::string&, const uint8_t*, size_t) {}
	void ClearParting() {}
	FRequest* Post(const std::string&, const uint8_t*, size_t, const std::string&, int) { return nullptr; }
	FRequest* Get(const std::string&, int) { return nullptr; }
	int Status(const FRequest*) { return 0; }
	int Wait(const FRequest*, int) { return 0; }
	std::string Text(const FRequest*) { return std::string(); }
	void Release(FRequest*) {}
}

#endif
