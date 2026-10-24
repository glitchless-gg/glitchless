// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessText.h"

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <initializer_list>

namespace Glitchless
{
	namespace
	{
		bool IsSpace(char C) { return C == ' ' || C == '\t' || C == '\n' || C == '\r' || C == '\v' || C == '\f'; }
		bool IsDigit(char C) { return C >= '0' && C <= '9'; }
		bool IsHex(char C) { return IsDigit(C) || (C >= 'a' && C <= 'f') || (C >= 'A' && C <= 'F'); }
		bool IsUpper(char C) { return C >= 'A' && C <= 'Z'; }
		bool IsLowerOrDigit(char C) { return (C >= 'a' && C <= 'z') || IsDigit(C); }
		bool IsWord(char C) { return IsDigit(C) || (C >= 'a' && C <= 'z') || IsUpper(C) || C == '_'; }

		// Decodes one UTF-8 character at S[I], moving I past it. Bad bytes read as U+FFFD.
		uint32_t NextCodePoint(const std::string& S, size_t& I)
		{
			const unsigned char C = static_cast<unsigned char>(S[I++]);
			if (C < 0x80)
			{
				return C;
			}
			int More = C >= 0xF0 ? 3 : C >= 0xE0 ? 2 : C >= 0xC0 ? 1 : -1;
			if (More < 0 || C >= 0xF8)
			{
				return 0xFFFD;
			}
			uint32_t Cp = C & (0x3F >> More);
			for (; More > 0; More--)
			{
				if (I >= S.size() || (static_cast<unsigned char>(S[I]) & 0xC0) != 0x80)
				{
					return 0xFFFD;
				}
				Cp = (Cp << 6) | (static_cast<unsigned char>(S[I++]) & 0x3F);
			}
			return Cp > 0x10FFFF ? 0xFFFD : Cp;
		}

		void AppendUtf8(std::string& Out, uint32_t Cp)
		{
			if (Cp < 0x80)
			{
				Out += static_cast<char>(Cp);
			}
			else if (Cp < 0x800)
			{
				Out += static_cast<char>(0xC0 | (Cp >> 6));
				Out += static_cast<char>(0x80 | (Cp & 0x3F));
			}
			else if (Cp < 0x10000)
			{
				Out += static_cast<char>(0xE0 | (Cp >> 12));
				Out += static_cast<char>(0x80 | ((Cp >> 6) & 0x3F));
				Out += static_cast<char>(0x80 | (Cp & 0x3F));
			}
			else
			{
				Out += static_cast<char>(0xF0 | (Cp >> 18));
				Out += static_cast<char>(0x80 | ((Cp >> 12) & 0x3F));
				Out += static_cast<char>(0x80 | ((Cp >> 6) & 0x3F));
				Out += static_cast<char>(0x80 | (Cp & 0x3F));
			}
		}

		bool ScrubbedNameChar(char C) { return C != '/' && C != '\\' && !IsSpace(C) && C != '\'' && C != '"'; }
	}

	// ───────────────────────────── text ─────────────────────────────

	namespace Text
	{
		std::FILE* OpenFile(const std::string& Path, const char* Mode)
		{
#if defined(_MSC_VER)
			std::FILE* F = nullptr;
			return fopen_s(&F, Path.c_str(), Mode) == 0 ? F : nullptr;
#else
			return std::fopen(Path.c_str(), Mode);
#endif
		}

		std::u16string ToUtf16(const std::string& Utf8)
		{
			std::u16string Out;
			Out.reserve(Utf8.size());
			for (size_t I = 0; I < Utf8.size();)
			{
				const uint32_t Cp = NextCodePoint(Utf8, I);
				if (Cp >= 0x10000)
				{
					Out += static_cast<char16_t>(0xD800 + ((Cp - 0x10000) >> 10));
					Out += static_cast<char16_t>(0xDC00 + ((Cp - 0x10000) & 0x3FF));
				}
				else
				{
					Out += static_cast<char16_t>(Cp);
				}
			}
			return Out;
		}

		std::string ToUtf8(const std::u16string& Utf16)
		{
			std::string Out;
			Out.reserve(Utf16.size());
			for (size_t I = 0; I < Utf16.size(); I++)
			{
				uint32_t Cp = Utf16[I];
				if (Cp >= 0xD800 && Cp < 0xDC00 && I + 1 < Utf16.size() && Utf16[I + 1] >= 0xDC00 && Utf16[I + 1] < 0xE000)
				{
					Cp = 0x10000 + ((Cp - 0xD800) << 10) + (Utf16[++I] - 0xDC00);
				}
				else if (Cp >= 0xD800 && Cp < 0xE000)
				{
					Cp = 0xFFFD; // half a pair
				}
				AppendUtf8(Out, Cp);
			}
			return Out;
		}

		std::string Truncate(const std::string& Utf8, size_t MaxUnits)
		{
			size_t Units = 0;
			for (size_t I = 0; I < Utf8.size();)
			{
				const size_t Start = I;
				const uint32_t Cp = NextCodePoint(Utf8, I);
				Units += Cp >= 0x10000 ? 2 : 1;
				if (Units > MaxUnits)
				{
					return Utf8.substr(0, Start);
				}
			}
			return Utf8;
		}

		std::string Trim(const std::string& S)
		{
			size_t B = 0;
			size_t E = S.size();
			while (B < E && IsSpace(S[B]))
			{
				B++;
			}
			while (E > B && IsSpace(S[E - 1]))
			{
				E--;
			}
			return S.substr(B, E - B);
		}

		std::string Lower(const std::string& S)
		{
			std::string Out(S);
			for (char& C : Out)
			{
				if (IsUpper(C))
				{
					C = static_cast<char>(C - 'A' + 'a');
				}
			}
			return Out;
		}

		bool StartsWith(const std::string& S, const std::string& Prefix)
		{
			return S.size() >= Prefix.size() && S.compare(0, Prefix.size(), Prefix) == 0;
		}

		bool EndsWith(const std::string& S, const std::string& Suffix)
		{
			return S.size() >= Suffix.size() && S.compare(S.size() - Suffix.size(), Suffix.size(), Suffix) == 0;
		}

		std::vector<std::string> Lines(const std::string& S)
		{
			std::vector<std::string> Out;
			size_t Start = 0;
			for (size_t I = 0; I <= S.size(); I++)
			{
				if (I == S.size() || S[I] == '\n')
				{
					std::string Line = S.substr(Start, I - Start);
					if (!Line.empty() && Line.back() == '\r')
					{
						Line.pop_back();
					}
					Out.push_back(std::move(Line));
					Start = I + 1;
				}
			}
			return Out;
		}

		void ReplaceAll(std::string& S, const std::string& From, const std::string& To)
		{
			if (From.empty())
			{
				return;
			}
			for (size_t At = S.find(From); At != std::string::npos; At = S.find(From, At + To.size()))
			{
				S.replace(At, From.size(), To);
			}
		}
	}

	// ───────────────────────────── fingerprints ─────────────────────────────

	namespace Fingerprint
	{
		std::u16string NormalizeMessage(const std::u16string& Message)
		{
			auto Digit = [](char16_t C) { return C >= u'0' && C <= u'9'; }; // JavaScript's \d: ASCII digits only
			auto HexDigit = [&](char16_t C) { return Digit(C) || (C >= u'a' && C <= u'f') || (C >= u'A' && C <= u'F'); };
			auto Space = [](char16_t C) { return C == u' ' || C == u'\t' || C == u'\n' || C == u'\r' || C == u'\v' || C == u'\f' || C == 0xA0 || C == 0xFEFF || C == 0x2028 || C == 0x2029; };

			// .replace(/^Uncaught\s+/, '')
			std::u16string S = Message;
			const std::u16string Uncaught = u"Uncaught";
			if (S.compare(0, Uncaught.size(), Uncaught) == 0 && S.size() > Uncaught.size() && Space(S[Uncaught.size()]))
			{
				size_t I = Uncaught.size();
				while (I < S.size() && Space(S[I]))
				{
					I++;
				}
				S.erase(0, I);
			}
			// .replace(/\d{3,}/g, 'N')
			std::u16string D;
			for (size_t I = 0; I < S.size();)
			{
				size_t J = I;
				while (J < S.size() && Digit(S[J]))
				{
					J++;
				}
				if (J - I >= 3)
				{
					D += u'N';
					I = J;
				}
				else if (J > I)
				{
					D.append(S, I, J - I);
					I = J;
				}
				else
				{
					D += S[I++];
				}
			}
			// .replace(/0x[0-9a-f]+/gi, 'X')
			std::u16string H;
			for (size_t I = 0; I < D.size();)
			{
				if (D[I] == u'0' && I + 2 < D.size() && (D[I + 1] == u'x' || D[I + 1] == u'X') && HexDigit(D[I + 2]))
				{
					size_t J = I + 2;
					while (J < D.size() && HexDigit(D[J]))
					{
						J++;
					}
					H += u'X';
					I = J;
				}
				else
				{
					H += D[I++];
				}
			}
			// .slice(0, 200)
			if (H.size() > 200)
			{
				H.resize(200);
			}
			return H;
		}

		std::string NormalizeMessage(const std::string& Message)
		{
			return Text::ToUtf8(NormalizeMessage(Text::ToUtf16(Message)));
		}

		std::string Hash(const std::u16string& S)
		{
			uint32_t H = 0x811c9dc5u;
			for (const char16_t C : S)
			{
				H ^= C;
				H *= 0x01000193u;
			}
			static const char Hex[] = "0123456789abcdef";
			std::string Out(8, '0');
			for (int I = 7; I >= 0; I--)
			{
				Out[I] = Hex[H & 15];
				H >>= 4;
			}
			return Out;
		}

		std::string Of(const std::string& Kind, const std::string& Message, const std::string& Fn)
		{
			std::u16string S = Text::ToUtf16(Kind);
			S += u'|';
			S += NormalizeMessage(Text::ToUtf16(Message));
			S += u'|';
			S += Text::ToUtf16(Fn);
			return Hash(S);
		}
	}

	// ───────────────────────────── stacks ─────────────────────────────

	namespace StackParser
	{
		static const char* const Plumbing[] = {
			"FDebug::", "FOutputDevice", "FMsg::", "UE::Logging::", "UE::Assert::", "UE::Core::Private::",
			"FGenericPlatformStackWalk", "FWindowsPlatformStackWalk", "FMacPlatformStackWalk", "FApplePlatformStackWalk",
			"FUnixPlatformStackWalk", "FLinuxPlatformStackWalk", "FPlatformStackWalk", "FAndroidPlatformStackWalk", "FIOSPlatformStackWalk",
			"FGenericPlatformMisc::RaiseException", "FWindowsPlatformMisc::RaiseException", "FWindowsErrorOutputDevice", "FMacErrorOutputDevice",
			"FApplePlatformMisc", "FWindowsPlatformMisc::PromptForRemoteDebugging", "ReportAssert", "ReportEnsure", "ReportCrash",
			"CheckVerifyFailedImpl", "DispatchCheckVerify", "AssertFailedImplV", "StaticFailDebug", "LowLevelFatalErrorHandler",
			"FFrame::KismetExecutionMessage", "FKismetDebugUtilities", "FBlueprintCoreDelegates", "RtlDispatchException",
			"KiUserExceptionDispatcher", "RaiseException", "_CxxThrowException", "__scrt_", "_sigtramp", "PlatformCrashHandler",
			// A system library frame on an iPhone, whose name iOS keeps to itself (the signal trampoline, among others).
			"<redacted>",
		};

		static std::string StripArgs(std::string Fn);

		// Strips "(int, float)" and " + 12 bytes" off a function name, and a lambda's name to the function
		// it is in: "AFoo::Bar(float)::$_0::operator()" (clang) and "`AFoo::Bar'::`2'::<lambda_1>::operator()" (MSVC).
		static std::string CleanFn(std::string Fn)
		{
			for (const char* Lambda : {"::$_", "::<lambda", "'::`"})
			{
				const size_t At = Fn.find(Lambda);
				if (At != std::string::npos && At > 0)
				{
					Fn.resize(At);
					if (!Fn.empty() && Fn[0] == '`')
					{
						Fn.erase(0, 1);
					}
					if (!Fn.empty() && Fn.back() == '\'')
					{
						Fn.pop_back();
					}
				}
			}
			return StripArgs(std::move(Fn));
		}

		static std::string StripArgs(std::string Fn)
		{
			const size_t Bytes = Fn.find(" + ");
			if (Bytes != std::string::npos && Text::EndsWith(Fn, " bytes"))
			{
				Fn.resize(Bytes);
			}
			Fn = Text::Trim(Fn);
			if (Text::EndsWith(Fn, " const"))
			{
				Fn.resize(Fn.size() - 6);
			}
			if (!Fn.empty() && Fn.back() == ')')
			{
				int Depth = 0;
				for (size_t I = Fn.size(); I-- > 0;)
				{
					if (Fn[I] == ')')
					{
						Depth++;
					}
					else if (Fn[I] == '(' && --Depth == 0)
					{
						if (I > 0)
						{
							Fn.resize(I);
						}
						break;
					}
				}
			}
			return Text::Trim(Fn);
		}

		std::vector<FStackFrame> Parse(const std::string& Stack)
		{
			std::vector<FStackFrame> Frames;
			for (const std::string& Raw : Text::Lines(Stack))
			{
				std::string Line = Text::Trim(Raw);
				if (Text::StartsWith(Line, "[Callstack]"))
				{
					Line = Text::Trim(Line.substr(11));
				}
				if (Line.empty() || Line.back() == ':' || Text::StartsWith(Line, "Script Stack") || Text::StartsWith(Line, "Script call stack"))
				{
					continue; // "Stack:", "Script call stack:" and other headings
				}
				// A leading address: 0x00007ff6a1b2c3d4
				if (Text::StartsWith(Line, "0x"))
				{
					size_t I = 2;
					while (I < Line.size() && IsHex(Line[I]))
					{
						I++;
					}
					if (I == Line.size())
					{
						FStackFrame F;
						F.Fn = Line; // an address and nothing else: no symbols
						Frames.push_back(F);
						continue;
					}
					if (Line[I] == ' ')
					{
						Line = Text::Trim(Line.substr(I));
					}
				}
				// Unreal's Apple stack walker writes "[UnknownFile])" (sic).
				if (Text::EndsWith(Line, "])"))
				{
					Line.pop_back();
				}
				FStackFrame F;
				std::string FnPart = Line;
				// [File:Line] at the end
				if (Line.back() == ']')
				{
					const size_t Open = Line.rfind(" [");
					if (Open != std::string::npos)
					{
						const std::string Location = Line.substr(Open + 2, Line.size() - Open - 3);
						FnPart = Line.substr(0, Open);
						const size_t Colon = Location.rfind(':');
						if (Colon != std::string::npos && Colon > 0)
						{
							const std::string File = Location.substr(0, Colon);
							if (File != "UnknownFile" && !File.empty())
							{
								F.File = File;
								F.Line = std::atoi(Location.c_str() + Colon + 1);
							}
						}
					}
				}
				// Module!Function
				const size_t Bang = FnPart.find('!');
				if (Bang != std::string::npos && FnPart.find(' ') > Bang)
				{
					FnPart = FnPart.substr(Bang + 1);
				}
				// A Blueprint frame: "Function /Game/BP_Player.BP_Player_C:ReceiveTick"
				if (Text::StartsWith(FnPart, "Function "))
				{
					FnPart = Text::Trim(FnPart.substr(9));
				}
				if (!FnPart.empty() && FnPart[0] == '/')
				{
					const size_t Slash = FnPart.rfind('/');
					FnPart = FnPart.substr(Slash + 1);
					const size_t Dot = FnPart.find('.');
					if (Dot != std::string::npos && FnPart.find(':') != std::string::npos)
					{
						FnPart = FnPart.substr(Dot + 1);
					}
					for (char& C : FnPart)
					{
						if (C == ':')
						{
							C = '.';
						}
					}
				}
				F.Fn = CleanFn(FnPart);
				if (F.Fn.empty())
				{
					continue;
				}
				Frames.push_back(F);
			}
			return Frames;
		}

		bool IsPlumbing(const FStackFrame& F)
		{
			for (const char* P : Plumbing)
			{
				if (Text::StartsWith(F.Fn, P))
				{
					return true;
				}
			}
			return false;
		}

		bool IsGlitchless(const FStackFrame& F)
		{
			// The plugin's own names, whole: a game's UGlitchlessTestScript is the game's.
			static const char* const Own[] = {
				"Glitchless::", "GlitchlessBugReport::", "GlitchlessDevice::", "GlitchlessText::", "GlitchlessSignals::", "GlitchlessWindows::", "FGlitchless::",
				"FGlitchlessRuntime::", "FGlitchlessHttpTransport::", "FGlitchlessOutputDevice::", "FGlitchlessInputProcessor::",
				"FGlitchlessModule::", "UGlitchlessSubsystem::", "UGlitchlessBlueprintLibrary::", "UGlitchlessSettings::",
				"UGlitchlessToolset::", "SGlitchlessBugReport::",
			};
			for (const char* P : Own)
			{
				if (Text::StartsWith(F.Fn, P))
				{
					return true;
				}
			}
			return F.File.find("/Plugins/Glitchless/") != std::string::npos || F.File.find("\\Plugins\\Glitchless\\") != std::string::npos;
		}

		bool IsEngine(const FStackFrame& F)
		{
			if (!F.File.empty())
			{
				for (const char* Dir : {"/Engine/Source/", "\\Engine\\Source\\", "/Engine/Plugins/", "\\Engine\\Plugins\\", "/Engine/Platforms/", "\\Engine\\Platforms\\"})
				{
					if (F.File.find(Dir) != std::string::npos)
					{
						return true;
					}
				}
				return false;
			}
			static const char* const EngineFns[] = {
				"UE::", "FEngineLoop", "GuardedMain", "WinMain", "LaunchWindowsStartup", "main", "start", "BaseThreadInitThunk",
				"RtlUserThreadStart", "FRunnableThread", "FNamedTaskThread", "FTaskGraph", "UObject::", "UFunction::", "AActor::",
				"UActorComponent::", "UWorld::", "ULevel::", "UGameEngine::", "UEngine::", "FTickFunctionTask", "FActorTickFunction",
				"TGraphTask", "LowLevelTasks::", "FApp::", "UnknownFunction",
			};
			for (const char* P : EngineFns)
			{
				if (Text::StartsWith(F.Fn, P))
				{
					return true;
				}
			}
			return Text::StartsWith(F.Fn, "0x");
		}

		int TopIndex(const std::vector<FStackFrame>& Frames)
		{
			for (size_t I = 0; I < Frames.size(); I++)
			{
				if (!Frames[I].File.empty() && !IsEngine(Frames[I]))
				{
					return static_cast<int>(I);
				}
			}
			for (size_t I = 0; I < Frames.size(); I++)
			{
				if (!IsEngine(Frames[I]))
				{
					return static_cast<int>(I);
				}
			}
			for (size_t I = 0; I < Frames.size(); I++)
			{
				if (!Frames[I].File.empty())
				{
					return static_cast<int>(I);
				}
			}
			return Frames.empty() ? -1 : 0;
		}

		std::string BaseName(const std::string& Path)
		{
			const size_t I = Path.find_last_of("/\\");
			return I == std::string::npos ? Path : Path.substr(I + 1);
		}

		// "0x0000000104a3b2c0 Game!AMyActor::Tick() [...]" or "Game!AMyActor::Tick() [...]", not "Assertion failed: A != B".
		static bool LooksLikeFrame(const std::string& Line)
		{
			if (Text::StartsWith(Line, "0x") || Text::StartsWith(Line, "[Callstack]"))
			{
				return true;
			}
			const size_t Bang = Line.find('!');
			return Bang != std::string::npos && Bang > 0 && Line.find(' ') > Bang;
		}

		void DescribeCrash(const std::string& ErrorHist, const std::string& ExceptionDescription, std::string& OutMessage, std::string& OutStack)
		{
			const std::vector<std::string> Lines = Text::Lines(ErrorHist);
			size_t I = 0;
			while (I < Lines.size() && Text::Trim(Lines[I]).empty())
			{
				I++;
			}
			OutStack.clear();
			if (I >= Lines.size() || LooksLikeFrame(Text::Trim(Lines[I])))
			{
				const std::string Description = Text::Trim(ExceptionDescription);
				OutMessage = Description.empty() ? "Crash" : Description;
			}
			else
			{
				// The first line, and any that follow it before the blank line: "Fatal error: [File:..] [Line: 118]"
				// then the message itself.
				OutMessage = Text::Trim(Lines[I]);
				for (I++; I < Lines.size() && !Text::Trim(Lines[I]).empty() && !LooksLikeFrame(Text::Trim(Lines[I])); I++)
				{
					OutMessage += " " + Text::Trim(Lines[I]);
				}
			}
			for (; I < Lines.size(); I++)
			{
				OutStack += Lines[I];
				OutStack += '\n';
			}
		}

		std::string Format(const std::string& Kind, const std::string& Message, const std::vector<FStackFrame>& Frames)
		{
			std::string S = Kind + ": " + Message;
			int N = 0;
			for (const FStackFrame& F : Frames)
			{
				if (++N > 20)
				{
					break;
				}
				S += "\n    at " + F.Fn;
				if (!F.File.empty())
				{
					S += " (" + F.File + ":" + std::to_string(F.Line) + ")";
				}
			}
			return Text::Truncate(S, 4000);
		}
	}

	// ───────────────────────────── scrubbing ─────────────────────────────

	void FScrubber::AddPath(const std::string& Path, const std::string& Name)
	{
		std::string P = Path;
		while (!P.empty() && (P.back() == '/' || P.back() == '\\'))
		{
			P.pop_back();
		}
		if (P.size() > 1)
		{
			Paths.emplace_back(P, Name);
		}
	}

	std::string FScrubber::Scrub(const std::string& Input) const
	{
		std::string S = Input;
		for (const auto& Path : Paths)
		{
			Text::ReplaceAll(S, Path.first, Path.second);
		}

		// (/Users|/home)/[^/\s'"]+  ->  $1/~    a macOS or Linux user name
		{
			std::string Out;
			for (size_t I = 0; I < S.size();)
			{
				size_t Prefix = 0;
				if (S.compare(I, 7, "/Users/") == 0)
				{
					Prefix = 7;
				}
				else if (S.compare(I, 6, "/home/") == 0)
				{
					Prefix = 6;
				}
				size_t J = I + Prefix;
				while (Prefix && J < S.size() && ScrubbedNameChar(S[J]))
				{
					J++;
				}
				if (Prefix && J > I + Prefix)
				{
					Out.append(S, I, Prefix);
					Out += '~';
					I = J;
				}
				else
				{
					Out += S[I++];
				}
			}
			S = Out;
		}

		// ([A-Za-z]:[\\/]Users[\\/])[^\\/\s'"]+  ->  $1~    a Windows one
		{
			std::string Out;
			for (size_t I = 0; I < S.size();)
			{
				const bool Head = I + 9 < S.size() && ((S[I] >= 'A' && S[I] <= 'Z') || (S[I] >= 'a' && S[I] <= 'z')) && S[I + 1] == ':'
					&& (S[I + 2] == '\\' || S[I + 2] == '/') && S.compare(I + 3, 5, "Users") == 0 && (S[I + 8] == '\\' || S[I + 8] == '/');
				size_t J = I + 9;
				while (Head && J < S.size() && ScrubbedNameChar(S[J]))
				{
					J++;
				}
				if (Head && J > I + 9)
				{
					Out.append(S, I, 9);
					Out += '~';
					I = J;
				}
				else
				{
					Out += S[I++];
				}
			}
			S = Out;
		}

		// 8-4-4-4-12 hex  ->  <id>    iOS app container IDs
		{
			static const int Groups[] = {8, 4, 4, 4, 12};
			std::string Out;
			for (size_t I = 0; I < S.size();)
			{
				size_t J = I;
				bool Match = true;
				for (int G = 0; G < 5 && Match; G++)
				{
					for (int K = 0; K < Groups[G]; K++, J++)
					{
						if (J >= S.size() || !IsHex(S[J]))
						{
							Match = false;
							break;
						}
					}
					if (Match && G < 4)
					{
						if (J >= S.size() || S[J] != '-')
						{
							Match = false;
						}
						J++;
					}
				}
				if (Match)
				{
					Out += "<id>";
					I = J;
				}
				else
				{
					Out += S[I++];
				}
			}
			S = Out;
		}
		return S;
	}

	// ───────────────────────────── devices ─────────────────────────────

	namespace DeviceFacts
	{
		std::string DeviceTier(int Cores, double MemGb)
		{
			if (MemGb <= 0)
			{
				return "unknown";
			}
			if (MemGb < 3 || Cores <= 4)
			{
				return "low";
			}
			if (MemGb >= 6 && Cores >= 6)
			{
				return "high";
			}
			return "mid";
		}

		// "apple m3 max": a name, then digits, then (optionally) one of the words.
		static bool NameDigitsWord(const std::string& S, const char* Name, std::initializer_list<const char*> Words)
		{
			const std::string N(Name);
			for (size_t At = S.find(N); At != std::string::npos; At = S.find(N, At + 1))
			{
				size_t I = At + N.size();
				const size_t Digits = I;
				while (I < S.size() && IsDigit(S[I]))
				{
					I++;
				}
				if (I == Digits)
				{
					continue;
				}
				if (Words.size() == 0)
				{
					return true;
				}
				for (const char* W : Words)
				{
					if (S.compare(I, std::strlen(W), W) == 0)
					{
						return true;
					}
				}
			}
			return false;
		}

		static bool Has(const std::string& S, std::initializer_list<const char*> Parts)
		{
			for (const char* P : Parts)
			{
				if (S.find(P) != std::string::npos)
				{
					return true;
				}
			}
			return false;
		}

		std::string GpuTier(const std::string& AdapterName)
		{
			const std::string S = Text::Lower(AdapterName);
			if (Has(S, {"swiftshader", "llvmpipe", "software", "basic render"}))
			{
				return "software";
			}
			const size_t Gtx = S.find("geforce gtx 1");
			if (NameDigitsWord(S, "apple m", {" pro", " max", " ultra"}) || Has(S, {"rtx", "radeon rx", "radeon pro", "quadro", "arc a7"})
				|| (Gtx != std::string::npos && Gtx + 13 < S.size() && std::strchr("06789", S[Gtx + 13]) && S[Gtx + 13] != 0))
			{
				return "high";
			}
			if (Has(S, {"adreno", "mali", "powervr"}) || NameDigitsWord(S, "apple a", {}) || Text::EndsWith(S, "apple gpu"))
			{
				return "low";
			}
			const size_t Intel = S.find("intel");
			if (Intel != std::string::npos && (S.find("hd graphics", Intel) != std::string::npos || S.find("uhd graphics", Intel) != std::string::npos || Has(S, {"intel(r) hd", "intel(r) uhd"})))
			{
				return "low";
			}
			if (NameDigitsWord(S, "apple m", {}) || Has(S, {"apple gpu", "iris", "arc", "radeon", "geforce", "nvidia"}))
			{
				return "mid";
			}
			return "unknown";
		}

		static std::string OsReleaseId(const std::string& OsRelease)
		{
			for (const std::string& Line : Text::Lines(OsRelease))
			{
				if (Text::StartsWith(Line, "ID="))
				{
					std::string Id = Text::Trim(Line.substr(3));
					if (Id.size() >= 2 && (Id[0] == '"' || Id[0] == '\''))
					{
						Id = Id.substr(1, Id.size() - 2);
					}
					return Text::Lower(Id);
				}
			}
			return "";
		}

		bool IsSteamOS(const FSteamDeckFacts& Facts)
		{
			return OsReleaseId(Facts.OsRelease) == "steamos";
		}

		bool IsSteamDeck(const FSteamDeckFacts& Facts)
		{
			const std::string Name = Text::Lower(Text::Trim(Facts.BoardName));
			return Text::Trim(Facts.Env) == "1" || (Text::Lower(Text::Trim(Facts.BoardVendor)) == "valve" && (Name == "jupiter" || Name == "galileo")) || IsSteamOS(Facts);
		}

		std::string SteamDeckModel(const FSteamDeckFacts& Facts)
		{
			const std::string Name = Text::Lower(Text::Trim(Facts.BoardName));
			return Name == "galileo" ? "Steam Deck OLED" : Name == "jupiter" ? "Steam Deck LCD" : "Steam Deck";
		}

		std::string IosDistribution(const FIosInstallFacts& Facts)
		{
			if (Facts.Receipt)
			{
				return "app_store";
			}
			if (Facts.Provisioned || Facts.Home.find("/CoreSimulator/") != std::string::npos)
			{
				return "development";
			}
			if (Facts.SandboxReceipt || Text::StartsWith(Facts.Home, "/var/mobile/Containers/Data/Application/") || Text::StartsWith(Facts.Home, "/private/var/mobile/Containers/Data/Application/"))
			{
				return "testflight";
			}
			return "";
		}

		bool IsSandbox(const std::string& Distribution)
		{
			return Distribution == "testflight" || Distribution == "development";
		}
	}

	// ───────────────────────────── maps as levels ─────────────────────────────

	namespace Levels
	{
		std::string LevelForMap(const std::string& MapName)
		{
			if (MapName.empty())
			{
				return "";
			}
			// The same words as Unity's scene check: "MainMenu" and "L_Main_Menu" read as "main menu".
			// Regex.Replace(name, "([a-z0-9])([A-Z])", "$1 $2")
			std::string A;
			for (size_t I = 0; I < MapName.size();)
			{
				if (I + 1 < MapName.size() && IsLowerOrDigit(MapName[I]) && IsUpper(MapName[I + 1]))
				{
					A += MapName[I];
					A += ' ';
					A += MapName[I + 1];
					I += 2;
				}
				else
				{
					A += MapName[I++];
				}
			}
			// Regex.Replace(.., "([A-Z])([A-Z][a-z])", "$1 $2")
			std::string B;
			for (size_t I = 0; I < A.size();)
			{
				if (I + 2 < A.size() && IsUpper(A[I]) && IsUpper(A[I + 1]) && A[I + 2] >= 'a' && A[I + 2] <= 'z')
				{
					B += A[I];
					B += ' ';
					B += A[I + 1];
					B += A[I + 2];
					I += 3;
				}
				else
				{
					B += A[I++];
				}
			}
			// Words: runs of letters and digits (underscores, dashes and dots split them).
			std::vector<std::string> Words;
			std::string Word;
			for (size_t I = 0; I <= B.size(); I++)
			{
				const char C = I < B.size() ? B[I] : ' ';
				if (IsWord(C) && C != '_')
				{
					Word += C;
				}
				else if (!Word.empty())
				{
					Words.push_back(Text::Lower(Word));
					Word.clear();
				}
			}
			static const char* const NotALevel[] = {
				"boot", "bootstrap", "init", "startup", "preload", "preloader", "load", "loader", "loading", "splash", "intro", "title",
				"menu", "mainmenu", "ui", "hud", "overlay", "pause", "paused", "gameover", "settings", "options", "credits", "leaderboard",
				"shop", "empty",
				// Unreal's own: Lyra's front end, lobbies, seamless travel's transition map
				"entry", "frontend", "lobby", "transition",
			};
			for (size_t I = 0; I < Words.size(); I++)
			{
				for (const char* W : NotALevel)
				{
					if (Words[I] == W)
					{
						return "";
					}
				}
				if (I + 1 < Words.size() && ((Words[I] == "game" && Words[I + 1] == "over") || (Words[I] == "front" && Words[I + 1] == "end")))
				{
					return "";
				}
			}
			return MapName;
		}
	}
}
