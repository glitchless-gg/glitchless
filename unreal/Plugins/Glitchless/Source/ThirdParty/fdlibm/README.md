# fdlibm's log

`fdlibm_log.h` is `__ieee754_log` from [fdlibm](https://www.netlib.org/fdlibm/) 5.3, the C maths library
Sun Microsystems wrote in 1993, as V8 carries it in `src/base/ieee754.cc` for JavaScript's `Math.log`.

**Why it is here:** Glitchless groups frame times into buckets by their logarithm. Every Glitchless SDK and the server
has to put a value in the same bucket, and the JavaScript ones use `Math.log`. The C library's `log` can differ from it
in the last bit on some systems, which moves values that sit on a bucket's edge. With this copy, the Unreal plugin's
buckets match JavaScript's on every platform and compiler (`unreal/test/core.mjs` checks 7,509 values against V8).

**Licence:** Sun's notice, kept at the top of the file:

> Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
> Developed at SunSoft, a Sun Microsystems, Inc. business.
> Permission to use, copy, modify, and distribute this software is freely granted, provided
> that this notice is preserved.

**Changes from the original:** written as one C++ function with Unreal's naming (`GlitchlessFdlibm::Log`), the high and
low words read through `memcpy` rather than pointer casts, and pragmas that turn off floating-point contraction and
fast-math, so the compiler can't change the result. The arithmetic is unchanged.
