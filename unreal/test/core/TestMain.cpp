#include "TestMain.h"

#include <cstring>

namespace GlitchlessTest
{
	std::vector<FCase>& Cases()
	{
		static std::vector<FCase> All;
		return All;
	}

	int Failures = 0;
	std::string FixturePath;
	static int CaseFailures = 0;

	void Fail(const std::string& What, const char* File, int Line)
	{
		Failures++;
		CaseFailures++;
		const char* Base = std::strrchr(File, '/');
		std::printf("    %s:%d: %s\n", Base ? Base + 1 : File, Line, What.c_str());
	}
}

int main(int Argc, char** Argv)
{
	using namespace GlitchlessTest;
	const char* Only = nullptr;
	for (int I = 1; I < Argc; I++)
	{
		if (std::strncmp(Argv[I], "--fixture=", 10) == 0)
		{
			FixturePath = Argv[I] + 10;
		}
		else
		{
			Only = Argv[I];
		}
	}
	int Passed = 0;
	int Ran = 0;
	for (const FCase& C : Cases())
	{
		if (Only && !std::strstr(C.Name, Only))
		{
			continue;
		}
		Ran++;
		CaseFailures = 0;
		C.Fn();
		std::printf("%s %s\n", CaseFailures == 0 ? "ok  " : "FAIL", C.Name);
		if (CaseFailures == 0)
		{
			Passed++;
		}
	}
	std::printf("\n%d/%d passed\n", Passed, Ran);
	return Passed == Ran && Ran > 0 ? 0 : 1;
}
