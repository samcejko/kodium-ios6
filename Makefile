# Kodium - a code editor (the VS Code workbench) for jailbroken iOS 6.x (armv7), on the engine of the Surfari browser.
# Built with Theos. Deployment target iOS 6.0, compiled against the iOS 9.3 SDK. CI (.github/workflows/build.yml)
# fetches what vendor/ needs and builds the workbench into Resources/site first.

TARGET := iphone:clang:9.3:6.0
ARCHS := armv7
DEBUG ?= 0

# Device used by `make install` (Theos): THEOS_DEVICE_IP=<address>, else "ipad" from tools/local.json.
ifeq ($(origin THEOS_DEVICE_IP),undefined)
KODIUM_LOCAL_IPAD := $(shell sed -n 's/.*"ipad"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' tools/local.json 2>/dev/null)
ifneq ($(KODIUM_LOCAL_IPAD),)
THEOS_DEVICE_IP := $(KODIUM_LOCAL_IPAD)
endif
endif
THEOS_DEVICE_USER ?= root

include $(THEOS)/makefiles/common.mk

APPLICATION_NAME := Kodium

# Surfari's engine (engine/, see tools/sync-engine.ps1) and the libraries it needs, fetched by CI into vendor/:
# woff2 and brotli decoders (WOFF2 fonts become TTF), the libwebp decoder (encoder dsp files are removed by CI)
WOFF2_FILES := vendor/woff2/src/woff2_dec.cc vendor/woff2/src/woff2_common.cc vendor/woff2/src/woff2_out.cc \
               vendor/woff2/src/table_tags.cc vendor/woff2/src/variable_length.cc
BROTLI_FILES := $(wildcard vendor/brotli/c/common/*.c) $(wildcard vendor/brotli/c/dec/*.c)
WEBP_FILES := $(wildcard vendor/libwebp/src/dec/*.c) $(wildcard vendor/libwebp/src/dsp/*.c) $(wildcard vendor/libwebp/src/utils/*.c) $(wildcard vendor/libwebp/src/demux/*.c)

Kodium_FILES := $(wildcard src/*.m) \
                $(wildcard engine/src/*.m) $(wildcard engine/src/Net/*.m) $(wildcard engine/src/Net/*.mm) \
                engine/vendor/mbedtls_glue.c engine/vendor/cxx_glue.cc \
                $(wildcard vendor/mbedtls/library/*.c) \
                $(WOFF2_FILES) $(BROTLI_FILES) $(WEBP_FILES)

Kodium_FRAMEWORKS := UIKit Foundation CoreGraphics QuartzCore Security ImageIO

# Flags for every C-family file (also the vendored sources)
Kodium_CFLAGS := -Isrc -Iengine/src -Iengine/src/Net -Iengine/vendor \
                 -Ivendor -Ivendor/mbedtls/include -Ivendor/mbedtls/library \
                 -Ivendor/woff2/include -Ivendor/brotli/c/include -Ivendor/libwebp -Ivendor/libwebp/src \
                 -Os -fvisibility=hidden \
                 -Wall -Wno-unused-variable -Wno-unused-function -Wno-unused-but-set-variable \
                 -Wno-deprecated-declarations -Wno-unknown-warning-option \
                 -Wno-nullability-completeness -Wno-nullability-completeness-on-arrays -Wno-error

# C++ (woff2) and Objective-C++ (the engine's font converter)
Kodium_CCFLAGS := -std=c++11 -stdlib=libc++ -fno-exceptions -fno-rtti -Wno-unused-parameter
Kodium_OBJCCFLAGS := -std=c++11 -stdlib=libc++ -fobjc-arc -fno-exceptions -fno-rtti

# Objective-C: ARC; APIs newer than iOS 6.0 are errors in the files that include BRCommon.h
Kodium_OBJCFLAGS := -fobjc-arc -Wunguarded-availability

Kodium_LDFLAGS := -lz -lc++ -lc++abi

# dynamic-codesigning switches on the Nitro JIT inside UIWebView on jailbroken devices
Kodium_CODESIGN_FLAGS := -SResources/entitlements.plist

include $(THEOS)/makefiles/application.mk

KODIUM_STAGED_APP := $(THEOS_STAGING_DIR)/Applications/Kodium.app
KODIUM_STAGED_BIN := $(KODIUM_STAGED_APP)/Kodium
KODIUM_DOC_DIR := $(THEOS_STAGING_DIR)/usr/share/doc/com.samcejko.kodium

# After staging (the .deb, and CI's IPAs made from the staged app):
# - The iOS 9.3 SDK puts the NSURL* classes in CFNetwork, where iOS 6 does not have them: the CFNetwork load command
#   points at Foundation instead, and the binary is signed again (as in Surfari).
# - The root copies of the page shims go when CI's minified js/<name>.js is there (the engine takes js/ first);
#   cssfix.js and jsfix.js stay, the engine's rewriters load them. entitlements.plist is for the signing only.
# - LICENSE and the third-party notices go to /usr/share/doc/<package>, and a postinst rebuilds the home screen's app
#   list (uicache).
# - A preinst refuses the .deb while an IPA copy of the app is installed (one bundle id: only one of them would show).
after-stage::
	install_name_tool -change /System/Library/Frameworks/CFNetwork.framework/CFNetwork /System/Library/Frameworks/Foundation.framework/Foundation "$(KODIUM_STAGED_BIN)"
	ldid -SResources/entitlements.plist "$(KODIUM_STAGED_BIN)"
	for n in shims shims-extra page-prelude regexp-shim; do \
		if [ -s "$(KODIUM_STAGED_APP)/js/$$n.js" ]; then rm -f "$(KODIUM_STAGED_APP)/$$n.js"; fi; \
	done
	rm -f "$(KODIUM_STAGED_APP)/entitlements.plist"
	mkdir -p "$(KODIUM_DOC_DIR)" "$(THEOS_STAGING_DIR)/DEBIAN"
	cp LICENSE THIRD_PARTY_NOTICES.md "$(KODIUM_DOC_DIR)/"
	printf '%s\n' '#!/bin/sh' \
		'[ "$$1" = configure ] || exit 0' \
		'command -v uicache >/dev/null 2>&1 || exit 0' \
		'if [ "$$(id -u 2>/dev/null)" = 0 ]; then su mobile -c uicache >/dev/null 2>&1 || su -c uicache mobile >/dev/null 2>&1; else uicache >/dev/null 2>&1; fi' \
		'exit 0' > "$(THEOS_STAGING_DIR)/DEBIAN/postinst"
	chmod 0755 "$(THEOS_STAGING_DIR)/DEBIAN/postinst"
	printf '%s\n' '#!/bin/sh' \
		'case "$$1" in install|upgrade) ;; *) exit 0 ;; esac' \
		'for d in /var/mobile/Applications/*/Kodium.app; do' \
		'  [ -f "$$d/Info.plist" ] || continue' \
		'  if grep -q com.samcejko.kodium "$$d/Info.plist" 2>/dev/null; then' \
		'    echo "Kodium is already installed from an IPA ($$d)." >&2' \
		'    echo "Delete that copy from the home screen first: the IPA and the .deb cannot be installed together." >&2' \
		'    exit 1' \
		'  fi' \
		'done' \
		'exit 0' > "$(THEOS_STAGING_DIR)/DEBIAN/preinst"
	chmod 0755 "$(THEOS_STAGING_DIR)/DEBIAN/preinst"
