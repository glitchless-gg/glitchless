// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "GlitchlessJson.h"

#include <string>

namespace Glitchless
{
	/**
	 * The rules every Glitchless SDK applies to what describes a session or a match, so the game's words about them
	 * can't turn into a player ID: match and party IDs, and session properties (docs/design/genre-coverage.md A6, A7).
	 * Intake checks them again, for older or other SDKs.
	 */
	namespace Rules
	{
		/** SHA-1 of the bytes, as 40 lowercase hex digits. Every engine has SHA-1 built in, so all of them hash a match alike. */
		std::string Sha1Hex(const std::string& Bytes);

		/** A match, party or run ID as the game gives it: 8 to 64 of [A-Za-z0-9_.:-]. */
		bool IsGroupId(const std::string& Id);
		/** What goes on the wire for a match or party ID: "h_" and the first 24 hex digits of SHA-1(service + ":" + id),
		 * salted with the game's own service (lowercased, never the ".server" companion) so a server and its players
		 * hash one match alike, and an ID can't be looked up as it is in the game's own match logs. */
		std::string HashGroupId(const std::string& Service, const std::string& Id);

		/** Why a property key can't be used ("" when it can): its shape, a built-in split's name, or a name that identifies. */
		std::string PropertyKeyProblem(const std::string& Key);
		/** Checks a property's value: a string (trimmed, cut to 64 characters), a boolean, or a whole number from
		 * -1,000,000 to 1,000,000. Out is the value to send; false, with Why, when it is dropped. */
		bool PropertyValue(const FValue& In, FValue& Out, std::string& Why);
		/** A value shaped like something that identifies a person or a device: an email address, a link, a phone
		 * number or 7 or more digits in a row, a UUID, 16 or more hex digits, or a 16-character run of base64 that
		 * mixes upper case, lower case and digits. */
		bool LooksIdentifying(const std::string& S);
	}
}
