// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessPage.h"

#include "GlitchlessSketch.h"
#include "GlitchlessText.h"

#include <cstring>
#include <initializer_list>

namespace Glitchless
{
	namespace Page
	{
		namespace
		{
			bool IsDigit(char C) { return C >= '0' && C <= '9'; }
			bool IsHex(char C) { return IsDigit(C) || (C >= 'a' && C <= 'f') || (C >= 'A' && C <= 'F'); }
			bool IsSpace(char C) { return C == ' ' || C == '\t' || C == '\n' || C == '\r' || C == '\v' || C == '\f'; }
			// JavaScript's \w, for \b
			bool IsWord(char C) { return IsDigit(C) || (C >= 'a' && C <= 'z') || (C >= 'A' && C <= 'Z') || C == '_'; }

			bool Contains(const std::string& S, const char* Part) { return S.find(Part) != std::string::npos; }

			bool ContainsAny(const std::string& S, std::initializer_list<const char*> Parts)
			{
				for (const char* P : Parts)
				{
					if (Contains(S, P))
					{
						return true;
					}
				}
				return false;
			}

			int HexValue(char C) { return IsDigit(C) ? C - '0' : (C >= 'a' && C <= 'f') ? C - 'a' + 10 : C - 'A' + 10; }

			// device.js's BROWSERS, in its order. "Edg(?:e|A|iOS)?/" tries Edge, EdgA and EdgiOS before Edg at each place.
			struct FBrowserRule
			{
				const char* Names[5]; // ends with nullptr
				const char* Browser;
			};
			const FBrowserRule BrowserRules[] = {
				{{"Edge", "EdgA", "EdgiOS", "Edg", nullptr}, "Edge"},
				{{"OPR", nullptr}, "Opera"},
				{{"Firefox", "FxiOS", nullptr}, "Firefox"},
				{{"Chrome", "CriOS", nullptr}, "Chrome"},
				{{"Version", nullptr}, "Safari"},
				{{"Safari", nullptr}, "Safari"},
			};

			// The first place in Ua where one of Names (tried in order at each place, as a regex's alternatives are)
			// is followed by "/" and digits: those digits, or empty. device.js's /(?:A|B)\/(\d+)/.
			std::string LeftmostVersion(const std::string& Ua, const char* const* Names)
			{
				for (size_t At = 0; At < Ua.size(); At++)
				{
					for (const char* const* It = Names; *It; ++It)
					{
						const char* Name = *It;
						const size_t N = std::strlen(Name);
						if (Ua.compare(At, N, Name) != 0 || At + N + 1 >= Ua.size() || Ua[At + N] != '/' || !IsDigit(Ua[At + N + 1]))
						{
							continue;
						}
						size_t End = At + N + 1;
						while (End < Ua.size() && IsDigit(Ua[End]))
						{
							End++;
						}
						return Ua.substr(At + N + 1, End - (At + N + 1));
					}
				}
				return std::string();
			}

			// Removes the first match of /\s*<Word>.*$/ (the word, the spaces before it and the rest of the line).
			void CutFrom(std::string& S, const char* Word)
			{
				size_t At = S.find(Word);
				if (At == std::string::npos)
				{
					return;
				}
				while (At > 0 && IsSpace(S[At - 1]))
				{
					At--;
				}
				S.erase(At);
			}

			std::string PercentDecode(const std::string& S)
			{
				std::string Out;
				for (size_t I = 0; I < S.size(); I++)
				{
					if (S[I] == '%' && I + 2 < S.size() && IsHex(S[I + 1]) && IsHex(S[I + 2]))
					{
						Out += static_cast<char>(HexValue(S[I + 1]) * 16 + HexValue(S[I + 2]));
						I += 2;
					}
					else
					{
						Out += S[I];
					}
				}
				return Out;
			}

			std::string StringField(const FValue& V, const char* Key)
			{
				const FValue* F = V.Find(Key);
				return F && F->IsString() ? F->AsString() : std::string();
			}

			double NumberField(const FValue& V, const char* Key)
			{
				const FValue* F = V.Find(Key);
				return F && F->IsNumber() ? F->AsNumber() : 0;
			}
		}

		bool ParseFacts(const std::string& Json, FFacts& Out)
		{
			FValue V;
			if (!FValue::Parse(Json, V) || !V.IsObject())
			{
				return false;
			}
			Out = FFacts();
			Out.Ua = StringField(V, "ua");
			const FValue* Mobile = V.Find("mobile");
			Out.UadMobile = Mobile && Mobile->GetType() == FValue::EType::Bool ? (Mobile->AsBool() ? 1 : 0) : -1;
			Out.Dpr = NumberField(V, "dpr");
			const FValue* Screen = V.Find("screen");
			if (Screen && Screen->IsArray() && Screen->Size() == 2 && (*Screen)[0].IsNumber() && (*Screen)[1].IsNumber())
			{
				Out.ScreenWidth = static_cast<int>((*Screen)[0].AsNumber());
				Out.ScreenHeight = static_cast<int>((*Screen)[1].AsNumber());
			}
			Out.Cores = NumberField(V, "cores");
			Out.MemoryGb = NumberField(V, "memory");
			Out.Gpu = StringField(V, "gpu");
			Out.Vendor = StringField(V, "vendor");
			Out.Protocol = StringField(V, "protocol");
			Out.Host = StringField(V, "host");
			Out.Search = StringField(V, "search");
			return true;
		}

		FUserAgent ParseUserAgent(const std::string& Ua, int UadMobile)
		{
			FUserAgent R;
			for (const FBrowserRule& B : BrowserRules)
			{
				const std::string Version = LeftmostVersion(Ua, B.Names);
				if (!Version.empty())
				{
					R.Browser = B.Browser;
					R.BrowserVersion = Version;
					break;
				}
			}
			if (ContainsAny(Ua, {"iPhone", "iPad", "iPod"}))
			{
				R.Os = "iOS";
			}
			else if (Contains(Ua, "Android"))
			{
				R.Os = "Android";
			}
			else if (ContainsAny(Ua, {"Mac OS X", "Macintosh"}))
			{
				R.Os = "macOS";
			}
			else if (Contains(Ua, "Windows"))
			{
				R.Os = "Windows";
			}
			else if (Contains(Ua, "CrOS"))
			{
				R.Os = "ChromeOS";
			}
			else if (Contains(Ua, "Linux"))
			{
				R.Os = "Linux";
			}
			R.Mobile = UadMobile >= 0 ? UadMobile == 1 : ContainsAny(Ua, {"Mobi", "Android", "iPhone", "iPad"});
			return R;
		}

		bool IsSteamDeck(const std::string& Ua, const std::string& Gpu)
		{
			const std::string A = Text::Lower(Ua);
			if (Contains(A, "steamdeck") || Contains(A, "steam deck"))
			{
				return true;
			}
			const std::string G = Text::Lower(Gpu);
			for (size_t At = G.find("vangogh"); At != std::string::npos; At = G.find("vangogh", At + 1))
			{
				const size_t End = At + 7;
				if ((At == 0 || !IsWord(G[At - 1])) && (End == G.size() || !IsWord(G[End])))
				{
					return true;
				}
			}
			for (const char* Model : {"custom gpu 0405", "custom gpu 0932"})
			{
				const size_t N = std::strlen(Model);
				for (size_t At = G.find(Model); At != std::string::npos; At = G.find(Model, At + 1))
				{
					if (At + N == G.size() || !IsWord(G[At + N]))
					{
						return true;
					}
				}
			}
			return false;
		}

		std::string CleanGpu(const std::string& Renderer)
		{
			if (Renderer.empty())
			{
				return "unknown";
			}
			// /ANGLE \((.+)\)/: from the first "ANGLE (" to the last ")" after it, with something between.
			const size_t Open = Renderer.find("ANGLE (");
			const size_t Close = Open == std::string::npos ? std::string::npos : Renderer.rfind(')');
			if (Open == std::string::npos || Close == std::string::npos || Close <= Open + 7)
			{
				return Text::Trim(Renderer);
			}
			const std::string Inside = Renderer.substr(Open + 7, Close - (Open + 7));
			std::vector<std::string> Parts;
			size_t From = 0;
			for (size_t Comma = Inside.find(','); ; Comma = Inside.find(',', From))
			{
				Parts.push_back(Text::Trim(Inside.substr(From, Comma == std::string::npos ? std::string::npos : Comma - From)));
				if (Comma == std::string::npos)
				{
					break;
				}
				From = Comma + 1;
			}
			std::string Name = Parts.size() > 1 && !Parts[1].empty() ? Parts[1] : Parts[0];
			const std::string Metal = "ANGLE Metal Renderer:";
			if (Text::StartsWith(Name, Metal))
			{
				size_t I = Metal.size();
				while (I < Name.size() && IsSpace(Name[I]))
				{
					I++;
				}
				Name.erase(0, I);
			}
			CutFrom(Name, "Direct3D");
			// /\s*\(0x[0-9A-Fa-f]+\)/g
			for (size_t At = Name.find("(0x"); At != std::string::npos; At = Name.find("(0x", At))
			{
				size_t I = At + 3;
				while (I < Name.size() && IsHex(Name[I]))
				{
					I++;
				}
				if (I == At + 3 || I >= Name.size() || Name[I] != ')')
				{
					At++;
					continue;
				}
				size_t Start = At;
				while (Start > 0 && IsSpace(Name[Start - 1]))
				{
					Start--;
				}
				Name.erase(Start, I + 1 - Start);
				At = Start;
			}
			// /\s*vs_\d_\d.*$/
			for (size_t At = Name.find("vs_"); At != std::string::npos; At = Name.find("vs_", At + 1))
			{
				if (At + 5 < Name.size() && IsDigit(Name[At + 3]) && Name[At + 4] == '_' && IsDigit(Name[At + 5]))
				{
					size_t Start = At;
					while (Start > 0 && IsSpace(Name[Start - 1]))
					{
						Start--;
					}
					Name.erase(Start);
					break;
				}
			}
			CutFrom(Name, "OpenGL");
			Name = Text::Trim(Name);
			return Name.empty() ? Renderer : Name;
		}

		std::string CleanVendor(const std::string& Vendor, const std::string& Renderer)
		{
			const std::string S = Text::Lower(Vendor + " " + Renderer);
			if (Contains(S, "apple"))
			{
				return "Apple";
			}
			if (ContainsAny(S, {"nvidia", "geforce"}))
			{
				return "NVIDIA";
			}
			if (ContainsAny(S, {"amd", "radeon"}))
			{
				return "AMD";
			}
			if (Contains(S, "intel"))
			{
				return "Intel";
			}
			if (ContainsAny(S, {"qualcomm", "adreno"}))
			{
				return "Qualcomm";
			}
			if (ContainsAny(S, {"arm", "mali"}))
			{
				return "ARM";
			}
			if (ContainsAny(S, {"swiftshader", "google"}))
			{
				return "Google (software)";
			}
			return Vendor.empty() ? "unknown" : Vendor;
		}

		bool IsLocal(const std::string& Protocol, const std::string& Host)
		{
			std::string H = Text::Lower(Host);
			if (Text::StartsWith(H, "["))
			{
				H.erase(0, 1);
			}
			if (Text::EndsWith(H, "]"))
			{
				H.pop_back();
			}
			if (Protocol == "file:" || H.empty() || H == "localhost" || H == "::1" || Text::EndsWith(H, ".localhost") || Text::EndsWith(H, ".local"))
			{
				return true;
			}
			if (Text::StartsWith(H, "127.") || Text::StartsWith(H, "10.") || Text::StartsWith(H, "192.168.") || Text::StartsWith(H, "169.254."))
			{
				return true;
			}
			// 172.16. to 172.31.
			if (Text::StartsWith(H, "172.") && H.size() >= 7 && IsDigit(H[4]) && IsDigit(H[5]) && H[6] == '.')
			{
				const int Second = (H[4] - '0') * 10 + (H[5] - '0');
				return Second >= 16 && Second <= 31;
			}
			return false;
		}

		std::vector<std::string> Flags(const std::string& Search)
		{
			static const char* const Allowed[] = {"glitchless", "glitchless-debug", "glitchless-synthetic"};
			std::vector<std::string> Out;
			const std::string S = Text::StartsWith(Search, "?") ? Search.substr(1) : Search;
			size_t From = 0;
			while (From <= S.size())
			{
				size_t Amp = S.find('&', From);
				if (Amp == std::string::npos)
				{
					Amp = S.size();
				}
				const std::string Pair = S.substr(From, Amp - From);
				const size_t Eq = Pair.find('=');
				const std::string Key = PercentDecode(Eq == std::string::npos ? Pair : Pair.substr(0, Eq));
				for (const char* A : Allowed)
				{
					if (!Pair.empty() && Key == A)
					{
						Out.push_back(std::string("-") + A);
					}
				}
				From = Amp + 1;
			}
			return Out;
		}

		FValue Device(const FFacts& Facts, bool bDetailed)
		{
			const FUserAgent U = ParseUserAgent(Facts.Ua, Facts.UadMobile);
			const std::string Gpu = CleanGpu(Facts.Gpu);
			const bool bDeck = IsSteamDeck(Facts.Ua, Facts.Gpu);
			FValue D = FValue::Object();
			D.Set("browser", U.Browser);
			D.Set("browser_version", U.BrowserVersion.empty() ? FValue() : FValue(U.BrowserVersion));
			D.Set("os", U.Os);
			D.Set("mobile", U.Mobile);
			D.Set("device_tier", DeviceFacts::DeviceTier(static_cast<int>(Facts.Cores), Facts.MemoryGb));
			D.Set("gpu_tier", bDeck ? std::string("low") : DeviceFacts::GpuTier(Gpu)); // a Deck is "low", as everywhere
			D.Set("screen", Facts.ScreenWidth > 0 && Facts.ScreenHeight > 0 ? FValue::List({Facts.ScreenWidth, Facts.ScreenHeight}) : FValue());
			D.Set("dpr", Facts.Dpr > 0 ? FValue(FSketch::Round(Facts.Dpr, 2)) : FValue());
			D.Set("refresh_hz", FValue());
			D.Set("steam_deck", bDeck);
			if (bDetailed)
			{
				D.Set("gpu", Gpu);
				D.Set("gpu_vendor", CleanVendor(Facts.Vendor, Facts.Gpu));
				D.Set("cores", Facts.Cores > 0 ? FValue(static_cast<int>(Facts.Cores)) : FValue());
				D.Set("memory_gb", Facts.MemoryGb > 0 ? FValue(Facts.MemoryGb) : FValue());
			}
			return D;
		}
	}
}
