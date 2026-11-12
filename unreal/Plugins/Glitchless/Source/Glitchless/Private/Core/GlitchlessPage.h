// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "GlitchlessJson.h"

#include <string>
#include <vector>

namespace Glitchless
{
	/**
	 * The page a web build (Unreal's Wasm target) runs in, read by the browser SDK's own rules
	 * (packages/sdk/src/device.js), so an Unreal web game splits by browser and OS as a Three.js, Unity or Godot web
	 * game does. Unreal names itself where the browser would, so without this every web player was browser "Unreal",
	 * OS "Wasm". The Web folder beside Core reads the facts from the page; this only reads them, and is tested against
	 * a fixture from device.js (unreal/test/make-fixtures.mjs).
	 */
	namespace Page
	{
		/** What the page says, raw, as the Web folder's page script reads it. */
		struct FFacts
		{
			std::string Ua; // navigator.userAgent
			int UadMobile = -1; // navigator.userAgentData.mobile: 1, 0, or -1 where the browser doesn't say (Firefox, Safari)
			double Dpr = 0; // devicePixelRatio
			int ScreenWidth = 0; // screen.width and height, in CSS pixels
			int ScreenHeight = 0;
			double Cores = 0; // navigator.hardwareConcurrency
			double MemoryGb = 0; // navigator.deviceMemory (Chromium only, rounded and capped by the browser)
			std::string Gpu; // the unmasked renderer a WebGL context of the page's own names
			std::string Vendor; // and its vendor
			std::string Protocol; // location.protocol ("https:"), never sent
			std::string Host; // location.hostname, never sent
			std::string Search; // location.search, never sent
			std::string Url; // location.origin and pathname: where the game is played, sent (Address)
			std::string Referrer; // the origin of the page that led here (document.referrer's), or empty
		};

		/** The page script's JSON ({ua, mobile, dpr, screen, cores, memory, gpu, vendor, protocol, host, search, url,
		 * referrer}). */
		bool ParseFacts(const std::string& Json, FFacts& Out);

		struct FUserAgent
		{
			std::string Browser = "Other"; // Chrome, Safari, Firefox, Edge, Opera or Other
			std::string BrowserVersion; // its major version, or empty
			std::string Os = "Other"; // iOS, Android, macOS, Windows, ChromeOS, Linux or Other
			bool Mobile = false;
		};

		/** device.js's parseUserAgent, rule for rule: each browser's own token, the first rule that matches winning
		 * (Edge and Opera also say Chrome/, every iOS browser Safari/), and userAgentData's mobile where there is one. */
		FUserAgent ParseUserAgent(const std::string& Ua, int UadMobile);
		/** device.js's isSteamDeck: a user agent that names the Deck, or its GPU (AMD's Van Gogh, "Custom GPU 0405/0932"). */
		bool IsSteamDeck(const std::string& Ua, const std::string& Gpu);
		/** device.js's cleanGpu: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)" is "Apple M3 Pro". */
		std::string CleanGpu(const std::string& Renderer);
		/** device.js's cleanVendor: Apple, NVIDIA, AMD, Intel, Qualcomm, ARM, "Google (software)", or the vendor as given. */
		std::string CleanVendor(const std::string& Vendor, const std::string& Renderer);

		/** A page on the developer's own machine or network: a file, localhost, *.localhost, *.local, loopback and
		 * private addresses. A development build follows the debug rule there; a page anywhere else is played by
		 * players. The same rule as Godot's web exports (web_page.gd). */
		bool IsLocal(const std::string& Protocol, const std::string& Host);
		/** The flags a page's address may carry, as command-line flags: "?glitchless&x=1" is {"-glitchless"}. Only
		 * glitchless, glitchless-debug and glitchless-synthetic: the intake and the rest stay the game's to set, so a
		 * link can't point a player's data at another server. */
		std::vector<std::string> Flags(const std::string& Search);

		/** session_start's page, as the browser SDK sends it: {url, referrer}, the page's origin and path and the origin
		 * of the page that led there (null when none did), so the server can tell where the game was played (an itch.io
		 * frame, a Reddit post, its own site: $site, SPEC §3b). Never a query string, a fragment or a whole referrer.
		 * Null when the page gave no address. */
		FValue Address(const FFacts& Facts);
		/** The origin of an address, as the browser's URL(address).origin says it: "https://maker.itch.io" for
		 * "https://maker.itch.io/game?x=1", "null" for a file or another address with no origin of its own, and empty
		 * for none. The page script sends the referrer's origin already, and Address holds to it. */
		std::string OriginOf(const std::string& Url);

		/** session_start's device for a web build, as the browser SDK sends it: browser, browser_version (major), os,
		 * mobile, device_tier (from the page's cores and memory), gpu_tier, screen, dpr, refresh_hz (null) and
		 * steam_deck; detailed (full mode) adds gpu, gpu_vendor, cores and memory_gb. The engine's own renderer and
		 * driver are the caller's to add. */
		FValue Device(const FFacts& Facts, bool bDetailed);
	}
}
