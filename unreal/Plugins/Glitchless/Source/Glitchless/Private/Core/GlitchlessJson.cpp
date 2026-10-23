// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessJson.h"

#include <clocale>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace Glitchless
{
	FValue FValue::List(std::initializer_list<FValue> Values)
	{
		FValue V = Array();
		V.Items.assign(Values.begin(), Values.end());
		return V;
	}

	FValue FValue::Strings(const std::vector<std::string>& Values)
	{
		FValue V = Array();
		for (const std::string& S : Values)
		{
			V.Items.emplace_back(S);
		}
		return V;
	}

	double FValue::AsNumber(double Fallback) const
	{
		if (Type == EType::Int)
		{
			return static_cast<double>(IntValue);
		}
		return Type == EType::Double ? DoubleValue : Fallback;
	}

	int64_t FValue::AsInt(int64_t Fallback) const
	{
		if (Type == EType::Int)
		{
			return IntValue;
		}
		return Type == EType::Double && Json::IsFinite(DoubleValue) ? static_cast<int64_t>(DoubleValue) : Fallback;
	}

	void FValue::Push(FValue V)
	{
		if (Type == EType::Null)
		{
			Type = EType::Array;
		}
		Items.push_back(std::move(V));
	}

	const FValue* FValue::Find(const std::string& Key) const
	{
		if (Type != EType::Object)
		{
			return nullptr;
		}
		for (size_t I = 0; I < Keys.size(); I++)
		{
			if (Keys[I] == Key)
			{
				return &Items[I];
			}
		}
		return nullptr;
	}

	FValue* FValue::Find(const std::string& Key)
	{
		return const_cast<FValue*>(static_cast<const FValue*>(this)->Find(Key));
	}

	FValue& FValue::Set(const std::string& Key, FValue V)
	{
		if (Type == EType::Null)
		{
			Type = EType::Object;
		}
		if (FValue* Existing = Find(Key))
		{
			*Existing = std::move(V);
			return *Existing;
		}
		Keys.push_back(Key);
		Items.push_back(std::move(V));
		return Items.back();
	}

	bool FValue::operator==(const FValue& Other) const
	{
		if (IsNumber() && Other.IsNumber())
		{
			return AsNumber() == Other.AsNumber();
		}
		if (Type != Other.Type)
		{
			return false;
		}
		switch (Type)
		{
		case EType::Null: return true;
		case EType::Bool: return BoolValue == Other.BoolValue;
		case EType::String:
		case EType::Raw: return Text == Other.Text;
		case EType::Array: return Items == Other.Items;
		case EType::Object:
			if (Keys.size() != Other.Keys.size())
			{
				return false;
			}
			for (size_t I = 0; I < Keys.size(); I++)
			{
				const FValue* B = Other.Find(Keys[I]);
				if (!B || !(Items[I] == *B))
				{
					return false;
				}
			}
			return true;
		default: return false;
		}
	}

	std::string FValue::Serialize() const
	{
		std::string Out;
		Out.reserve(256);
		Write(Out);
		return Out;
	}

	void FValue::Write(std::string& Out) const
	{
		switch (Type)
		{
		case EType::Null: Out += "null"; return;
		case EType::Bool: Out += BoolValue ? "true" : "false"; return;
		case EType::Int: Out += std::to_string(IntValue); return;
		case EType::Double:
			if (!Text.empty())
			{
				Out += Text; // read from JSON: written back the way it came
			}
			else
			{
				Json::WriteNumber(Out, DoubleValue);
			}
			return;
		case EType::String: Json::WriteString(Out, Text); return;
		case EType::Raw: Out += Text; return;
		case EType::Array:
			Out += '[';
			for (size_t I = 0; I < Items.size(); I++)
			{
				if (I > 0)
				{
					Out += ',';
				}
				Items[I].Write(Out);
			}
			Out += ']';
			return;
		case EType::Object:
			Out += '{';
			for (size_t I = 0; I < Keys.size(); I++)
			{
				if (I > 0)
				{
					Out += ',';
				}
				Json::WriteString(Out, Keys[I]);
				Out += ':';
				Items[I].Write(Out);
			}
			Out += '}';
			return;
		}
	}

	namespace Json
	{
		bool IsFinite(double D)
		{
			uint64_t Bits;
			std::memcpy(&Bits, &D, sizeof(Bits));
			return ((Bits >> 52) & 0x7ff) != 0x7ff;
		}

		// printf writes the C locale's decimal point, which a game may have set to a comma.
		static void FixDecimalPoint(char* S)
		{
			for (; *S; S++)
			{
				const char C = *S;
				if (!(C >= '0' && C <= '9') && C != '-' && C != '+' && C != 'e')
				{
					*S = '.';
				}
			}
		}

		void WriteNumber(std::string& Out, double D)
		{
			if (!Json::IsFinite(D))
			{
				Out += "null";
				return;
			}
			if (D == 0)
			{
				Out += '0'; // JavaScript writes -0 as 0 too
				return;
			}
			// The fewest significant digits that read back as the same double, as JavaScript picks.
			char Buf[40];
			for (int Precision = 1; Precision <= 17; Precision++)
			{
				std::snprintf(Buf, sizeof(Buf), "%.*e", Precision - 1, D);
				FixDecimalPoint(Buf);
				if (ReadNumber(Buf, std::strlen(Buf)) == D)
				{
					break;
				}
			}
			// Buf is [-]d[.ddd]e[+-]xx: take the digits and the exponent, then lay them out the way
			// Number.prototype.toString does.
			std::string Digits;
			bool Negative = false;
			int Exponent = 0;
			const char* P = Buf;
			if (*P == '-')
			{
				Negative = true;
				P++;
			}
			for (; *P && *P != 'e'; P++)
			{
				if (*P >= '0' && *P <= '9')
				{
					Digits += *P;
				}
			}
			if (*P == 'e')
			{
				Exponent = std::atoi(P + 1);
			}
			while (Digits.size() > 1 && Digits.back() == '0')
			{
				Digits.pop_back();
			}
			const int K = static_cast<int>(Digits.size());
			const int N = Exponent + 1; // where the decimal point goes
			if (Negative)
			{
				Out += '-';
			}
			if (K <= N && N <= 21)
			{
				Out += Digits;
				Out.append(N - K, '0');
			}
			else if (0 < N && N <= 21)
			{
				Out.append(Digits, 0, N);
				Out += '.';
				Out.append(Digits, N, std::string::npos);
			}
			else if (-6 < N && N <= 0)
			{
				Out += "0.";
				Out.append(-N, '0');
				Out += Digits;
			}
			else
			{
				Out += Digits[0];
				if (K > 1)
				{
					Out += '.';
					Out.append(Digits, 1, std::string::npos);
				}
				Out += 'e';
				Out += N - 1 >= 0 ? '+' : '-';
				Out += std::to_string(N - 1 >= 0 ? N - 1 : 1 - N);
			}
		}

		void WriteString(std::string& Out, const std::string& S)
		{
			static const char Hex[] = "0123456789abcdef";
			Out += '"';
			for (const char Ch : S)
			{
				const unsigned char C = static_cast<unsigned char>(Ch);
				switch (C)
				{
				case '"': Out += "\\\""; break;
				case '\\': Out += "\\\\"; break;
				case '\n': Out += "\\n"; break;
				case '\r': Out += "\\r"; break;
				case '\t': Out += "\\t"; break;
				case '\b': Out += "\\b"; break;
				case '\f': Out += "\\f"; break;
				default:
					if (C < 0x20)
					{
						Out += "\\u00";
						Out += Hex[C >> 4];
						Out += Hex[C & 15];
					}
					else
					{
						Out += Ch; // UTF-8 goes as it is, as JSON.stringify leaves it
					}
				}
			}
			Out += '"';
		}

		double ReadNumber(const char* Begin, size_t Length)
		{
			char Buf[64];
			if (Length == 0 || Length >= sizeof(Buf))
			{
				return Length == 0 ? 0 : std::strtod(std::string(Begin, Length).c_str(), nullptr);
			}
			std::memcpy(Buf, Begin, Length);
			Buf[Length] = 0;
			const lconv* Locale = std::localeconv();
			const char Point = Locale && Locale->decimal_point && Locale->decimal_point[0] ? Locale->decimal_point[0] : '.';
			if (Point != '.')
			{
				for (size_t I = 0; I < Length; I++)
				{
					if (Buf[I] == '.')
					{
						Buf[I] = Point;
					}
				}
			}
			return std::strtod(Buf, nullptr);
		}
	}

	class FJsonParser
	{
	public:
		explicit FJsonParser(const std::string& InText) : S(InText) {}

		bool Document(FValue& Out)
		{
			if (!Value(Out, 0))
			{
				return false;
			}
			SkipSpace();
			return I == S.size();
		}

	private:
		const std::string& S;
		size_t I = 0;

		void SkipSpace()
		{
			while (I < S.size() && (S[I] == ' ' || S[I] == '\t' || S[I] == '\n' || S[I] == '\r'))
			{
				I++;
			}
		}

		bool Value(FValue& Out, int Depth)
		{
			if (Depth > 64)
			{
				return false;
			}
			SkipSpace();
			if (I >= S.size())
			{
				return false;
			}
			const char C = S[I];
			if (C == '{')
			{
				return ObjectValue(Out, Depth);
			}
			if (C == '[')
			{
				return ArrayValue(Out, Depth);
			}
			if (C == '"')
			{
				std::string Str;
				if (!StringValue(Str))
				{
					return false;
				}
				Out = FValue(std::move(Str));
				return true;
			}
			if (Word("true"))
			{
				Out = FValue(true);
				return true;
			}
			if (Word("false"))
			{
				Out = FValue(false);
				return true;
			}
			if (Word("null"))
			{
				Out = FValue();
				return true;
			}
			return NumberValue(Out);
		}

		bool Word(const char* W)
		{
			const size_t N = std::strlen(W);
			if (S.compare(I, N, W) != 0)
			{
				return false;
			}
			I += N;
			return true;
		}

		bool ObjectValue(FValue& Out, int Depth)
		{
			FValue O = FValue::Object();
			I++;
			SkipSpace();
			if (I < S.size() && S[I] == '}')
			{
				I++;
				Out = std::move(O);
				return true;
			}
			while (true)
			{
				SkipSpace();
				std::string Key;
				if (!StringValue(Key))
				{
					return false;
				}
				SkipSpace();
				if (!Expect(':'))
				{
					return false;
				}
				FValue V;
				if (!Value(V, Depth + 1))
				{
					return false;
				}
				O.Set(Key, std::move(V));
				SkipSpace();
				if (I < S.size() && S[I] == ',')
				{
					I++;
					continue;
				}
				if (!Expect('}'))
				{
					return false;
				}
				Out = std::move(O);
				return true;
			}
		}

		bool ArrayValue(FValue& Out, int Depth)
		{
			FValue A = FValue::Array();
			I++;
			SkipSpace();
			if (I < S.size() && S[I] == ']')
			{
				I++;
				Out = std::move(A);
				return true;
			}
			while (true)
			{
				FValue V;
				if (!Value(V, Depth + 1))
				{
					return false;
				}
				A.Push(std::move(V));
				SkipSpace();
				if (I < S.size() && S[I] == ',')
				{
					I++;
					continue;
				}
				if (!Expect(']'))
				{
					return false;
				}
				Out = std::move(A);
				return true;
			}
		}

		static void AppendUtf8(std::string& Out, uint32_t Cp)
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

		bool Hex4(uint32_t& Out)
		{
			if (I + 4 > S.size())
			{
				return false;
			}
			Out = 0;
			for (int K = 0; K < 4; K++)
			{
				const char C = S[I++];
				Out <<= 4;
				if (C >= '0' && C <= '9') Out |= C - '0';
				else if (C >= 'a' && C <= 'f') Out |= C - 'a' + 10;
				else if (C >= 'A' && C <= 'F') Out |= C - 'A' + 10;
				else return false;
			}
			return true;
		}

		bool StringValue(std::string& Out)
		{
			if (!Expect('"'))
			{
				return false;
			}
			while (true)
			{
				if (I >= S.size())
				{
					return false;
				}
				const char C = S[I++];
				if (C == '"')
				{
					return true;
				}
				if (C != '\\')
				{
					Out += C;
					continue;
				}
				if (I >= S.size())
				{
					return false;
				}
				const char E = S[I++];
				switch (E)
				{
				case '"': Out += '"'; break;
				case '\\': Out += '\\'; break;
				case '/': Out += '/'; break;
				case 'b': Out += '\b'; break;
				case 'f': Out += '\f'; break;
				case 'n': Out += '\n'; break;
				case 'r': Out += '\r'; break;
				case 't': Out += '\t'; break;
				case 'u':
				{
					uint32_t Cp;
					if (!Hex4(Cp))
					{
						return false;
					}
					if (Cp >= 0xD800 && Cp < 0xDC00 && I + 6 <= S.size() && S[I] == '\\' && S[I + 1] == 'u')
					{
						const size_t Save = I;
						I += 2;
						uint32_t Lo;
						if (Hex4(Lo) && Lo >= 0xDC00 && Lo < 0xE000)
						{
							Cp = 0x10000 + ((Cp - 0xD800) << 10) + (Lo - 0xDC00);
						}
						else
						{
							I = Save;
						}
					}
					AppendUtf8(Out, Cp);
					break;
				}
				default: return false;
				}
			}
		}

		bool NumberValue(FValue& Out)
		{
			const size_t Start = I;
			bool Fraction = false;
			while (I < S.size() && std::strchr("+-0123456789.eE", S[I]) && S[I] != 0)
			{
				Fraction |= S[I] == '.' || S[I] == 'e' || S[I] == 'E';
				I++;
			}
			if (I == Start)
			{
				return false;
			}
			const std::string Lexeme = S.substr(Start, I - Start);
			const double D = Json::ReadNumber(Lexeme.data(), Lexeme.size());
			if (!Fraction && Lexeme.size() < 16)
			{
				Out = FValue(static_cast<int64_t>(D));
				return true;
			}
			Out = FValue(D);
			Out.Text = Lexeme;
			return true;
		}

		bool Expect(char C)
		{
			if (I >= S.size() || S[I] != C)
			{
				return false;
			}
			I++;
			return true;
		}
	};

	bool FValue::Parse(const std::string& Json, FValue& Out)
	{
		FJsonParser Parser(Json);
		FValue V;
		if (!Parser.Document(V))
		{
			return false;
		}
		Out = std::move(V);
		return true;
	}
}
