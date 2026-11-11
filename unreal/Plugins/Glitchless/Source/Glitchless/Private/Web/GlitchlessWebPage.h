// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

/**
 * The page a web build (Unreal's Wasm target, UE 5.9 and later) runs in, for the plugin's web transport, device
 * facts and the two things that must outlast a page. Plain C++ and Emscripten, no Unreal types, so
 * unreal/test/web.mjs builds it with em++ alone and runs it in Chromium; everywhere but Emscripten every call does
 * nothing (Facts is empty, requests fail at once, nothing is kept).
 *
 * Why it is shaped this way:
 *  - Unreal's HTTP is the null one on the web ([HTTP] bUseNullHttp=true in BaseWasmEngine.ini), so requests go by the
 *    page's own fetch.
 *  - The game thread is a pthread Worker that never returns to its event loop, so a fetch started there would never
 *    hear back. Each request runs on the browser's main thread (MAIN_THREAD_ASYNC_EM_ASM, which never waits: a
 *    synchronous proxy from the game thread deadlocked Epic's own page bridge), and its status comes back through
 *    wasm memory, which the game thread reads when it likes (Status) and may wait on, the main thread being free.
 *  - The page is cross-origin isolated (COOP/COEP): a cors-mode fetch to the intake needs only its CORS answer.
 *    Batches go as text/plain, so the browser sends no preflight; a small one goes with keepalive, so it still
 *    arrives after the page has gone.
 *  - Workers can't see the page, so the facts (the browser, the screen, the GPU, the address) and the page's events
 *    (hidden, shown, left, back from the back-forward cache) are read on the main thread too.
 *  - A page that is going stops its Workers before the game thread can answer, so the request for then (the
 *    session's end) is handed to the page ahead (SetParting), and its pagehide handler sends it.
 *  - A web build's Saved folder doesn't always outlast the page (Core/GlitchlessCore.h's Page says where it doesn't),
 *    so the install ID and the player's choice are kept in the page's localStorage as well (Kept, Keep, Forget).
 *    Only the main thread has localStorage: it reads what is kept once, as it reads the facts, and the game thread
 *    hands it each change. And while the page keeps "off" as the choice, the page itself sends nothing, so a player
 *    who said no is safe even from a game thread that hasn't read the choice yet.
 * Every call but Start is for one thread at a time: the game thread.
 */
namespace GlitchlessWebPage
{
	enum EPageEvent : int
	{
		Hidden = 0, // another tab or app, or the phone locked: the browser may freeze or drop the page from here
		Shown = 1, // visible again
		Leaving = 2, // pagehide: closed, another page, or into the back-forward cache
		Restored = 3, // pageshow from the back-forward cache
	};

	/** True in a web build (Emscripten), where the rest does something. */
	bool IsWeb();

	/** Starts, once: reads the page and listens to it on the browser's main thread. Returns at once. KeptUnder: what
	 * the page keeps is in its localStorage under this and a name, so it says whose it is: a host such as itch.io
	 * serves every game from one origin, with one localStorage between them. Empty: the page keeps nothing. */
	void Start(const std::string& KeptUnder = std::string());

	/** The page's facts as JSON (Core/GlitchlessPage.h's ParseFacts reads it), waiting at most TimeoutMs for the main
	 * thread to have read them; empty when it hasn't, or off the web. Start first. */
	std::string Facts(int TimeoutMs);

	/** The page's events (EPageEvent) since the last call, oldest first. */
	std::vector<int> TakeEvents();

	/** Hands the page a POST to send from its own pagehide handler (navigator.sendBeacon as text/plain, else a
	 * keepalive fetch), in place of any handed before: the game thread hears nothing in time once the page is going,
	 * as unreal/test/web.mjs shows, so what it would say then is said ahead. */
	void SetParting(const std::string& Url, const uint8_t* Body, size_t Size);
	/** Takes the parting POST back (the page is in view again, and the session goes on). */
	void ClearParting();

	/** What the page keeps under Name, as it was when the page was read and as Keep and Forget have left it since:
	 * false when it keeps nothing there. Waits at most TimeoutMs for the main thread to have read the page, the first
	 * time only. Start first. */
	bool Kept(const std::string& Name, std::string& Out, int TimeoutMs);
	/** Keeps Text under Name from now on (one line, at most 200 characters), for this page and the next. Returns at
	 * once; a browser that refuses (storage blocked, or full) keeps it for this page only. */
	void Keep(const std::string& Name, const std::string& Text);
	/** Keeps nothing under Name any more. */
	void Forget(const std::string& Name);

	struct FRequest;

	/** Starts a POST on the main thread and returns at once. ContentType text/plain needs no preflight. A body of up
	 * to 60,000 bytes goes with keepalive, so it arrives even if the page goes now. While the page keeps "off" under
	 * "enabled" (the player's choice), no request leaves the page, this, a GET or the parting one: it fails as one
	 * that never got an answer. */
	FRequest* Post(const std::string& Url, const uint8_t* Body, size_t Size, const std::string& ContentType, int TimeoutMs);
	/** Starts a GET on the main thread and returns at once; its answer's text is Text's. */
	FRequest* Get(const std::string& Url, int TimeoutMs);
	/** -1 while on its way, then the answer's status, or 0 for a network failure or the timeout. */
	int Status(const FRequest* Request);
	/** Waits at most TimeoutMs for the status (the main thread answers; the game thread only waits). Off the main
	 * browser thread only: there it doesn't wait. */
	int Wait(const FRequest* Request, int TimeoutMs);
	/** The answer's text, up to 8 KB, once Status isn't -1. */
	std::string Text(const FRequest* Request);
	/** Done with it. One still on its way is freed when it lands (at a later call here). */
	void Release(FRequest* Request);
}
