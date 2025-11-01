include_directories(/tmp/baresip-src/include)
include_directories(/tmp/baresip-src/include/baresip)

cmake_minimum_required(VERSION 3.10)
project(presence)

include_directories(/tmp/baresip-src/include /tmp/libre/include)

list(APPEND MODULES_DETECTED ${PROJECT_NAME})
set(MODULES_DETECTED ${MODULES_DETECTED} PARENT_SCOPE)

set(SRCS presence.c subscriber.c notifier.c publisher.c)

if(STATIC)
    add_library(${PROJECT_NAME} OBJECT ${SRCS})
else()
    add_library(${PROJECT_NAME} MODULE ${SRCS})
endif()

