# kodium-shelld: the shells of Kodium's terminal (see kodium-shelld.c), a package of its own: Kodium itself is installed
# as an app of /var/mobile/Applications (the IPA), where iOS's sandbox lets it start no process. Built with Theos as the
# app is (CI: .github/workflows/build.yml).

TARGET := iphone:clang:9.3:6.0
ARCHS := armv7

include $(THEOS)/makefiles/common.mk

TOOL_NAME := kodium-shelld
kodium-shelld_FILES := kodium-shelld.c
kodium-shelld_CFLAGS := -Os -Wall -Wno-unused-result
kodium-shelld_INSTALL_PATH := /usr/libexec
kodium-shelld_CODESIGN_FLAGS := -S

include $(THEOS_MAKE_PATH)/tool.mk
