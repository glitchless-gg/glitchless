// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessWebPage.h"

#if defined(__EMSCRIPTEN__)

#include <atomic>
#include <cstring>
#include <emscripten/em_js.h>
#include <emscripten/proxying.h>
#include <emscripten/threading.h>
#include <unistd.h>

namespace
{
	constexpr int FactsCapacity = 8192;
	constexpr int AnswerCapacity = 8192;
	constexpr int RingSize = 16; // GlitchlessWeb_ReadPage's ring: 16 events, then the count

	// Written by the main thread, read by the game thread. std::atomic<int32_t> is a plain int32 in memory, so the
	// page's Atomics reach it.
	char GFacts[FactsCapacity];
	std::atomic<int32_t> GFactsLength{-1}; // -1 until the page has been read
	std::atomic<int32_t> GRing[RingSize + 1]; // the page's events, then how many were ever written
	std::atomic<int> GStarted{0};

	// The game thread's alone.
	int32_t GRead = 0;
	std::vector<GlitchlessWebPage::FRequest*> GReleased; // released while on their way

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
EM_JS(void, GlitchlessWeb_ReadPage, (double Facts, double FactsLength, int Capacity, double Ring), {
	var f = { ua: "", mobile: null, dpr: null, screen: null, cores: null, memory: null, gpu: "", vendor: "", protocol: "", host: "", search: "" };
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
			if (parting) {
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

namespace
{
	void ReadPageOnMainThread(void*)
	{
		GlitchlessWeb_ReadPage(Address(GFacts), Address(&GFactsLength), FactsCapacity, Address(GRing));
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
}

namespace GlitchlessWebPage
{
	bool IsWeb()
	{
		return true;
	}

	void Start()
	{
		if (GStarted.exchange(1) != 0)
		{
			return;
		}
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
	void Start() {}
	std::string Facts(int) { return std::string(); }
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
