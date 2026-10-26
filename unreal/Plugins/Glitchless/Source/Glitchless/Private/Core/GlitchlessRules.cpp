// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessRules.h"

#include "GlitchlessText.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace Glitchless
{
	namespace
	{
		bool IsDigit(char C) { return C >= '0' && C <= '9'; }
		bool IsHex(char C) { return IsDigit(C) || (C >= 'a' && C <= 'f') || (C >= 'A' && C <= 'F'); }
		bool IsUpper(char C) { return C >= 'A' && C <= 'Z'; }
		bool IsLowerLetter(char C) { return C >= 'a' && C <= 'z'; }
		bool IsBase64(char C) { return IsDigit(C) || IsUpper(C) || IsLowerLetter(C) || C == '+' || C == '/'; }

		uint32_t Rotl(uint32_t X, int N) { return (X << N) | (X >> (32 - N)); }

		// The built-in splits and filters a board reads by name, and the Steam facts: a property can't take their place.
		const char* const Reserved[] = {"version", "level", "env", "platform", "browser", "device_tier", "session_type", "privacy", "role", "link", "type", "players", "sessions", "hours",
			"zone", "match", "party", "run", "steam_build", "steam_branch", "steam_hardware", "steam_deck", "steam_controller", "steam_language", "proton", "big_picture", "family_shared", "timed_trial"};

		// Names that say who someone is, or where.
		const char* const Identifying[] = {"name", "username", "user", "email", "phone", "user_id", "account", "account_id", "player_id", "steam_id", "epic_id", "psn_id", "xbox_id", "ip",
			"address", "device_id", "idfa", "gaid", "ad_id", "location", "lat", "lon", "city", "birthday", "age", "gender"};

		bool OneOf(const std::string& S, const char* const* List, size_t Count)
		{
			for (size_t I = 0; I < Count; I++)
			{
				if (S == List[I])
				{
					return true;
				}
			}
			return false;
		}

		// Counts the digits in Text[At..] while it reads as a phone number written out: digits with spaces, dashes,
		// dots and brackets between them. Stops at anything else.
		int PhoneDigits(const std::string& S, size_t At)
		{
			int Digits = 0;
			for (size_t I = At; I < S.size(); I++)
			{
				const char C = S[I];
				if (IsDigit(C))
				{
					Digits++;
				}
				else if (C != ' ' && C != '-' && C != '.' && C != '(' && C != ')')
				{
					break;
				}
			}
			return Digits;
		}

		// Digits from At, exactly Count of them, then not a digit.
		bool DigitsAt(const std::string& S, size_t At, size_t Count)
		{
			if (At + Count > S.size())
			{
				return false;
			}
			for (size_t I = At; I < At + Count; I++)
			{
				if (!IsDigit(S[I]))
				{
					return false;
				}
			}
			return At + Count == S.size() || !IsDigit(S[At + Count]);
		}

		// A phone number as people write one: "+44 20 7946 0958", "(555) 123-4567" or "555-123-4567". A band such as
		// "3000-3499" or a date isn't one.
		bool HasPhoneNumber(const std::string& S)
		{
			for (size_t I = 0; I < S.size(); I++)
			{
				const bool Start = I == 0 || !IsDigit(S[I - 1]);
				if (S[I] == '+' && I + 1 < S.size() && IsDigit(S[I + 1]) && PhoneDigits(S, I + 1) >= 7)
				{
					return true;
				}
				if (S[I] == '(' && DigitsAt(S, I + 1, 3) && I + 4 < S.size() && S[I + 4] == ')')
				{
					size_t J = I + 5;
					if (J < S.size() && S[J] == ' ')
					{
						J++;
					}
					if (DigitsAt(S, J, 3) && J + 3 < S.size() && (S[J + 3] == '-' || S[J + 3] == '.' || S[J + 3] == ' ') && DigitsAt(S, J + 4, 4))
					{
						return true;
					}
				}
				if (Start && DigitsAt(S, I, 3) && I + 3 < S.size() && (S[I + 3] == '-' || S[I + 3] == '.' || S[I + 3] == ' ') && DigitsAt(S, I + 4, 3) && I + 7 < S.size()
					&& S[I + 7] == S[I + 3] && DigitsAt(S, I + 8, 4))
				{
					return true;
				}
			}
			return false;
		}

		bool HasUuid(const std::string& S)
		{
			static const int Groups[] = {8, 4, 4, 4, 12};
			for (size_t I = 0; I + 36 <= S.size(); I++)
			{
				size_t At = I;
				bool Ok = true;
				for (int G = 0; G < 5 && Ok; G++)
				{
					for (int K = 0; K < Groups[G]; K++, At++)
					{
						Ok = Ok && IsHex(S[At]);
					}
					if (G < 4)
					{
						Ok = Ok && S[At] == '-';
						At++;
					}
				}
				if (Ok)
				{
					return true;
				}
			}
			return false;
		}

		bool HasEmail(const std::string& S)
		{
			for (size_t At = S.find('@'); At != std::string::npos; At = S.find('@', At + 1))
			{
				if (At == 0 || S[At - 1] == ' ')
				{
					continue;
				}
				const size_t Dot = S.find('.', At + 2);
				const size_t Space = S.find(' ', At);
				if (Dot != std::string::npos && Dot + 1 < S.size() && (Space == std::string::npos || Dot < Space))
				{
					return true;
				}
			}
			return false;
		}
	}

	namespace Rules
	{
		std::string Sha1Hex(const std::string& Bytes)
		{
			uint32_t H[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
			std::string M = Bytes;
			const uint64_t Bits = static_cast<uint64_t>(Bytes.size()) * 8;
			M += static_cast<char>(0x80);
			while (M.size() % 64 != 56)
			{
				M += static_cast<char>(0);
			}
			for (int I = 7; I >= 0; I--)
			{
				M += static_cast<char>((Bits >> (I * 8)) & 0xFF);
			}
			uint32_t W[80];
			for (size_t Block = 0; Block < M.size(); Block += 64)
			{
				for (int I = 0; I < 16; I++)
				{
					const unsigned char* P = reinterpret_cast<const unsigned char*>(M.data() + Block + I * 4);
					W[I] = (static_cast<uint32_t>(P[0]) << 24) | (static_cast<uint32_t>(P[1]) << 16) | (static_cast<uint32_t>(P[2]) << 8) | P[3];
				}
				for (int I = 16; I < 80; I++)
				{
					W[I] = Rotl(W[I - 3] ^ W[I - 8] ^ W[I - 14] ^ W[I - 16], 1);
				}
				uint32_t A = H[0], B = H[1], C = H[2], D = H[3], E = H[4];
				for (int I = 0; I < 80; I++)
				{
					uint32_t F, K;
					if (I < 20)
					{
						F = (B & C) | (~B & D);
						K = 0x5A827999u;
					}
					else if (I < 40)
					{
						F = B ^ C ^ D;
						K = 0x6ED9EBA1u;
					}
					else if (I < 60)
					{
						F = (B & C) | (B & D) | (C & D);
						K = 0x8F1BBCDCu;
					}
					else
					{
						F = B ^ C ^ D;
						K = 0xCA62C1D6u;
					}
					const uint32_t T = Rotl(A, 5) + F + E + K + W[I];
					E = D;
					D = C;
					C = Rotl(B, 30);
					B = A;
					A = T;
				}
				H[0] += A;
				H[1] += B;
				H[2] += C;
				H[3] += D;
				H[4] += E;
			}
			static const char Digits[] = "0123456789abcdef";
			std::string Out;
			for (uint32_t V : H)
			{
				for (int Shift = 28; Shift >= 0; Shift -= 4)
				{
					Out += Digits[(V >> Shift) & 15];
				}
			}
			return Out;
		}

		bool IsGroupId(const std::string& Id)
		{
			if (Id.size() < 8 || Id.size() > 64)
			{
				return false;
			}
			for (const char C : Id)
			{
				if (!(IsDigit(C) || IsUpper(C) || IsLowerLetter(C) || C == '_' || C == '.' || C == ':' || C == '-'))
				{
					return false;
				}
			}
			return true;
		}

		std::string HashGroupId(const std::string& Service, const std::string& Id)
		{
			return "h_" + Sha1Hex(Text::Lower(Service) + ":" + Id).substr(0, 24);
		}

		std::string PropertyKeyProblem(const std::string& Key)
		{
			bool Shaped = !Key.empty() && Key.size() <= 32 && IsLowerLetter(Key[0]);
			for (const char C : Key)
			{
				Shaped = Shaped && (IsLowerLetter(C) || IsDigit(C) || C == '_');
			}
			if (!Shaped)
			{
				return "keys are lowercase letters, digits and _, starting with a letter, at most 32";
			}
			if (OneOf(Key, Reserved, sizeof(Reserved) / sizeof(Reserved[0])))
			{
				return "a built-in split has that name";
			}
			if (OneOf(Key, Identifying, sizeof(Identifying) / sizeof(Identifying[0])))
			{
				return "it names something that identifies a person";
			}
			return "";
		}

		bool PropertyValue(const FValue& In, FValue& Out, std::string& Why)
		{
			switch (In.GetType())
			{
			case FValue::EType::Bool:
				Out = In;
				return true;
			case FValue::EType::Int:
			case FValue::EType::Double:
			{
				const double D = In.AsNumber();
				if (!Json::IsFinite(D) || D != std::floor(D))
				{
					Why = "numbers are whole: send a band (\"30-39\") rather than an exact value";
					return false;
				}
				if (D < -1000000 || D > 1000000)
				{
					Why = "numbers are from -1,000,000 to 1,000,000";
					return false;
				}
				Out = FValue(static_cast<int64_t>(D));
				return true;
			}
			case FValue::EType::String:
			{
				const std::string S = Text::Truncate(Text::Trim(In.AsString()), 64);
				if (S.empty())
				{
					Why = "an empty string";
					return false;
				}
				if (LooksIdentifying(S))
				{
					Why = "it looks like an email address, a link, a phone number or an ID";
					return false;
				}
				Out = FValue(S);
				return true;
			}
			default:
				Why = "values are a string, a boolean or a whole number";
				return false;
			}
		}

		bool LooksIdentifying(const std::string& S)
		{
			const std::string L = Text::Lower(S);
			if (HasEmail(S) || L.find("://") != std::string::npos || L.find("www.") != std::string::npos || HasPhoneNumber(S) || HasUuid(S))
			{
				return true;
			}
			size_t DigitRun = 0, HexRun = 0, B64Run = 0;
			bool Upper = false, Lower = false, Digit = false;
			for (const char C : S)
			{
				DigitRun = IsDigit(C) ? DigitRun + 1 : 0;
				HexRun = IsHex(C) ? HexRun + 1 : 0;
				if (IsBase64(C))
				{
					B64Run++;
					Upper = Upper || IsUpper(C);
					Lower = Lower || IsLowerLetter(C);
					Digit = Digit || IsDigit(C);
				}
				else
				{
					B64Run = 0;
					Upper = Lower = Digit = false;
				}
				if (DigitRun >= 7 || HexRun >= 16 || (B64Run >= 16 && Upper && Lower && Digit))
				{
					return true;
				}
			}
			return false;
		}
	}
}
