// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include <cstdio>
#include <string>
#include <utility>
#include <vector>

namespace Glitchless
{
	/**
	 * The browser SDK's error grouping key (packages/sdk/src/fingerprint.js): the kind, the message
	 * with long numbers and addresses blanked out, and the function it came from, hashed with 32-bit
	 * FNV-1a over UTF-16 code units, as JavaScript strings are.
	 */
	namespace Fingerprint
	{
		std::u16string NormalizeMessage(const std::u16string& Message);
		std::string NormalizeMessage(const std::string& Message);
		std::string Hash(const std::u16string& S);
		std::string Of(const std::string& Kind, const std::string& Message, const std::string& Fn);
	}

	namespace Text
	{
		std::u16string ToUtf16(const std::string& Utf8);
		std::string ToUtf8(const std::u16string& Utf16);
		/** At most MaxUnits UTF-16 code units (what JavaScript's slice counts), never splitting a character. */
		std::string Truncate(const std::string& Utf8, size_t MaxUnits);
		std::string Trim(const std::string& S);
		std::string Lower(const std::string& S);
		bool StartsWith(const std::string& S, const std::string& Prefix);
		bool EndsWith(const std::string& S, const std::string& Suffix);
		std::vector<std::string> Lines(const std::string& S);
		void ReplaceAll(std::string& S, const std::string& From, const std::string& To);
		/** std::fopen, or MSVC's fopen_s, where fopen warns (C4996) and Unreal's plugin builds don't silence it. */
		std::FILE* OpenFile(const std::string& Path, const char* Mode);
	}

	/** One frame of a stack trace. */
	struct FStackFrame
	{
		std::string Fn;
		std::string File;
		int Line = 0;
	};

	/**
	 * Reads the stacks Unreal writes: ensure and crash callstacks, and Blueprint script stacks.
	 *   [Callstack] 0x00007ff6a1b2c3d4 MyGame.exe!AMyActor::BeginPlay() [D:\Game\Source\MyActor.cpp:42]
	 *   libUnrealEditor-MyGame.dylib!AMyActor::Tick(float) [/Users/me/Game/Source/MyActor.cpp:57]
	 *   MyGame!UnknownFunction []
	 *   Function /Game/BP_Player.BP_Player_C:ReceiveTick
	 */
	namespace StackParser
	{
		std::vector<FStackFrame> Parse(const std::string& Stack);
		/** Frames that are Unreal's logging, assert and crash handling, not the game's code. */
		bool IsPlumbing(const FStackFrame& F);
		bool IsGlitchless(const FStackFrame& F);
		bool IsEngine(const FStackFrame& F);
		/** The frame to name as the error's place: the first in the game's own code, else the first with a source file, else the first. */
		int TopIndex(const std::vector<FStackFrame>& Frames);
		std::string BaseName(const std::string& Path);
		/** The stack as Glitchless sends it, the shape every SDK uses: "kind: message" then "    at fn (file:line)". */
		std::string Format(const std::string& Kind, const std::string& Message, const std::vector<FStackFrame>& Frames);
		/** What crashed, from Unreal's GErrorHist and GErrorExceptionDescription. An assert or a fatal error puts its
		 * message in GErrorHist, then a blank line and the callstack; a signal or an exception puts only the
		 * callstack there, and what it was in the description ("SIGSEGV: invalid attempt to access memory..."). */
		void DescribeCrash(const std::string& ErrorHist, const std::string& ExceptionDescription, std::string& OutMessage, std::string& OutStack);
	}

	/**
	 * Error text can hold paths on the device, and a path can hold the computer's user name or, on
	 * iPhone, an ID made for this install of the app. Both go, in every privacy mode.
	 */
	class FScrubber
	{
	public:
		/** A folder to shorten to a name, such as the project's Saved folder to "saved:". */
		void AddPath(const std::string& Path, const std::string& Name);
		std::string Scrub(const std::string& Input) const;

	private:
		std::vector<std::pair<std::string, std::string>> Paths;
	};

	/** What session_start says about the device. PRIVACY.md lists every field each mode sends. */
	namespace DeviceFacts
	{
		/** low / mid / high from cores and memory: coarse enough that it can't tell one device from another of its kind. */
		std::string DeviceTier(int Cores, double MemGb);
		/** The browser SDK's GPU tiers (packages/sdk/src/device.js), for desktops. */
		std::string GpuTier(const std::string& AdapterName);

		/** What a Steam Deck says about itself. Steam sets SteamDeck=1 for games it starts on one, Proton included. */
		struct FSteamDeckFacts
		{
			std::string Env; // $SteamDeck
			std::string BoardVendor; // /sys/class/dmi/id/board_vendor
			std::string BoardName; // /sys/class/dmi/id/board_name: Jupiter (LCD) or Galileo (OLED)
			std::string OsRelease; // /etc/os-release
		};
		bool IsSteamDeck(const FSteamDeckFacts& Facts);
		bool IsSteamOS(const FSteamDeckFacts& Facts);
		std::string SteamDeckModel(const FSteamDeckFacts& Facts);
	}

	namespace Levels
	{
		/** A map's name, or empty when the map reads as a menu, loader, lobby, overlay or end screen (Entry, MainMenu, L_Frontend, Loading, GameOver...). */
		std::string LevelForMap(const std::string& MapName);
	}
}
