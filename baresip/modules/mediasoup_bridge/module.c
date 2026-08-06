/**
 * @file module.c mediasoup plain-RTP audio bridge module
 */

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "mediasoup_bridge.h"


struct list ms_contexts = LIST_INIT;
mtx_t *ms_contexts_mutex;
struct ms_port_pool ms_port_pool;
struct sa ms_bind_addr;

static struct tmr telemetry_tmr;


static void context_destructor(void *arg)
{
	struct ms_context *ctx = arg;

	list_unlink(&ctx->le);

	if (ctx->mutex) {
		mtx_lock(ctx->mutex);
		ctx->closing = true;
		mtx_unlock(ctx->mutex);
	}

	list_flush(&ctx->sources);
	ms_context_detach_callers(ctx);
	ctx->tx_rtp = mem_deref(ctx->tx_rtp);
	ms_context_audio_close(ctx);
	ctx->pairing_mutex = mem_deref(ctx->pairing_mutex);
	ctx->mutex = mem_deref(ctx->mutex);
}


bool ms_valid_identifier(const char *value, size_t max_len)
{
	const unsigned char *p = (const unsigned char *)value;
	size_t len;

	if (!str_isset(value))
		return false;

	len = str_len(value);
	if (len >= max_len)
		return false;

	for (; *p; ++p) {
		if (iscntrl(*p) || isspace(*p) || *p == '"' || *p == '\\' ||
		    *p == '|')
			return false;
	}

	return true;
}


double ms_level_dbfs(const int16_t *sampv, size_t sampc)
{
	double sum = 0.0;
	double rms;
	size_t i;

	if (!sampv || !sampc)
		return MS_DBFS_FLOOR;

	for (i = 0; i < sampc; ++i) {
		const double sample = (double)sampv[i];
		sum += sample * sample;
	}

	rms = sqrt(sum / (double)sampc);
	if (rms < 1.0)
		return MS_DBFS_FLOOR;

	return 20.0 * log10(rms / 32768.0);
}


void ms_emit_error(const char *key, const char *reason, int err)
{
	module_event("mediasoup_bridge", "MS_CTX_ERROR", NULL, NULL,
		     "{\"key\":\"%s\",\"reason\":\"%s\",\"errno\":%d}",
		     key ? key : "", reason ? reason : "unknown", err);
}


void ms_context_error(struct ms_context *ctx, const char *reason, int err)
{
	if (!ctx || !reason)
		return;

	mtx_lock(ctx->mutex);
	str_ncpy(ctx->last_error, reason, sizeof(ctx->last_error));
	ctx->last_errno = err;
	++ctx->error_generation;
	mtx_unlock(ctx->mutex);
}


static struct ms_context *context_find_locked(const char *key)
{
	struct le *le;

	for (le = ms_contexts.head; le; le = le->next) {
		struct ms_context *ctx = le->data;

		if (!str_cmp(ctx->key, key))
			return ctx;
	}

	return NULL;
}


static int context_alloc(struct ms_context **ctxp, const char *key)
{
	struct ms_context *ctx;
	int err;

	ctx = mem_zalloc(sizeof(*ctx), context_destructor);
	if (!ctx)
		return ENOMEM;

	ctx->mix_local_callers = true;
	ctx->bitrate_bps = MS_BITRATE_DEFAULT;
	ctx->tx_level_dbfs = MS_DBFS_FLOOR;
	str_ncpy(ctx->key, key, sizeof(ctx->key));
	list_init(&ctx->callers);
	list_init(&ctx->sources);

	err = mutex_alloc(&ctx->mutex);
	if (err)
		goto out;

	err = mutex_alloc(&ctx->pairing_mutex);
	if (err)
		goto out;

	err = ms_context_audio_alloc(ctx);
	if (err)
		goto out;

out:
	if (err)
		mem_deref(ctx);
	else
		*ctxp = ctx;

	return err;
}


int ms_context_get_or_create(struct ms_context **ctxp, const char *key,
			     bool *created)
{
	struct ms_context *candidate = NULL;
	struct ms_context *ctx;
	int err;

	if (!ctxp || !ms_valid_identifier(key, MS_KEY_SIZE))
		return EINVAL;

	mtx_lock(ms_contexts_mutex);
	ctx = context_find_locked(key);
	if (ctx) {
		*ctxp = mem_ref(ctx);
		mtx_unlock(ms_contexts_mutex);
		if (created)
			*created = false;
		return 0;
	}
	mtx_unlock(ms_contexts_mutex);

	err = context_alloc(&candidate, key);
	if (err)
		return err;

	mtx_lock(ms_contexts_mutex);
	ctx = context_find_locked(key);
	if (ctx) {
		*ctxp = mem_ref(ctx);
		mtx_unlock(ms_contexts_mutex);
		mem_deref(candidate);
		if (created)
			*created = false;
		return 0;
	}

	list_append(&ms_contexts, &candidate->le, candidate);
	*ctxp = mem_ref(candidate);
	mtx_unlock(ms_contexts_mutex);

	if (created)
		*created = true;

	info("mediasoup_bridge: opened context '%s'\n", key);
	return 0;
}


struct ms_context *ms_context_lookup(const char *key)
{
	struct ms_context *ctx;

	if (!ms_valid_identifier(key, MS_KEY_SIZE))
		return NULL;

	mtx_lock(ms_contexts_mutex);
	ctx = context_find_locked(key);
	if (ctx)
		mem_ref(ctx);
	mtx_unlock(ms_contexts_mutex);

	return ctx;
}


int ms_context_close(const char *key, bool *changed)
{
	struct ms_context *ctx;

	if (!ms_valid_identifier(key, MS_KEY_SIZE))
		return EINVAL;

	mtx_lock(ms_contexts_mutex);
	ctx = context_find_locked(key);
	if (!ctx) {
		mtx_unlock(ms_contexts_mutex);
		if (changed)
			*changed = false;
		return 0;
	}

	mem_ref(ctx);
	list_unlink(&ctx->le);
	mtx_lock(ctx->mutex);
	ctx->closing = true;
	mtx_unlock(ctx->mutex);
	mtx_unlock(ms_contexts_mutex);

	/* Release the list's ownership, then our temporary reference. */
	mem_deref(ctx);
	mem_deref(ctx);

	if (changed)
		*changed = true;

	info("mediasoup_bridge: closed context '%s'\n", key);
	return 0;
}


static bool source_is_active(const struct ms_source *src, uint64_t now)
{
	return src->active && src->last_rx_ms &&
	       now - src->last_rx_ms <= MS_ACTIVITY_HOLD_MS &&
	       src->level_dbfs > MS_ACTIVITY_DBFS;
}


static void telemetry_context(struct ms_context *ctx, uint64_t now)
{
	struct le *le;
	struct ms_source **sourcev = NULL;
	char error[MS_ERROR_SIZE];
	size_t source_count;
	size_t source_index = 0;
	size_t i;
	int error_number;
	uint64_t error_generation;
	uint64_t error_emitted;
	uint64_t tx_packets;
	double tx_level;
	bool tx_muted;
	bool tx_ready;
	bool tx_active;
	bool emit_tx;
	bool rx_active = false;
	bool emit_rx_active;

	mtx_lock(ctx->mutex);
	tx_packets = ctx->tx_packets;
	tx_level = ctx->tx_level_dbfs;
	tx_muted = ctx->tx_muted;
	tx_ready = ctx->tx_ready;
	tx_active = ctx->tx_last_frame_ms &&
		    now - ctx->tx_last_frame_ms <= MS_ACTIVITY_HOLD_MS &&
		    tx_level > MS_ACTIVITY_DBFS;
	emit_tx = (tx_ready || list_count(&ctx->callers)) &&
		  now - ctx->tx_telemetry_ms >= MS_TELEMETRY_MS;
	if (emit_tx) {
		ctx->tx_telemetry_ms = now;
		ctx->tx_active_sent = tx_active;
		ctx->telemetry_initialized = true;
	}
	error_generation = ctx->error_generation;
	error_emitted = ctx->error_emitted_generation;
	error_number = ctx->last_errno;
	str_ncpy(error, ctx->last_error, sizeof(error));
	source_count = list_count(&ctx->sources);
	if (source_count) {
		sourcev = mem_zalloc(source_count * sizeof(*sourcev), NULL);
		if (sourcev) {
			for (le = ctx->sources.head; le; le = le->next)
				sourcev[source_index++] = mem_ref(le->data);
		}
	}
	mtx_unlock(ctx->mutex);

	if (source_count && !sourcev) {
		ms_context_error(ctx, "telemetry-allocation-failed", ENOMEM);
		return;
	}

	if (emit_tx) {
		module_event("mediasoup_bridge", "MS_TX_ACTIVE", NULL, NULL,
			     "{\"key\":\"%s\",\"active\":%s,\"muted\":%s,"
			     "\"dbfs\":%.1f,\"packets\":%llu}",
			     ctx->key, tx_active ? "true" : "false",
			     tx_muted ? "true" : "false", tx_level,
			     (unsigned long long)tx_packets);
	}

	for (i = 0; i < source_index; ++i) {
		struct ms_source *src = sourcev[i];
		const bool active = source_is_active(src, now);

		ms_source_keepalive(src, now);
		rx_active |= active;

		if (src->active && src->last_rx_ms &&
		    now - src->last_rx_ms <= MS_KEEPALIVE_MS &&
		    now - src->telemetry_ms >= MS_TELEMETRY_MS) {
			src->telemetry_ms = now;
			module_event(
				"mediasoup_bridge", "MS_RX_LEVEL", NULL, NULL,
				"{\"key\":\"%s\",\"producerId\":\"%s\","
				"\"active\":%s,\"dbfs\":%.1f,\"packets\":%llu}",
				ctx->key, src->producer_id,
				active ? "true" : "false", src->level_dbfs,
				(unsigned long long)src->rx_packets);
		}
	}

	mtx_lock(ctx->mutex);
	emit_rx_active = !ctx->telemetry_initialized ||
			 rx_active != ctx->rx_active_sent ||
			 now - ctx->rx_telemetry_ms >= MS_KEEPALIVE_MS;
	if (emit_rx_active) {
		ctx->rx_active_sent = rx_active;
		ctx->rx_telemetry_ms = now;
		ctx->telemetry_initialized = true;
	}
	if (error_generation != error_emitted)
		ctx->error_emitted_generation = error_generation;
	mtx_unlock(ctx->mutex);

	if (emit_rx_active) {
		module_event("mediasoup_bridge", "MS_RX_ACTIVE", NULL, NULL,
			     "{\"key\":\"%s\",\"active\":%s}",
			     ctx->key, rx_active ? "true" : "false");
	}

	if (error_generation != error_emitted)
		ms_emit_error(ctx->key, error, error_number);

	for (i = 0; i < source_index; ++i)
		mem_deref(sourcev[i]);
	mem_deref(sourcev);
}


static void telemetry_handler(void *arg)
{
	struct ms_context **contextv = NULL;
	struct le *le;
	size_t context_count;
	size_t context_index = 0;
	size_t i;
	uint64_t now = tmr_jiffies();
	(void)arg;

	tmr_start(&telemetry_tmr, MS_TELEMETRY_MS, telemetry_handler, NULL);

	mtx_lock(ms_contexts_mutex);
	context_count = list_count(&ms_contexts);
	if (context_count) {
		contextv = mem_zalloc(context_count * sizeof(*contextv), NULL);
		if (contextv) {
			for (le = ms_contexts.head; le; le = le->next)
				contextv[context_index++] = mem_ref(le->data);
		}
	}
	mtx_unlock(ms_contexts_mutex);

	for (i = 0; i < context_index; ++i) {
		telemetry_context(contextv[i], now);
		mem_deref(contextv[i]);
	}
	mem_deref(contextv);
}


static int parse_port_range(uint16_t *first, uint16_t *last)
{
	char value[64];
	char *dash;
	char *end;
	unsigned long lo;
	unsigned long hi;
	int err;

	err = conf_get_str(conf_cur(), "mediasoup_bridge_rtp_ports",
			   value, sizeof(value));
	if (err) {
		warning("mediasoup_bridge: missing "
			"mediasoup_bridge_rtp_ports\n");
		return err;
	}

	dash = strchr(value, '-');
	if (!dash || dash == value || !dash[1] || strchr(dash + 1, '-'))
		return EINVAL;

	*dash = '\0';
	errno = 0;
	lo = strtoul(value, &end, 10);
	if (errno || *end)
		return EINVAL;

	errno = 0;
	hi = strtoul(dash + 1, &end, 10);
	if (errno || *end || lo < 1024 || hi > 65535 || lo > hi)
		return EINVAL;

	*first = (uint16_t)lo;
	*last = (uint16_t)hi;
	return 0;
}


static int load_config(uint16_t *first, uint16_t *last)
{
	char bind_addr[64] = "0.0.0.0";
	int err;

	err = parse_port_range(first, last);
	if (err) {
		warning("mediasoup_bridge: invalid RTP port range (%m)\n", err);
		return err;
	}

	(void)conf_get_str(conf_cur(), "mediasoup_bridge_bind_addr",
			   bind_addr, sizeof(bind_addr));

	err = sa_set_str(&ms_bind_addr, bind_addr, 0);
	if (err) {
		warning("mediasoup_bridge: invalid bind address '%s' (%m)\n",
			bind_addr, err);
		return err;
	}

	return 0;
}


static int module_init(void)
{
	uint16_t first;
	uint16_t last;
	int err;

	err = load_config(&first, &last);
	if (err)
		return err;

	err = mutex_alloc(&ms_contexts_mutex);
	if (err)
		return err;

	err = ms_port_pool_init(first, last);
	if (err)
		goto out;

	err = ms_audio_register();
	if (err)
		goto out;

	err = ms_commands_register();
	if (err)
		goto out;

	tmr_start(&telemetry_tmr, MS_TELEMETRY_MS, telemetry_handler, NULL);

	info("mediasoup_bridge: loaded, bind=%J, even RTP ports %u-%u "
	     "(%zu slots)\n", &ms_bind_addr, ms_port_pool.first,
	     ms_port_pool.last, ms_port_pool.count);
	return 0;

out:
	ms_commands_unregister();
	ms_audio_unregister();
	ms_port_pool_close();
	ms_contexts_mutex = mem_deref(ms_contexts_mutex);
	return err;
}


static int module_close(void)
{
	size_t active;

	tmr_cancel(&telemetry_tmr);
	ms_commands_unregister();
	active = ms_audio_active_devices();
	ms_audio_unregister();

	for (;;) {
		struct ms_context *ctx;

		mtx_lock(ms_contexts_mutex);
		if (!ms_contexts.head) {
			mtx_unlock(ms_contexts_mutex);
			break;
		}
		ctx = mem_ref(ms_contexts.head->data);
		list_unlink(&ctx->le);
		mtx_lock(ctx->mutex);
		ctx->closing = true;
		mtx_unlock(ctx->mutex);
		mtx_unlock(ms_contexts_mutex);

		/* Drop list ownership and this loop's retained reference. */
		mem_deref(ctx);
		mem_deref(ctx);
	}

	if (active) {
		warning("mediasoup_bridge: unloading with %zu active device "
			"halves during shutdown is unsupported\n", active);
	}
	ms_port_pool_close();
	ms_contexts_mutex = mem_deref(ms_contexts_mutex);

	info("mediasoup_bridge: unloaded\n");
	return 0;
}


EXPORT_SYM const struct mod_export DECL_EXPORTS(mediasoup_bridge) = {
	"mediasoup_bridge",
	"audio",
	module_init,
	module_close,
};
