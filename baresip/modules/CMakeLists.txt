cmake_minimum_required(VERSION 3.10)

project(baresipui_modules LANGUAGES C)

# The packaged-image Dockerfile builds these modules outside the baresip source
# tree.  Reuse the upstream headers and FindOPUS module cloned for that build.
# In a normal baresip source build, the parent project already provides them.
if(EXISTS "/tmp/baresip-src/include/baresip.h")
    include_directories(
        /tmp/baresip-src/include
        /tmp/baresip-src/include/baresip
    )
endif()
if(EXISTS "/tmp/libre/include/re.h")
    include_directories(/tmp/libre/include)
endif()
if(EXISTS "/tmp/baresip-src/cmake/FindOPUS.cmake")
    list(APPEND CMAKE_MODULE_PATH /tmp/baresip-src/cmake)
endif()

# Presence Module
set(PRESENCE_SRCS 
    ${CMAKE_CURRENT_SOURCE_DIR}/presence.c 
    ${CMAKE_CURRENT_SOURCE_DIR}/subscriber.c 
    ${CMAKE_CURRENT_SOURCE_DIR}/notifier.c 
    ${CMAKE_CURRENT_SOURCE_DIR}/publisher.c
)

if(STATIC)
    add_library(presence OBJECT ${PRESENCE_SRCS})
else()
    add_library(presence MODULE ${PRESENCE_SRCS})
endif()
set_target_properties(presence PROPERTIES PREFIX "")

# This subdirectory is present in the standalone packaged-image build.  The
# full source build copies and registers mediasoup_bridge as a top-level
# baresip module instead, so it is intentionally absent below presence there.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/mediasoup_bridge/CMakeLists.txt")
    add_subdirectory(mediasoup_bridge)
    if(TARGET mediasoup_bridge)
        set_target_properties(mediasoup_bridge PROPERTIES PREFIX "")
    endif()
endif()

list(APPEND MODULES_DETECTED presence)

if(NOT CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
    set(MODULES_DETECTED ${MODULES_DETECTED} PARENT_SCOPE)
endif()

