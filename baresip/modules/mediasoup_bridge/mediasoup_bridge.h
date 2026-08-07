/**
 * @file mediasoup_bridge.h Internal mediasoup bridge interfaces
 */

#ifndef MEDIASOUP_BRIDGE_H
#define MEDIASOUP_BRIDGE_H

#include <re.h>
#include <rem.h>
#include <baresip.h>
#include <opus/opus.h>


enum {
	MS_SRATE             = 48000,
	MS_CHANNELS          = 2,
	MS_PTIME             = 20,
	MS_FRAME_SAMP_PER_CH = MS_SRATE * MS_PTIME / 1000,
	MS_FRAME_SAMPC       = MS_FRAME_SAMP_PER_CH * MS_CHANNELS,
	MS_OPUS_MAX_PACKET   = 4000,
	MS_OPUS_MAX_FRAME    = 5760,
	MS_KEY_SIZE          = 128,
	MS_CALL_TOKEN_HEX_LEN = 64,
	MS_CALL_TOKEN_SIZE   = MS_CALL_TOKEN_HEX_LEN + 1,
	MS_PRODUCER_SIZE     = 128,
	MS_ERROR_SIZE        = 96,
	MS_TELEMETRY_MS      = 200,
	MS_KEEPALIVE_MS      = 1000,
	MS_ACTIVITY_HOLD_MS  = 400,
	MS_PROBE_INTERVAL_MS = 15,
	MS_BITRATE_DEFAULT   = 64000,
	MS_BITRATE_MIN       = 6000,
	MS_BITRATE_MAX       = 510000,
};

#define MS_ACTIVITY_DBFS (-60.0)
#define MS_DBFS_FLOOR    (-96.0)
#define MS_PORT_NONE     ((size_t)-1)


struct ms_context;
struct ms_caller;
struct ms_source;


struct ms_port_pool {
	mtx_t *mutex;
	bool *used;
	uint16_t first;
	uint16_t last;
	size_t count;
};


struct ausrc_st {
	struct ms_caller *caller;
	struct ausrc_prm prm;
	ausrc_read_h *rh;
	ausrc_error_h *errh;
	void *arg;
	struct auresamp resamp;
	int16_t *s16;
	void *native;
	size_t sampc;
	size_t s16_capacity;
	bool tracked;
};


struct auplay_st {
	struct ms_caller *caller;
	struct auplay_prm prm;
	auplay_write_h *wh;
	void *arg;
	struct auresamp resamp;
	int16_t *s16;
	void *native;
	size_t sampc;
	size_t s16_capacity;
	bool tracked;
};


struct ms_caller {
	struct le le;
	mtx_t *mutex;
	struct ausrc_st *src;
	struct auplay_st *play;
	struct aumix_source *tx_mix_source;
	struct aumix_source *rx_mix_source;
	char key[MS_KEY_SIZE];
	char call_token[MS_CALL_TOKEN_SIZE];
	bool mix_local_callers;
	bool attached;
	bool stopped;
};


struct ms_source {
	struct le le;
	struct ms_context *ctx;
	char producer_id[MS_PRODUCER_SIZE];
	struct rtp_sock *rtp;
	struct sa remote;
	struct jbuf *jbuf;
	struct aumix_source *mix_source;
	OpusDecoder *decoder;
	int16_t *decode_buf;
	struct tmr decode_tmr;
	size_t pool_index;
	uint16_t local_port;
	uint8_t pt;
	uint32_t expected_ssrc;
	uint32_t latched_ssrc;
	uint16_t last_seq;
	bool seq_set;
	bool active;
	bool decode_started;
	uint64_t last_rx_ms;
	uint64_t last_probe_ms;
	uint64_t rx_packets;
	uint64_t rx_bytes;
	uint64_t rx_invalid;
	uint64_t rx_lost;
	uint64_t plc_frames;
	uint64_t decode_errors;
	double level_dbfs;
	uint64_t telemetry_ms;
};


struct ms_context {
	struct le le;
	char key[MS_KEY_SIZE];
	mtx_t *mutex;
	mtx_t *pairing_mutex;
	struct aumix *tx_mix;
	struct aumix *rx_mix;
	struct aumix_source *tx_sink;
	struct list callers;
	struct list sources;
	OpusEncoder *encoder;
	struct rtp_sock *tx_rtp;
	struct sa tx_remote;
	struct mbuf *tx_mbuf;
	uint16_t tx_local_port;
	uint8_t tx_pt;
	uint32_t tx_ssrc;
	uint16_t tx_seq;
	uint32_t tx_timestamp;
	uint64_t tx_socket_generation;
	bool tx_ready;
	bool tx_muted;
	bool mix_local_callers;
	bool closing;
	int bitrate_bps;
	uint64_t tx_packets;
	uint64_t tx_bytes;
	uint64_t tx_errors;
	uint64_t tx_last_frame_ms;
	double tx_level_dbfs;
	bool tx_active_sent;
	bool rx_active_sent;
	bool telemetry_initialized;
	uint64_t tx_telemetry_ms;
	uint64_t rx_telemetry_ms;
	char last_error[MS_ERROR_SIZE];
	int last_errno;
	uint64_t error_generation;
	uint64_t error_emitted_generation;
};


extern struct list ms_contexts;
extern mtx_t *ms_contexts_mutex;
extern struct ms_port_pool ms_port_pool;
extern struct sa ms_bind_addr;


bool ms_valid_identifier(const char *value, size_t max_len);
double ms_level_dbfs(const int16_t *sampv, size_t sampc);
void ms_context_error(struct ms_context *ctx, const char *reason, int err);
void ms_emit_error(const char *key, const char *reason, int err);

int ms_context_get_or_create(struct ms_context **ctxp, const char *key,
			     bool *created);
struct ms_context *ms_context_lookup(const char *key);
int ms_context_close(const char *key, bool *changed);
int ms_context_configure(struct ms_context *ctx, bool mix_local_callers,
			 int bitrate_bps, bool *changed);
int ms_context_audio_alloc(struct ms_context *ctx);
void ms_context_audio_close(struct ms_context *ctx);
void ms_context_detach_callers(struct ms_context *ctx);

int ms_audio_register(void);
void ms_audio_unregister(void);
size_t ms_audio_active_devices(void);

int ms_tx_configure(struct ms_context *ctx, const struct sa *remote,
		    uint8_t pt, uint32_t ssrc, bool *changed);
int ms_tx_set_mute(struct ms_context *ctx, bool mute, bool *changed);

int ms_port_pool_init(uint16_t first, uint16_t last);
void ms_port_pool_close(void);
size_t ms_port_pool_used(void);
int ms_rtp_socket_alloc(struct rtp_sock **rtpp, size_t *pool_index,
			uint16_t *port, rtp_recv_h *recvh, void *arg);
int ms_rtp_socket_alloc_ephemeral(struct rtp_sock **rtpp, uint16_t *port,
				  rtp_recv_h *recvh, void *arg);
void ms_rtp_socket_release(struct rtp_sock **rtpp, size_t *pool_index);
int ms_send_probe(struct rtp_sock *rtp, const struct sa *remote,
		  unsigned count);

int ms_source_reserve(struct ms_context *ctx, const char *producer_id,
		      struct ms_source **srcp, bool *created);
struct ms_source *ms_source_find(struct ms_context *ctx,
				 const char *producer_id);
int ms_source_activate(struct ms_source *src, const struct sa *remote,
		       uint8_t pt, uint32_t ssrc, bool *changed);
int ms_source_remove(struct ms_context *ctx, const char *producer_id,
		     bool *changed);
void ms_source_keepalive(struct ms_source *src, uint64_t now);

int ms_commands_register(void);
void ms_commands_unregister(void);

#endif
