// Copyright (c) 2026 The Glitchless authors. MIT License: see LICENSE.
#pragma once

#include "GlitchlessJson.h"

#include <cstdint>
#include <optional>
#include <unordered_map>
#include <utility>
#include <vector>

namespace Glitchless
{
	/**
	 * A small DDSketch-style quantile sketch, a port of packages/sdk/src/sketch.js.
	 *
	 * Frame times have long tails, so an average of each session's p95 means nothing. Each frame
	 * window sends this log-bucketed histogram instead; the Glitchless server merges them and reads
	 * percentiles to within 2% of the true value. The bucket numbers must match the JavaScript sketch
	 * exactly, or the server would merge buckets that mean different things, so the logarithm is
	 * fdlibm's, the one V8 uses, rather than whatever this platform's C library has. unreal/test
	 * checks it against fixtures the JavaScript sketch wrote.
	 */
	class FSketch
	{
	public:
		static constexpr double DefaultAlpha = 0.02;

		explicit FSketch(double InAlpha = DefaultAlpha);

		int Index(double V) const;
		double Value(int I) const;
		void Add(double V, int64_t Count = 1);
		/** The value at quantile Q (0.5 is the median); nothing with no samples. */
		std::optional<double> Quantile(double Q) const;
		/** The share of samples above a threshold, such as frames over budget. */
		double FractionAbove(double Threshold) const;
		/** What goes on the wire as frame_window.ft, keys in the order JSON.stringify writes them. */
		FValue ToJson() const;

		int64_t N = 0;
		int64_t Zeros = 0;
		double Sum = 0;
		double Min = 0;
		double Max = 0;

		/** Rounds the way JavaScript's Math.round(v * 10^digits) / 10^digits does, so every SDK sends the same. */
		static double Round(double V, int Digits);
		/** fdlibm's natural logarithm, bit for bit what JavaScript's Math.log returns in V8. */
		static double Log(double X);

	private:
		double Alpha;
		double Gamma;
		double LnGamma;
		std::vector<std::pair<int, int64_t>> Bins; // in the order they were first filled, like a JavaScript Map
		std::unordered_map<int, size_t> BinAt;
	};
}
