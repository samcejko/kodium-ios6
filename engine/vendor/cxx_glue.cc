/*
 * C++ allocation functions for iOS 6.
 *
 * The iOS 9.3 SDK binds operator new/delete to libc++abi, which on iOS 6 does not export them
 * (they lived in libstdc++ back then), so the app died with "Symbol not found: __Znwm" the first
 * time the woff2 decoder allocated. Defining the replaceable allocation functions here removes the
 * dependency altogether.
 */
#include <cstdlib>
#include <new>

void *operator new(std::size_t n)
{
    void *p = std::malloc(n ? n : 1);
    if (!p) std::abort();
    return p;
}

void *operator new[](std::size_t n)
{
    void *p = std::malloc(n ? n : 1);
    if (!p) std::abort();
    return p;
}

void *operator new(std::size_t n, const std::nothrow_t &) noexcept
{
    return std::malloc(n ? n : 1);
}

void *operator new[](std::size_t n, const std::nothrow_t &) noexcept
{
    return std::malloc(n ? n : 1);
}

void operator delete(void *p) noexcept
{
    std::free(p);
}

void operator delete[](void *p) noexcept
{
    std::free(p);
}

void operator delete(void *p, const std::nothrow_t &) noexcept
{
    std::free(p);
}

void operator delete[](void *p, const std::nothrow_t &) noexcept
{
    std::free(p);
}
