/*
 * __ieee754_log from fdlibm 5.3, as V8 has it (src/base/ieee754.cc), so that Glitchless's frame-time
 * sketch puts every value in the bucket JavaScript's Math.log puts it in. See README.md beside this file.
 *
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 * Developed at SunSoft, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this software is freely granted, provided
 * that this notice is preserved.
 */
#pragma once

#include <cstdint>
#include <cstring>
#include <limits>

// The result has to come out the same on every compiler: no fused multiply-adds, no dividing by a
// reciprocal, no reassociating. Unreal builds MSVC with /fp:fast, and clang contracts a * b + c on
// ARM unless told not to.
#if defined(_MSC_VER) || defined(__clang__)
#pragma float_control(precise, on, push)
#endif
#if defined(_MSC_VER) && !defined(__clang__)
#pragma fp_contract(off)
#endif

namespace GlitchlessFdlibm
{
	namespace Detail
	{
		inline uint64_t Bits(double X)
		{
			uint64_t U;
			std::memcpy(&U, &X, sizeof(U));
			return U;
		}

		inline double FromBits(uint64_t U)
		{
			double X;
			std::memcpy(&X, &U, sizeof(X));
			return X;
		}

		inline double WithHighWord(double X, uint32_t Hi)
		{
			return FromBits((static_cast<uint64_t>(Hi) << 32) | (Bits(X) & 0xffffffffu));
		}
	}

	inline double Log(double X)
	{
#if defined(__clang__)
#pragma clang fp contract(off)
#endif
		using Detail::Bits;
		static const double Ln2Hi = 6.93147180369123816490e-01; // 3fe62e42 fee00000
		static const double Ln2Lo = 1.90821492927058770002e-10; // 3dea39ef 35793c76
		static const double Two54 = 1.80143985094819840000e+16; // 43500000 00000000
		static const double Lg1 = 6.666666666666735130e-01; // 3FE55555 55555593
		static const double Lg2 = 3.999999999940941908e-01; // 3FD99999 9997FA04
		static const double Lg3 = 2.857142874366239149e-01; // 3FD24924 94229359
		static const double Lg4 = 2.222219843214978396e-01; // 3FCC71C5 1D8E78AF
		static const double Lg5 = 1.818357216161805012e-01; // 3FC74664 96CB03DE
		static const double Lg6 = 1.531383769920937332e-01; // 3FC39A09 D078C69F
		static const double Lg7 = 1.479819860511658591e-01; // 3FC2F112 DF3E5244

		int32_t Hx = static_cast<int32_t>(Bits(X) >> 32);
		const uint32_t Lx = static_cast<uint32_t>(Bits(X));
		int32_t K = 0;
		if (Hx < 0x00100000) // x < 2**-1022
		{
			if (((Hx & 0x7fffffff) | Lx) == 0)
			{
				return -std::numeric_limits<double>::infinity(); // log(+-0) = -inf
			}
			if (Hx < 0)
			{
				return std::numeric_limits<double>::quiet_NaN(); // log(-#) = NaN
			}
			K -= 54;
			X *= Two54; // subnormal number, scale up x
			Hx = static_cast<int32_t>(Bits(X) >> 32);
		}
		if (Hx >= 0x7ff00000)
		{
			return X + X;
		}
		K += (Hx >> 20) - 1023;
		Hx &= 0x000fffff;
		int32_t I = (Hx + 0x95f64) & 0x100000;
		X = Detail::WithHighWord(X, static_cast<uint32_t>(Hx | (I ^ 0x3ff00000))); // normalize x or x/2
		K += I >> 20;
		const double F = X - 1.0;
		double Dk;
		double R;
		if ((0x000fffff & (2 + Hx)) < 3) // -2**-20 <= f < 2**-20
		{
			if (F == 0.0)
			{
				if (K == 0)
				{
					return 0.0;
				}
				Dk = static_cast<double>(K);
				return Dk * Ln2Hi + Dk * Ln2Lo;
			}
			R = F * F * (0.5 - 0.33333333333333333 * F);
			if (K == 0)
			{
				return F - R;
			}
			Dk = static_cast<double>(K);
			return Dk * Ln2Hi - ((R - Dk * Ln2Lo) - F);
		}
		const double S = F / (2.0 + F);
		Dk = static_cast<double>(K);
		const double Z = S * S;
		I = Hx - 0x6147a;
		const double W = Z * Z;
		const int32_t J = 0x6b851 - Hx;
		const double T1 = W * (Lg2 + W * (Lg4 + W * Lg6));
		const double T2 = Z * (Lg1 + W * (Lg3 + W * (Lg5 + W * Lg7)));
		I |= J;
		R = T2 + T1;
		if (I > 0)
		{
			const double Hfsq = 0.5 * F * F;
			if (K == 0)
			{
				return F - (Hfsq - S * (Hfsq + R));
			}
			return Dk * Ln2Hi - ((Hfsq - (S * (Hfsq + R) + Dk * Ln2Lo)) - F);
		}
		if (K == 0)
		{
			return F - S * (F - R);
		}
		return Dk * Ln2Hi - ((S * (F - R) - Dk * Ln2Lo) - F);
	}
}

#if defined(_MSC_VER) || defined(__clang__)
#pragma float_control(pop)
#endif
