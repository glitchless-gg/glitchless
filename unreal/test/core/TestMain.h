#pragma once

// A very small test runner for the plugin's engine-independent core, so it can be tested with any
// C++17 compiler and no engine. unreal/test/core.mjs builds and runs it.

#include "GlitchlessJson.h"

#include <cmath>
#include <cstdio>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

namespace GlitchlessTest
{
	struct FCase
	{
		const char* Name;
		void (*Fn)();
	};

	std::vector<FCase>& Cases();
	extern int Failures;
	extern std::string FixturePath;

	struct FRegister
	{
		FRegister(const char* Name, void (*Fn)()) { Cases().push_back({Name, Fn}); }
	};

	inline std::string Show(const std::string& S) { return "\"" + S + "\""; }
	inline std::string Show(const char* S) { return Show(std::string(S ? S : "")); }
	inline std::string Show(const Glitchless::FValue& V) { return V.Serialize(); }
	inline std::string Show(bool B) { return B ? "true" : "false"; }
	template <typename T>
	std::string Show(const T& V)
	{
		std::ostringstream S;
		S.precision(17);
		S << V;
		return S.str();
	}

	void Fail(const std::string& What, const char* File, int Line);

	template <typename A, typename B>
	void ExpectEq(const A& Actual, const B& Expected, const char* Text, const char* File, int Line)
	{
		if (!(Actual == Expected))
		{
			Fail(std::string(Text) + "\n      got      " + Show(Actual) + "\n      expected " + Show(Expected), File, Line);
		}
	}
}

#define GL_CAT2(A, B) A##B
#define GL_CAT(A, B) GL_CAT2(A, B)
#define TEST(Name) \
	static void Name(); \
	static GlitchlessTest::FRegister GL_CAT(Register_, Name)(#Name, Name); \
	static void Name()
#define EXPECT(Cond) \
	do { if (!(Cond)) GlitchlessTest::Fail("EXPECT(" #Cond ")", __FILE__, __LINE__); } while (0)
#define EXPECT_EQ(Actual, Expected) GlitchlessTest::ExpectEq((Actual), (Expected), "EXPECT_EQ(" #Actual ", " #Expected ")", __FILE__, __LINE__)
#define EXPECT_NEAR(Actual, Expected, Tolerance) \
	do { if (!(std::fabs((Actual) - (Expected)) <= (Tolerance))) GlitchlessTest::Fail("EXPECT_NEAR(" #Actual ", " #Expected "): " + GlitchlessTest::Show(Actual) + " vs " + GlitchlessTest::Show(Expected), __FILE__, __LINE__); } while (0)
