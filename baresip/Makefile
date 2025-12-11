# Makefile for rtcpstats_periodic module

CC = gcc
CFLAGS = -fPIC -shared -Wall -I/tmp/libre/include -I/tmp/baresip-src/include
LDFLAGS = -shared

rtcpstats_periodic.so: rtcpstats_periodic.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o rtcpstats_periodic.so rtcpstats_periodic.c
