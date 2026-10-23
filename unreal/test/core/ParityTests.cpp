// The C++ sketch, number writing and fingerprints must agree with the JavaScript SDK bit for bit: the
// server merges sketches from every SDK and groups errors by fingerprint. fixtures/js-fixture.json is
// written by unreal/test/make-fixtures.mjs from packages/sdk/src.

#include "GlitchlessSketch.h"
#include "GlitchlessText.h"
#include "TestMain.h"

#include <cstdint>
#include <cstring>

using namespace Glitchless;

namespace
{
	const FValue& Fixture()
	{
		static FValue Data;
		static bool Loaded = false;
		if (!Loaded)
		{
			Loaded = true;
			std::FILE* F = std::fopen(GlitchlessTest::FixturePath.c_str(), "rb");
			if (!F)
			{
				std::printf("    cannot open the fixture %s\n", GlitchlessTest::FixturePath.c_str());
				return Data;
			}
			std::string Text;
			char Buf[65536];
			size_t N;
			while ((N = std::fread(Buf, 1, sizeof(Buf), F)) > 0)
			{
				Text.append(Buf, N);
			}
			std::fclose(F);
			if (!FValue::Parse(Text, Data))
			{
				std::printf("    the fixture is not JSON\n");
			}
		}
		return Data;
	}

	double FromHex(const std::string& Hex)
	{
		uint64_t U = 0;
		for (const char C : Hex)
		{
			U = (U << 4) | static_cast<uint64_t>(C <= '9' ? C - '0' : C - 'a' + 10);
		}
		double D;
		std::memcpy(&D, &U, sizeof(D));
		return D;
	}

	std::string ToHex(double D)
	{
		uint64_t U;
		std::memcpy(&U, &D, sizeof(U));
		char Buf[17];
		std::snprintf(Buf, sizeof(Buf), "%016llx", static_cast<unsigned long long>(U));
		return Buf;
	}

	FSketch SketchOf(const FValue& Values)
	{
		FSketch S;
		for (const FValue& V : Values.GetItems())
		{
			S.Add(V.AsNumber());
		}
		return S;
	}
}

TEST(FixtureIsThere)
{
	EXPECT(Fixture().IsObject());
	EXPECT(Fixture().Find("sketches") != nullptr);
}

TEST(LogIsV8sBitForBit)
{
	const FValue* Logs = Fixture().Find("logs");
	EXPECT(Logs && Logs->Size() > 7000);
	if (!Logs)
	{
		return;
	}
	int Wrong = 0;
	for (const FValue& Pair : Logs->GetItems())
	{
		const double X = FromHex(Pair[0].AsString());
		const std::string Got = ToHex(FSketch::Log(X));
		if (Got != Pair[1].AsString() && ++Wrong <= 5)
		{
			EXPECT_EQ(Got, Pair[1].AsString());
		}
	}
	EXPECT_EQ(Wrong, 0);
}

TEST(SketchPutsEveryValueInTheJavaScriptBucket)
{
	FSketch S;
	for (const FValue& Pair : Fixture().Find("indexes")->GetItems())
	{
		EXPECT_EQ(S.Index(Pair[0].AsNumber()), static_cast<int>(Pair[1].AsInt()));
	}
}

TEST(SketchSendsWhatTheJavaScriptSketchSendsByteForByte)
{
	const FValue& Sketches = *Fixture().Find("sketches");
	EXPECT_EQ(Sketches.Size(), static_cast<size_t>(5));
	for (size_t I = 0; I < Sketches.Size(); I++)
	{
		const FValue& Set = Sketches.ValueAt(I);
		const FSketch S = SketchOf(*Set.Find("values"));
		const std::string Json = S.ToJson().Serialize();
		if (Json != Set.Find("json")->AsString())
		{
			GlitchlessTest::Fail("sketch " + Sketches.GetKeys()[I] + "\n      got      " + Json.substr(0, 300) + "\n      expected " + Set.Find("json")->AsString().substr(0, 300), __FILE__, __LINE__);
		}
	}
}

TEST(QuantilesAndFractionsMatch)
{
	const FValue& Sketches = *Fixture().Find("sketches");
	for (size_t I = 0; I < Sketches.Size(); I++)
	{
		const FValue& Set = Sketches.ValueAt(I);
		const FSketch S = SketchOf(*Set.Find("values"));
		const FValue& Q = *Set.Find("quantiles");
		for (size_t K = 0; K < Q.Size(); K++)
		{
			const double At = std::strtod(Q.GetKeys()[K].c_str(), nullptr);
			const double Expected = Q.ValueAt(K).AsNumber();
			EXPECT_NEAR(S.Quantile(At).value_or(-1), Expected, std::fabs(Expected) * 1e-12);
		}
		for (const FValue& Pair : Set.Find("fraction_above")->GetItems())
		{
			EXPECT_EQ(S.FractionAbove(Pair[0].AsNumber()), Pair[1].AsNumber());
		}
	}
}

TEST(NumbersAreWrittenTheWayJsonStringifyWritesThem)
{
	for (const FValue& Pair : Fixture().Find("numbers")->GetItems())
	{
		std::string Out;
		Json::WriteNumber(Out, FromHex(Pair[0].AsString()));
		EXPECT_EQ(Out, Pair[1].AsString());
	}
}

TEST(RoundingIsMathRounds)
{
	for (const FValue& Row : Fixture().Find("rounds")->GetItems())
	{
		const double V = FromHex(Row[0].AsString());
		const int Digits = static_cast<int>(Row[1].AsInt());
		EXPECT_EQ(ToHex(FSketch::Round(V, Digits)), Row[2].AsString());
	}
}

TEST(FingerprintsMatch)
{
	for (const FValue& F : Fixture().Find("fingerprints")->GetItems())
	{
		const std::string& Message = F.Find("message")->AsString();
		EXPECT_EQ(Fingerprint::NormalizeMessage(Message), F.Find("normalized")->AsString());
		EXPECT_EQ(Fingerprint::Of(F.Find("kind")->AsString(), Message, F.Find("fn")->AsString()), F.Find("fingerprint")->AsString());
	}
}

TEST(JsonWritesAndReadsBack)
{
	FValue V = FValue::Object();
	V.Set("s", "quote \" backslash \\ newline \n tab \t control \x01 \xC3\xA9moji \xF0\x9F\x90\xB6");
	V.Set("n", 16.78);
	V.Set("i", 42);
	V.Set("l", static_cast<int64_t>(1761000000000LL));
	V.Set("nan", std::nan(""));
	V.Set("b", true);
	V.Set("null", FValue());
	V.Set("list", FValue::List({1, "two", FValue::List({3, 4})}));
	V.Set("raw", FValue::Raw("{\"x\":1}"));
	const std::string Text = V.Serialize();
	EXPECT(Text.find("\"n\":16.78") != std::string::npos);
	EXPECT(Text.find("\"l\":1761000000000") != std::string::npos);
	EXPECT(Text.find("\"nan\":null") != std::string::npos);
	EXPECT(Text.find("\\u0001") != std::string::npos);
	FValue Back;
	EXPECT(FValue::Parse(Text, Back));
	EXPECT_EQ(Back.Find("s")->AsString(), V.Find("s")->AsString());
	EXPECT_EQ(Back.Find("n")->AsNumber(), 16.78);
	EXPECT_EQ(Back.Find("l")->AsInt(), static_cast<int64_t>(1761000000000LL));
	EXPECT(Back.Find("nan")->IsNull());
	EXPECT_EQ(Back.Find("raw")->Find("x")->AsNumber(), 1.0);
	EXPECT_EQ(Back.Serialize(), Text); // numbers read back keep their text
	FValue Bad;
	EXPECT(!FValue::Parse("{\"a\":", Bad));
	EXPECT(!FValue::Parse("[1,2", Bad));
	EXPECT(!FValue::Parse("{\"a\":1} x", Bad));
	FValue Escaped;
	EXPECT(FValue::Parse("\"\\ud83d\\udc36 \\u00e9\"", Escaped));
	EXPECT_EQ(Escaped.AsString(), std::string("\xF0\x9F\x90\xB6 \xC3\xA9"));
}
