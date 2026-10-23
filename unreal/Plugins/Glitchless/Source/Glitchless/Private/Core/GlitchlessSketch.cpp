// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#include "GlitchlessSketch.h"

#include "fdlibm_log.h"

#include <algorithm>
#include <cmath>
#include <string>

// Bucket numbers have to come out the same on every compiler: no fused multiply-adds, no dividing
// by a reciprocal, no reassociating. Unreal builds MSVC with /fp:fast, and clang contracts a * b + c on
// ARM unless told not to (the functions below say so).
#if defined(_MSC_VER) || defined(__clang__)
#pragma float_control(precise, on, push)
#endif
#if defined(_MSC_VER) && !defined(__clang__)
#pragma fp_contract(off)
#endif

namespace Glitchless
{
	// fdlibm's log (Source/ThirdParty/fdlibm), which is V8's Math.log: the buckets match JavaScript's.
	double FSketch::Log(double X)
	{
		return GlitchlessFdlibm::Log(X);
	}

	double FSketch::Round(double V, int Digits)
	{
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
		static const double Scale[] = {1, 10, 100, 1000, 10000, 100000, 1000000};
		const double M = Scale[std::clamp(Digits, 0, 6)];
		const double X = V * M;
		if (!Json::IsFinite(X))
		{
			return V;
		}
		// Math.round: the nearest integer, halves toward +infinity.
		double R = std::floor(X);
		if (X - R >= 0.5)
		{
			R += 1;
		}
		if (R == 0)
		{
			R = std::copysign(0.0, X); // Math.round(-0.4) is -0
		}
		return R / M;
	}

	FSketch::FSketch(double InAlpha)
		: Alpha(InAlpha)
		, Gamma((1 + InAlpha) / (1 - InAlpha))
		, LnGamma(Log((1 + InAlpha) / (1 - InAlpha)))
	{
	}

	int FSketch::Index(double V) const
	{
		return static_cast<int>(std::ceil(Log(V) / LnGamma));
	}

	double FSketch::Value(int I) const
	{
		return 2 * std::pow(Gamma, I) / (Gamma + 1);
	}

	void FSketch::Add(double V, int64_t Count)
	{
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
		if (!(V >= 0))
		{
			return;
		}
		if (V < 1e-3)
		{
			Zeros += Count;
		}
		else
		{
			const int I = Index(V);
			auto Found = BinAt.find(I);
			if (Found == BinAt.end())
			{
				BinAt.emplace(I, Bins.size());
				Bins.emplace_back(I, Count);
			}
			else
			{
				Bins[Found->second].second += Count;
			}
		}
		if (N == 0 || V < Min)
		{
			Min = V;
		}
		if (N == 0 || V > Max)
		{
			Max = V;
		}
		N += Count;
		Sum += V * static_cast<double>(Count);
	}

	std::optional<double> FSketch::Quantile(double Q) const
	{
		if (N == 0)
		{
			return std::nullopt;
		}
		const double Rank = Q * static_cast<double>(N - 1);
		double Acc = static_cast<double>(Zeros);
		if (Acc > Rank)
		{
			return 0.0;
		}
		std::vector<std::pair<int, int64_t>> Sorted(Bins);
		std::sort(Sorted.begin(), Sorted.end());
		for (const auto& Bin : Sorted)
		{
			Acc += static_cast<double>(Bin.second);
			if (Acc > Rank)
			{
				return std::min(std::max(Value(Bin.first), Min), Max);
			}
		}
		return Max;
	}

	double FSketch::FractionAbove(double Threshold) const
	{
		if (N == 0)
		{
			return 0;
		}
		const int Cut = Index(Threshold);
		int64_t Above = 0;
		for (const auto& Bin : Bins)
		{
			if (Bin.first > Cut)
			{
				Above += Bin.second;
			}
		}
		return static_cast<double>(Above) / static_cast<double>(N);
	}

	FValue FSketch::ToJson() const
	{
		// JavaScript writes an object's integer keys first, in ascending order, then the rest (the
		// negative buckets of sub-millisecond frames) in the order they were added.
		std::vector<std::pair<int, int64_t>> Positive;
		for (const auto& Bin : Bins)
		{
			if (Bin.first >= 0)
			{
				Positive.push_back(Bin);
			}
		}
		std::sort(Positive.begin(), Positive.end());
		FValue B = FValue::Object();
		for (const auto& Bin : Positive)
		{
			B.Set(std::to_string(Bin.first), FValue(Bin.second));
		}
		for (const auto& Bin : Bins)
		{
			if (Bin.first < 0)
			{
				B.Set(std::to_string(Bin.first), FValue(Bin.second));
			}
		}
		FValue J = FValue::Object();
		J.Set("a", Alpha);
		J.Set("b", std::move(B));
		J.Set("n", N);
		J.Set("z", Zeros);
		J.Set("s", Round(Sum, 1));
		J.Set("mn", N > 0 ? FValue(Round(Min, 2)) : FValue());
		J.Set("mx", N > 0 ? FValue(Round(Max, 2)) : FValue());
		return J;
	}
}

#if defined(_MSC_VER) || defined(__clang__)
#pragma float_control(pop)
#endif
