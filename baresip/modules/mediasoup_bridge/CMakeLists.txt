project(mediasoup_bridge)

find_package(OPUS)

if(NOT OPUS_FOUND)
  return()
endif()

list(APPEND MODULES_DETECTED ${PROJECT_NAME})
set(MODULES_DETECTED ${MODULES_DETECTED} PARENT_SCOPE)

set(SRCS
  module.c
  audio.c
  rtp.c
  commands.c
)

if(STATIC)
  add_library(${PROJECT_NAME} OBJECT ${SRCS})
else()
  add_library(${PROJECT_NAME} MODULE ${SRCS})
endif()

target_include_directories(${PROJECT_NAME} PRIVATE ${OPUS_INCLUDE_DIRS})
target_link_libraries(${PROJECT_NAME} PRIVATE ${OPUS_LIBRARIES} m)
target_compile_options(${PROJECT_NAME} PRIVATE -Wall -Wextra -Werror)
