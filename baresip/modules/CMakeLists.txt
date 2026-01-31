include_directories(/tmp/baresip-src/include)
include_directories(/tmp/baresip-src/include/baresip)
include_directories(/tmp/libre/include)

cmake_minimum_required(VERSION 3.10)

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

list(APPEND MODULES_DETECTED presence)

# Pubip Module (NAT traversal with public IP) - DISABLED due to API compatibility issues
# The Public IP functionality is handled by re-sipreg-public-ip.patch in libre
# if(STATIC)
#     add_library(pubip OBJECT ${CMAKE_CURRENT_SOURCE_DIR}/pubip.c)
# else()
#     add_library(pubip MODULE ${CMAKE_CURRENT_SOURCE_DIR}/pubip.c)
# endif()
# list(APPEND MODULES_DETECTED pubip)

set(MODULES_DETECTED ${MODULES_DETECTED} PARENT_SCOPE)

