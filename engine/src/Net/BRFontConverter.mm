#import "BRFontConverter.h"
#import "BRCommon.h"

#include <woff2/decode.h>
#include <zlib.h>
#include <string>
#include <vector>
#include <string.h>

static inline uint32_t rd32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }
static inline uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static inline void wr32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)(v >> 24); p[1] = (uint8_t)(v >> 16); p[2] = (uint8_t)(v >> 8); p[3] = (uint8_t)v; }
static inline void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }

// Do `need` bytes at `off` fit in `len`? Without the sum: size_t is 32 bits on armv7, and a font's offset near 4 GB
// made "off + need > len" wrap around and pass, pointing outside the buffer.
static inline bool BRInside(size_t off, size_t need, size_t len) { return off <= len && need <= len - off; }

static uint32_t BRFontChecksum(const uint8_t *data, size_t len)
{
    uint32_t sum = 0;
    size_t words = (len + 3) / 4;
    for (size_t i = 0; i < words; i++) {
        uint32_t v = 0;
        for (int k = 0; k < 4; k++) {
            size_t idx = i * 4 + (size_t)k;
            v = (v << 8) | (idx < len ? data[idx] : 0);
        }
        sum += v;
    }
    return sum;
}

static bool BRIsSFNT(const uint8_t *p, size_t len)
{
    if (len < 12) return false;
    uint32_t tag = rd32(p);
    return tag == 0x00010000 || tag == 0x74727565 /* 'true' */ || tag == 0x4F54544F /* 'OTTO' */;
}

// Variable fonts (fvar/gvar tables) send the iOS 6 font parser into a path that takes about a
// minute and fails anyway ("FT_Get_MM_Var failed"). Dropping the variation tables leaves a
// static font at the default instance, which the old engine loads instantly.
// Returns false when the font is not variable (or cannot be made static, e.g. CFF2 outlines).
// Fonts with large OpenType layout tables (Inter's GPOS alone is hundreds of kilobytes) send the
// iOS 6 text layout through CoreText shaping for every line, which took MDN's home page over a
// minute. Above this size the layout tables are dropped as well: kerning and ligatures are lost,
// the page appears in seconds.
static const size_t BRHeavyLayoutTables = 24 * 1024;

// Icon fonts that draw each icon as the ligature of its name (Material Icons: 61 KB of ligatures, Material Symbols:
// 125 KB; "home" becomes the house) keep the table whatever its size: without it the icons are just their names. Such
// a font has hundreds of ligatures of four or more letters and nothing to position (no GPOS to speak of); a text font
// has kerning, and a few dozen long ligatures at most (Inter has arrows and the like: its text vanished when its
// tables were kept). Counts them in the GSUB ligature lookups (also behind extension lookups), up to `enough`.
// The offsets may repeat (every lookup naming one subtable, every set one short ligature): a few KB of GSUB, padded past
// BRHeavyLayoutTables (nothing once compressed in a WOFF2), asked for up to 65535^4 steps, and the thread converting
// the font (WebKit's loader thread for a data: font) spun for good. Real icon fonts take a few thousand steps; past the
// budget the count so far stands.
static const size_t BRLigatureWalkBudget = 1u << 20;

static size_t BRLongLigatures(const uint8_t *p, size_t len, size_t enough)
{
    if (len < 10) return 0;
    size_t listOff = rd16(p + 8), count = 0, budget = BRLigatureWalkBudget;
    if (!BRInside(listOff, 2, len)) return 0;
    uint16_t lookups = rd16(p + listOff);
    for (uint16_t i = 0; i < lookups; i++) {
        if (!--budget) return count;
        if (!BRInside(listOff + 2 + (size_t)i * 2, 2, len)) break;
        size_t lookup = listOff + rd16(p + listOff + 2 + (size_t)i * 2);
        if (!BRInside(lookup, 6, len)) continue;
        uint16_t type = rd16(p + lookup), subtables = rd16(p + lookup + 4);
        for (uint16_t j = 0; j < subtables; j++) {
            if (!--budget) return count;
            if (!BRInside(lookup + 6 + (size_t)j * 2, 2, len)) break;
            size_t sub = lookup + rd16(p + lookup + 6 + (size_t)j * 2);
            uint16_t subType = type;
            if (subType == 7) {   // extension: the real type and a 32-bit offset
                if (!BRInside(sub, 8, len)) continue;
                subType = rd16(p + sub + 2);
                uint32_t ext = rd32(p + sub + 4);
                if (ext > len - sub) continue;   // (sub + ext wrapped around on armv7 and passed the check below)
                sub += ext;
            }
            if (subType != 4 || !BRInside(sub, 6, len) || rd16(p + sub) != 1) continue;
            uint16_t sets = rd16(p + sub + 4);
            for (uint16_t k = 0; k < sets; k++) {
                if (!--budget) return count;
                if (!BRInside(sub + 6 + (size_t)k * 2, 2, len)) break;
                size_t set = sub + rd16(p + sub + 6 + (size_t)k * 2);
                if (!BRInside(set, 2, len)) continue;
                uint16_t ligatures = rd16(p + set);
                for (uint16_t m = 0; m < ligatures; m++) {
                    if (!--budget) return count;
                    if (!BRInside(set + 2 + (size_t)m * 2, 2, len)) break;
                    size_t lig = set + rd16(p + set + 2 + (size_t)m * 2);
                    if (BRInside(lig, 4, len) && rd16(p + lig + 2) >= 4 && ++count >= enough) return count;
                }
            }
        }
    }
    return count;
}

static const size_t BRIconLigatures = 64, BRIconMaxGPOS = 1024;

static bool BRStripVariationTables(const std::string &in, std::string &out, int *dropped, bool *droppedLayout)
{
    const uint8_t *p = (const uint8_t *)in.data();
    size_t len = in.size();
    if (!BRIsSFNT(p, len)) return false;
    uint16_t numTables = rd16(p + 4);
    if (len < 12 + (size_t)numTables * 16) return false;
    static const char *variationTags[] = { "fvar", "gvar", "avar", "cvar", "HVAR", "VVAR", "MVAR", "STAT", NULL };
    static const char *layoutTags[] = { "GSUB", "GPOS", "GDEF", "BASE", "JSTF", "morx", "mort", "kerx", NULL };
    struct Rec { char tag[4]; uint32_t checksum, offset, length; };
    std::vector<Rec> all;
    bool hasFvar = false, hasCFF2 = false;
    size_t layoutBytes = 0;
    const uint8_t *gsub = NULL;
    size_t gsubLength = 0, gposLength = 0;
    for (uint16_t i = 0; i < numTables; i++) {
        const uint8_t *r = p + 12 + (size_t)i * 16;
        Rec rec;
        memcpy(rec.tag, r, 4);
        rec.checksum = rd32(r + 4);
        rec.offset = rd32(r + 8);
        rec.length = rd32(r + 12);
        if (!BRInside(rec.offset, rec.length, len)) return false;   // (before anything uses the table)
        if (memcmp(rec.tag, "fvar", 4) == 0) hasFvar = true;
        if (memcmp(rec.tag, "CFF2", 4) == 0) hasCFF2 = true;
        if (memcmp(rec.tag, "GSUB", 4) == 0 || memcmp(rec.tag, "GPOS", 4) == 0) layoutBytes += rec.length;
        if (memcmp(rec.tag, "GSUB", 4) == 0) { gsub = p + rec.offset; gsubLength = rec.length; }
        if (memcmp(rec.tag, "GPOS", 4) == 0) gposLength = rec.length;
        all.push_back(rec);
    }
    bool heavy = layoutBytes > BRHeavyLayoutTables;
    size_t longLigatures = heavy && gsub && gposLength <= BRIconMaxGPOS ? BRLongLigatures(gsub, gsubLength, 100000) : 0;
    bool dropLayout = heavy && longLigatures < BRIconLigatures;
    if (heavy && !dropLayout) BRLog(@"Ligature icon font (%lu ligatures of 4+ letters): its %lu KB of OpenType layout kept", (unsigned long)longLigatures, (unsigned long)(layoutBytes >> 10));
    if (hasCFF2) return false;
    if (!hasFvar && !dropLayout) return false;
    std::vector<Rec> keep;
    for (size_t i = 0; i < all.size(); i++) {
        bool drop = false;
        if (hasFvar) for (int k = 0; variationTags[k]; k++) if (memcmp(all[i].tag, variationTags[k], 4) == 0) drop = true;
        if (dropLayout) for (int k = 0; layoutTags[k]; k++) if (memcmp(all[i].tag, layoutTags[k], 4) == 0) drop = true;
        if (!drop) keep.push_back(all[i]);
    }
    // Every kept table is copied out: a directory listing one table thousands of times (or overlapping ones) would make
    // the copy many times the font. Real fonts never overlap (the font sanitizers of other browsers refuse that), so
    // their tables add up to less than the file.
    uint64_t keptBytes = 0;
    for (size_t i = 0; i < keep.size(); i++) keptBytes += keep[i].length;
    if (keptBytes > len) return false;
    *dropped = (int)(numTables - keep.size());
    *droppedLayout = dropLayout;
    uint16_t n = (uint16_t)keep.size();
    uint16_t entrySelector = 0;
    while ((1u << (entrySelector + 1)) <= n) entrySelector++;
    uint16_t searchRange = (uint16_t)((1u << entrySelector) * 16);
    uint16_t rangeShift = (uint16_t)(n * 16 - searchRange);
    out.assign(12 + (size_t)n * 16, '\0');
    uint8_t *o = (uint8_t *)&out[0];
    wr32(o, rd32(p));
    wr16(o + 4, n);
    wr16(o + 6, searchRange);
    wr16(o + 8, entrySelector);
    wr16(o + 10, rangeShift);
    size_t headOffset = 0;
    for (uint16_t i = 0; i < n; i++) {
        const Rec &rec = keep[i];
        while (out.size() % 4) out.push_back('\0');
        uint32_t newOffset = (uint32_t)out.size();
        out.append(in, rec.offset, rec.length);
        if (memcmp(rec.tag, "head", 4) == 0) headOffset = newOffset;
        uint8_t *r = (uint8_t *)&out[0] + 12 + (size_t)i * 16;   // after the append: the buffer may have moved
        memcpy(r, rec.tag, 4);
        wr32(r + 4, rec.checksum);
        wr32(r + 8, newOffset);
        wr32(r + 12, rec.length);
    }
    while (out.size() % 4) out.push_back('\0');
    if (headOffset && headOffset + 12 <= out.size()) {
        uint8_t *h = (uint8_t *)&out[0] + headOffset;
        wr32(h + 8, 0);
        uint32_t sum = BRFontChecksum((const uint8_t *)out.data(), out.size());
        wr32(h + 8, 0xB1B0AFBAu - sum);
    }
    return true;
}

// WOFF 1.0: an sfnt with zlib-compressed tables. The engine can load WOFF itself, but going through
// the converter lets the heavy layout tables be dropped like for every other font.
// The most it may decode to: real fonts are a few MB (a CJK one about 20). Without a limit a small file could claim
// gigabytes (tables of 64 MB each, all inflated from one shared compressed block) and take the iPad's memory.
static const uint64_t BRMaxWOFFOutput = 30u << 20;

static bool BRDecodeWOFF1(const uint8_t *p, size_t len, std::string &out)
{
    if (len < 44 || memcmp(p, "wOFF", 4) != 0) return false;
    uint32_t flavor = rd32(p + 4);
    uint16_t numTables = rd16(p + 12);
    if (numTables == 0 || len < 44 + (size_t)numTables * 20) return false;
    struct Entry { char tag[4]; uint32_t offset, compLength, origLength, checksum; };
    std::vector<Entry> entries;
    uint64_t total = 12 + (uint64_t)numTables * 16;   // the sfnt it becomes, padding included: known before anything is allocated
    for (uint16_t i = 0; i < numTables; i++) {
        const uint8_t *e = p + 44 + (size_t)i * 20;
        Entry en;
        memcpy(en.tag, e, 4);
        en.offset = rd32(e + 4);
        en.compLength = rd32(e + 8);
        en.origLength = rd32(e + 12);
        en.checksum = rd32(e + 16);
        if (!BRInside(en.offset, en.compLength, len)) return false;
        total += ((uint64_t)en.origLength + 3) & ~(uint64_t)3;
        if (total > BRMaxWOFFOutput) return false;   // (so also every single table)
        entries.push_back(en);
    }
    uint16_t entrySelector = 0;
    while ((1u << (entrySelector + 1)) <= numTables) entrySelector++;
    uint16_t searchRange = (uint16_t)((1u << entrySelector) * 16);
    uint16_t rangeShift = (uint16_t)(numTables * 16 - searchRange);
    out.assign(12 + (size_t)numTables * 16, '\0');
    out.reserve((size_t)total);   // one allocation: no copies while it grows
    uint8_t *h = (uint8_t *)&out[0];
    wr32(h, flavor);
    wr16(h + 4, numTables);
    wr16(h + 6, searchRange);
    wr16(h + 8, entrySelector);
    wr16(h + 10, rangeShift);
    for (uint16_t i = 0; i < numTables; i++) {
        const Entry &en = entries[i];
        while (out.size() % 4) out.push_back('\0');
        uint32_t newOffset = (uint32_t)out.size();
        if (en.compLength < en.origLength) {
            out.resize((size_t)newOffset + en.origLength);   // inflated in place: no second copy of the table
            uLongf destLen = en.origLength;
            if (uncompress((Bytef *)&out[newOffset], &destLen, p + en.offset, en.compLength) != Z_OK || destLen != en.origLength) return false;
        } else {
            out.append((const char *)p + en.offset, en.origLength);
        }
        uint8_t *r = (uint8_t *)&out[0] + 12 + (size_t)i * 16;
        memcpy(r, en.tag, 4);
        wr32(r + 4, en.checksum);
        wr32(r + 8, newOffset);
        wr32(r + 12, en.origLength);
    }
    while (out.size() % 4) out.push_back('\0');
    return true;
}

@implementation BRFontConverter

+ (BOOL)looksLikeWOFF:(NSData *)data
{
    if (data.length < 4) return NO;
    const uint8_t *b = (const uint8_t *)data.bytes;
    return b[0] == 'w' && b[1] == 'O' && b[2] == 'F' && b[3] == 'F';
}

+ (NSData *)ttfDataFromWOFF:(NSData *)data
{
    if (![self looksLikeWOFF:data]) return nil;
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    std::string out;
    if (!BRDecodeWOFF1((const uint8_t *)data.bytes, data.length, out)) {
        BRLog(@"WOFF decode failed (%lu bytes)", (unsigned long)data.length);
        return nil;
    }
    std::string flat;
    int dropped = 0;
    bool droppedLayout = false;
    bool trimmed = BRStripVariationTables(out, flat, &dropped, &droppedLayout);
    if (trimmed) out.swap(flat);
    BRLog(@"WOFF -> TTF: %lu -> %lu bytes in %ld ms%@", (unsigned long)data.length, (unsigned long)out.size(),
          (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000),
          trimmed ? [NSString stringWithFormat:@" (%d tables dropped%@)", dropped, droppedLayout ? @", heavy OpenType layout removed" : @""] : @"");
    return [NSData dataWithBytes:out.data() length:out.size()];
}

+ (BOOL)looksLikeWOFF2:(NSData *)data
{
    if (data.length < 4) return NO;
    const uint8_t *b = (const uint8_t *)data.bytes;
    return b[0] == 'w' && b[1] == 'O' && b[2] == 'F' && b[3] == '2';
}

+ (NSData *)ttfDataFromWOFF2:(NSData *)data
{
    if (![self looksLikeWOFF2:data]) return nil;
    std::string out;
    woff2::WOFF2StringOut sink(&out);
    sink.SetMaxSize(48u << 20);
    NSTimeInterval t0 = [NSDate timeIntervalSinceReferenceDate];
    bool ok = woff2::ConvertWOFF2ToTTF((const uint8_t *)data.bytes, data.length, &sink);
    if (!ok || out.empty()) {
        BRLog(@"WOFF2 decode failed (%lu bytes)", (unsigned long)data.length);
        return nil;
    }
    std::string flat;
    int dropped = 0;
    bool droppedLayout = false;
    bool trimmed = BRStripVariationTables(out, flat, &dropped, &droppedLayout);
    if (trimmed) out.swap(flat);
    BRLog(@"WOFF2 -> TTF: %lu -> %lu bytes in %ld ms%@", (unsigned long)data.length, (unsigned long)out.size(),
          (long)(([NSDate timeIntervalSinceReferenceDate] - t0) * 1000),
          trimmed ? [NSString stringWithFormat:@" (%d tables dropped%@)", dropped, droppedLayout ? @", heavy OpenType layout removed" : @""] : @"");
    return [NSData dataWithBytes:out.data() length:out.size()];
}

+ (NSData *)staticFontDataFromSFNT:(NSData *)data
{
    if (data.length < 12 || !BRIsSFNT((const uint8_t *)data.bytes, data.length)) return nil;
    std::string in((const char *)data.bytes, data.length);
    std::string flat;
    int dropped = 0;
    bool droppedLayout = false;
    if (!BRStripVariationTables(in, flat, &dropped, &droppedLayout)) return nil;
    BRLog(@"TTF trimmed: %lu -> %lu bytes, %d tables dropped%@", (unsigned long)in.size(), (unsigned long)flat.size(), dropped, droppedLayout ? @", heavy OpenType layout removed" : @"");
    return [NSData dataWithBytes:flat.data() length:flat.size()];
}

@end
