project(vumeter_stereo)

list(APPEND MODULES_DETECTED ${PROJECT_NAME})
set(MODULES_DETECTED ${MODULES_DETECTED} PARENT_SCOPE)

set(SRCS vumeter_stereo.c)

if(STATIC)
  add_library(${PROJECT_NAME} OBJECT ${SRCS})
else()
  add_library(${PROJECT_NAME} MODULE ${SRCS})
endif()

target_link_libraries(${PROJECT_NAME} PRIVATE m)
