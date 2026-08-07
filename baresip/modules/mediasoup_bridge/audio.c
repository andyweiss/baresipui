/**
 * @file audio.c Virtual audio devices and local-caller mixing
 */

#include <ctype.h>
#include <errno.h>
#include <string.h>

#include "mediasoup_bridge.h"


static struct ausrc *mediasoup_ausrc;
static struct auplay *mediasoup_auplay;
static mtx_t *device_mutex;
static size_t active_devices;


/*
 * Baresip's module API does not pin a dynamic module for the lifetime of
 * ausrc_st/auplay_st objects allocated by it.  The patched core therefore
 * rejects runtime rmmod for this module.  Deregistration is ordered first
 * during normal process shutdown so no new devices can be allocated while
 * contexts are being drained.
 */
static void device_track(bool add)
{
	if (!device_mutex)
		return;

	mtx_lock(device_mutex);
	if (add)
		++active_devices;
	else if (active_devices)
		--active_devices;
	mtx_unlock(device_mutex);
}


size_t ms_audio_active_devices(void)
{
	size_t count = 0;

	if (!device_mutex)
		return 0;

	mtx_lock(device_mutex);
	count = active_devices;
	mtx_unlock(device_mutex);
	return count;
}


static void record_error_locked(struct ms_context *ctx, const char *reason,
				int err)
{
	str_ncpy(ctx->last_error, reason, sizeof(ctx->last_error));
	ctx->last_errno = err;
	++ctx->error_generation;
}


static int send_rtp_locked(struct ms_context *ctx, const uint8_t *payload,
			   size_t payload_len)
{
	struct rtp_header hdr = {
		.ver  = RTP_VERSION,
		.m    = false,
		.pt   = ctx->tx_pt,
		.seq  = ++ctx->tx_seq,
		.ts   = ctx->tx_timestamp,
		.ssrc = ctx->tx_ssrc,
	};
	int err;

	mbuf_reset(ctx->tx_mbuf);
	err  = rtp_hdr_encode(ctx->tx_mbuf, &hdr);
	err |= mbuf_write_mem(ctx->tx_mbuf, payload, payload_len);
	if (err)
		return err;

	ctx->tx_mbuf->pos = 0;
	err = udp_send(rtp_sock(ctx->tx_rtp), &ctx->tx_remote, ctx->tx_mbuf);
	if (err)
		return err;

	++ctx->tx_packets;
	ctx->tx_bytes += ctx->tx_mbuf->end;
	ctx->tx_timestamp += MS_FRAME_SAMP_PER_CH;
	return 0;
}


static void tx_mix_handler(const int16_t *sampv, size_t sampc, void *arg)
{
	struct ms_context *ctx = arg;
	int16_t silence[MS_FRAME_SAMPC] = {0};
	uint8_t packet[MS_OPUS_MAX_PACKET];
	const int16_t *input = sampv;
	int encoded;
	int err;

	if (!ctx || !sampv || sampc != MS_FRAME_SAMPC)
		return;

	mtx_lock(ctx->mutex);
	if (ctx->closing) {
		mtx_unlock(ctx->mutex);
		return;
	}

	ctx->tx_level_dbfs = ms_level_dbfs(sampv, sampc);
	ctx->tx_last_frame_ms = tmr_jiffies();

	if (!ctx->tx_ready || !ctx->tx_rtp) {
		mtx_unlock(ctx->mutex);
		return;
	}

	if (ctx->tx_muted)
		input = silence;

	encoded = opus_encode(ctx->encoder, input, MS_FRAME_SAMP_PER_CH,
			      packet, sizeof(packet));
	if (encoded < 0) {
		++ctx->tx_errors;
		record_error_locked(ctx, "opus-encode-failed", EPROTO);
		mtx_unlock(ctx->mutex);
		return;
	}

	err = send_rtp_locked(ctx, packet, (size_t)encoded);
	if (err) {
		++ctx->tx_errors;
		record_error_locked(ctx, "rtp-send-failed", err);
	}
	mtx_unlock(ctx->mutex);
}


int ms_context_audio_alloc(struct ms_context *ctx)
{
	int opus_err;
	int err;

	if (!ctx)
		return EINVAL;

	ctx->encoder = opus_encoder_create(MS_SRATE, MS_CHANNELS,
					   OPUS_APPLICATION_VOIP, &opus_err);
	if (!ctx->encoder) {
		warning("mediasoup_bridge: opus encoder: %s\n",
			opus_strerror(opus_err));
		return ENOMEM;
	}

	opus_err  = opus_encoder_ctl(
		ctx->encoder, OPUS_SET_BITRATE(ctx->bitrate_bps));
	opus_err |= opus_encoder_ctl(ctx->encoder, OPUS_SET_VBR(1));
	opus_err |= opus_encoder_ctl(ctx->encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
	opus_err |= opus_encoder_ctl(ctx->encoder, OPUS_SET_DTX(0));
	if (opus_err != OPUS_OK) {
		warning("mediasoup_bridge: opus encoder setup: %s\n",
			opus_strerror(opus_err));
		return EPROTO;
	}

	err = aumix_alloc(&ctx->tx_mix, MS_SRATE, MS_CHANNELS, MS_PTIME);
	if (err)
		return err;

	err = aumix_alloc(&ctx->rx_mix, MS_SRATE, MS_CHANNELS, MS_PTIME);
	if (err)
		return err;

	ctx->tx_mbuf = mbuf_alloc(RTP_HEADER_SIZE + MS_OPUS_MAX_PACKET);
	if (!ctx->tx_mbuf)
		return ENOMEM;

	/*
	 * aumix callbacks are mix-minus-self. A silent sink therefore receives
	 * the complete sum of every local caller and clocks the Opus sender.
	 */
	err = aumix_source_alloc(&ctx->tx_sink, ctx->tx_mix,
				 tx_mix_handler, ctx);
	if (err)
		return err;

	aumix_source_enable(ctx->tx_sink, true);
	return 0;
}


void ms_context_audio_close(struct ms_context *ctx)
{
	if (!ctx)
		return;

	ctx->tx_sink = mem_deref(ctx->tx_sink);
	ctx->tx_mbuf = mem_deref(ctx->tx_mbuf);
	ctx->tx_mix = mem_deref(ctx->tx_mix);
	ctx->rx_mix = mem_deref(ctx->rx_mix);

	if (ctx->encoder) {
		opus_encoder_destroy(ctx->encoder);
		ctx->encoder = NULL;
	}
}


int ms_context_configure(struct ms_context *ctx, bool mix_local_callers,
			 int bitrate_bps, bool *changed)
{
	struct ms_caller **callerv = NULL;
	struct le *le;
	size_t caller_count = 0;
	size_t caller_index = 0;
	size_t i;
	bool config_changed;
	int opus_err;

	if (!ctx || bitrate_bps < MS_BITRATE_MIN ||
	    bitrate_bps > MS_BITRATE_MAX)
		return EINVAL;

	mtx_lock(ctx->mutex);
	if (ctx->closing) {
		mtx_unlock(ctx->mutex);
		return ESHUTDOWN;
	}

	config_changed = ctx->mix_local_callers != mix_local_callers ||
			 ctx->bitrate_bps != bitrate_bps;
	if (!config_changed) {
		if (changed)
			*changed = false;
		mtx_unlock(ctx->mutex);
		return 0;
	}

	if (ctx->mix_local_callers != mix_local_callers) {
		caller_count = list_count(&ctx->callers);
		if (caller_count) {
			callerv = mem_zalloc(caller_count * sizeof(*callerv),
					     NULL);
			if (!callerv) {
				mtx_unlock(ctx->mutex);
				return ENOMEM;
			}

			for (le = ctx->callers.head; le; le = le->next)
				callerv[caller_index++] = mem_ref(le->data);
		}
	}

	if (ctx->bitrate_bps != bitrate_bps) {
		opus_err = opus_encoder_ctl(
			ctx->encoder, OPUS_SET_BITRATE(bitrate_bps));
		if (opus_err != OPUS_OK) {
			record_error_locked(ctx, "opus-bitrate-failed", EPROTO);
			mtx_unlock(ctx->mutex);
			for (i = 0; i < caller_index; ++i)
				mem_deref(callerv[i]);
			mem_deref(callerv);
			return EPROTO;
		}
		ctx->bitrate_bps = bitrate_bps;
	}

	if (ctx->mix_local_callers != mix_local_callers) {
		ctx->mix_local_callers = mix_local_callers;
	}

	if (changed)
		*changed = true;
	mtx_unlock(ctx->mutex);

	for (i = 0; i < caller_index; ++i) {
		mtx_lock(callerv[i]->mutex);
		callerv[i]->mix_local_callers = mix_local_callers;
		mtx_unlock(callerv[i]->mutex);
		mem_deref(callerv[i]);
	}
	mem_deref(callerv);
	return 0;
}


static void tx_ignore_recv(const struct sa *src, const struct rtp_header *hdr,
			   struct mbuf *mb, void *arg)
{
	(void)src;
	(void)hdr;
	(void)mb;
	(void)arg;
}


int ms_tx_configure(struct ms_context *ctx, const struct sa *remote,
		    uint8_t pt, uint32_t ssrc, bool *changed)
{
	struct rtp_sock *candidate = NULL;
	struct rtp_sock *retired = NULL;
	struct rtp_sock *rtp = NULL;
	uint16_t candidate_port = 0;
	uint64_t generation;
	bool shutdown;
	bool same;
	bool allocated = false;
	int err;

	if (!ctx || !remote || pt > 127 || !ssrc)
		return EINVAL;
	if (sa_af(remote) != sa_af(&ms_bind_addr))
		return EAFNOSUPPORT;

	mtx_lock(ctx->mutex);
	if (ctx->closing) {
		mtx_unlock(ctx->mutex);
		return ESHUTDOWN;
	}
	if (ctx->tx_rtp)
		rtp = mem_ref(ctx->tx_rtp);
	mtx_unlock(ctx->mutex);

	if (!rtp) {
		err = ms_rtp_socket_alloc_ephemeral(&candidate, &candidate_port,
						    tx_ignore_recv, ctx);
		if (err) {
			mtx_lock(ctx->mutex);
			record_error_locked(ctx, "tx-socket-allocate-failed", err);
			mtx_unlock(ctx->mutex);
			return err;
		}

		mtx_lock(ctx->mutex);
		if (ctx->closing) {
			mtx_unlock(ctx->mutex);
			mem_deref(candidate);
			return ESHUTDOWN;
		}
		if (!ctx->tx_rtp) {
			ctx->tx_rtp = candidate;
			candidate = NULL;
			ctx->tx_local_port = candidate_port;
			++ctx->tx_socket_generation;
			allocated = true;
		}
		rtp = mem_ref(ctx->tx_rtp);
		mtx_unlock(ctx->mutex);
		mem_deref(candidate);
	}

	mtx_lock(ctx->mutex);
	generation = ctx->tx_socket_generation;
	mtx_unlock(ctx->mutex);

	/* The retained socket keeps all three probe sends alive without ctx lock. */
	err = ms_send_probe(rtp, remote, 3);
	if (err) {
		mtx_lock(ctx->mutex);
		if (allocated && ctx->tx_rtp == rtp &&
		    ctx->tx_socket_generation == generation &&
		    !ctx->tx_ready) {
			retired = ctx->tx_rtp;
			ctx->tx_rtp = NULL;
			ctx->tx_local_port = 0;
			++ctx->tx_socket_generation;
		}
		record_error_locked(ctx, "tx-probe-failed", err);
		mtx_unlock(ctx->mutex);
		mem_deref(retired);
		mem_deref(rtp);
		return err;
	}

	mtx_lock(ctx->mutex);
	if (ctx->closing || ctx->tx_rtp != rtp ||
	    ctx->tx_socket_generation != generation) {
		shutdown = ctx->closing;
		mtx_unlock(ctx->mutex);
		mem_deref(rtp);
		return shutdown ? ESHUTDOWN : EAGAIN;
	}

	same = ctx->tx_ready && ctx->tx_pt == pt && ctx->tx_ssrc == ssrc &&
	       sa_cmp(&ctx->tx_remote, remote, SA_ALL);
	if (!same) {
		ctx->tx_remote = *remote;
		ctx->tx_pt = pt;
		ctx->tx_ssrc = ssrc;
		ctx->tx_seq = rand_u16();
		ctx->tx_timestamp = rand_u32();
		ctx->tx_ready = true;
	}

	mtx_unlock(ctx->mutex);
	mem_deref(rtp);
	if (changed)
		*changed = !same;
	return 0;
}


int ms_tx_set_mute(struct ms_context *ctx, bool mute, bool *changed)
{
	if (!ctx)
		return EINVAL;

	mtx_lock(ctx->mutex);
	if (ctx->closing) {
		mtx_unlock(ctx->mutex);
		return ESHUTDOWN;
	}
	if (changed)
		*changed = ctx->tx_muted != mute;
	ctx->tx_muted = mute;
	mtx_unlock(ctx->mutex);

	return 0;
}


static bool supported_format(int fmt)
{
	return fmt == AUFMT_S16LE || fmt == AUFMT_FLOAT ||
	       fmt == AUFMT_S24_3LE;
}


static void caller_stop(struct ms_caller *caller)
{
	struct aumix_source *rx_source;
	struct aumix_source *tx_source;

	if (!caller || !caller->mutex)
		return;

	mtx_lock(caller->mutex);
	if (caller->stopped) {
		mtx_unlock(caller->mutex);
		return;
	}

	caller->stopped = true;
	rx_source = caller->rx_mix_source;
	tx_source = caller->tx_mix_source;
	caller->rx_mix_source = NULL;
	caller->tx_mix_source = NULL;
	mtx_unlock(caller->mutex);

	/* Stop the clocking callback before releasing its TX buffer. */
	if (rx_source)
		aumix_source_enable(rx_source, false);
	if (tx_source)
		aumix_source_enable(tx_source, false);
	mem_deref(rx_source);
	mem_deref(tx_source);
}


static void caller_destructor(void *arg)
{
	struct ms_caller *caller = arg;

	caller_stop(caller);
	caller->mutex = mem_deref(caller->mutex);
}


static void local_output_handler(const int16_t *sampv, size_t sampc, void *arg)
{
	struct ms_caller *caller = arg;
	struct ausrc_st *st;
	struct auframe af;
	size_t outc;
	int err = 0;

	if (!caller || !sampv || sampc != MS_FRAME_SAMPC)
		return;

	mtx_lock(caller->mutex);
	st = caller->src;
	if (caller->stopped || !st) {
		mtx_unlock(caller->mutex);
		return;
	}

	outc = st->s16_capacity;
	if (st->prm.srate == MS_SRATE && st->prm.ch == MS_CHANNELS) {
		memcpy(st->s16, sampv, sampc * sizeof(*sampv));
		outc = sampc;
	}
	else {
		err = auresamp(&st->resamp, st->s16, &outc, sampv, sampc);
	}

	if (err || outc != st->sampc) {
		memset(st->s16, 0, st->sampc * sizeof(*st->s16));
		outc = st->sampc;
	}

	if (st->prm.fmt == AUFMT_S16LE)
		memcpy(st->native, st->s16, outc * sizeof(*st->s16));
	else
		auconv_from_s16((enum aufmt)st->prm.fmt, st->native,
				st->s16, outc);

	auframe_init(&af, (enum aufmt)st->prm.fmt, st->native, outc,
		     st->prm.srate, st->prm.ch);
	af.timestamp = tmr_jiffies() * 1000;
	if (st->rh)
		st->rh(&af, st->arg);

	mtx_unlock(caller->mutex);
}


static void local_read_handler(struct auframe *af, void *arg)
{
	struct ms_caller *caller = arg;
	struct auplay_st *st;
	struct auframe native_af;
	size_t outc;
	bool mix_local_callers;
	int err = 0;

	if (!caller || !af || af->sampc != MS_FRAME_SAMPC)
		return;

	memset(af->sampv, 0, af->sampc * sizeof(int16_t));

	mtx_lock(caller->mutex);
	st = caller->play;
	mix_local_callers = caller->mix_local_callers;

	if (!caller->stopped && st) {
		memset(st->native, 0,
		       st->sampc * aufmt_sample_size((enum aufmt)st->prm.fmt));
		auframe_init(&native_af, (enum aufmt)st->prm.fmt, st->native,
			     st->sampc, st->prm.srate, st->prm.ch);
		if (st->wh)
			st->wh(&native_af, st->arg);

		if (st->prm.fmt == AUFMT_S16LE) {
			memcpy(st->s16, st->native,
			       st->sampc * sizeof(*st->s16));
		}
		else {
			auconv_to_s16(st->s16, (enum aufmt)st->prm.fmt,
				      st->native, st->sampc);
		}

		if (st->prm.srate == MS_SRATE &&
		    st->prm.ch == MS_CHANNELS) {
			memcpy(af->sampv, st->s16,
			       MS_FRAME_SAMPC * sizeof(int16_t));
		}
		else {
			outc = af->sampc;
			err = auresamp(&st->resamp, af->sampv, &outc,
				       st->s16, st->sampc);
			if (err || outc != af->sampc)
				memset(af->sampv, 0,
				       af->sampc * sizeof(int16_t));
		}

	}

	af->timestamp = tmr_jiffies() * 1000;

	/*
	 * The RX mixer's local source is also copied into the TX mixer. This
	 * yields one aggregate producer while RX aumix supplies party-line
	 * mix-minus-self to each co-located caller.
	 */
	if (caller->tx_mix_source)
		(void)aumix_source_put(caller->tx_mix_source,
				       af->sampv, af->sampc);

	if (!mix_local_callers)
		memset(af->sampv, 0, af->sampc * sizeof(int16_t));

	mtx_unlock(caller->mutex);
}


static int caller_alloc(struct ms_caller **callerp, struct ms_context *ctx,
			const char *call_token, bool mix_local_callers)
{
	struct ms_caller *caller;
	int err;

	caller = mem_zalloc(sizeof(*caller), caller_destructor);
	if (!caller)
		return ENOMEM;

	str_ncpy(caller->key, ctx->key, sizeof(caller->key));
	str_ncpy(caller->call_token, call_token, sizeof(caller->call_token));
	caller->mix_local_callers = mix_local_callers;
	err = mutex_alloc(&caller->mutex);
	if (err)
		goto out;

	err = aumix_source_alloc(&caller->tx_mix_source, ctx->tx_mix,
				 NULL, caller);
	if (err)
		goto out;

	err = aumix_source_alloc(&caller->rx_mix_source, ctx->rx_mix,
				 local_output_handler, caller);
	if (err)
		goto out;

	aumix_source_readh(caller->rx_mix_source, local_read_handler);
	aumix_source_enable(caller->tx_mix_source, true);
	aumix_source_enable(caller->rx_mix_source, true);

	*callerp = caller;
	return 0;

out:
	mem_deref(caller);
	return err;
}


static struct ms_caller *caller_find_id_locked(struct ms_context *ctx,
					       const char *call_token)
{
	struct le *le;

	for (le = ctx->callers.head; le; le = le->next) {
		struct ms_caller *caller = le->data;

		if (!str_cmp(caller->call_token, call_token))
			return caller;
	}

	return NULL;
}


static int caller_attach(struct ms_context *ctx, bool source, void *state,
			 const char *call_token,
			 struct ms_caller **callerp)
{
	struct ms_caller *caller = NULL;
	bool mix_local_callers;
	bool new_caller = false;
	int err = 0;

	mtx_lock(ctx->pairing_mutex);

	mtx_lock(ctx->mutex);
	if (ctx->closing) {
		mtx_unlock(ctx->mutex);
		err = ESHUTDOWN;
		goto out;
	}
	mix_local_callers = ctx->mix_local_callers;
	caller = caller_find_id_locked(ctx, call_token);
	if (caller)
		mem_ref(caller);
	mtx_unlock(ctx->mutex);

	if (!caller) {
		err = caller_alloc(&caller, ctx, call_token,
				   mix_local_callers);
		if (err)
			goto out;
		new_caller = true;

		mtx_lock(caller->mutex);
		caller->attached = true;
		mtx_unlock(caller->mutex);

		mtx_lock(ctx->mutex);
		if (ctx->closing) {
			mtx_unlock(ctx->mutex);
			err = ESHUTDOWN;
			goto out;
		}
		list_append(&ctx->callers, &caller->le, caller);
		mtx_unlock(ctx->mutex);
	}

	mtx_lock(caller->mutex);
	if (caller->stopped || !caller->attached) {
		err = ESHUTDOWN;
	}
	else if (source ? caller->src != NULL : caller->play != NULL) {
		err = EALREADY;
	}
	else {
		if (source)
			caller->src = state;
		else
			caller->play = state;
		*callerp = mem_ref(caller);
	}
	mtx_unlock(caller->mutex);

out:
	if (err && new_caller) {
		bool linked;

		mtx_lock(ctx->mutex);
		linked = caller->le.list == &ctx->callers;
		if (linked)
			list_unlink(&caller->le);
		mtx_unlock(ctx->mutex);
		if (linked)
			caller_stop(caller);
	}
	if (caller && (!new_caller || err))
		mem_deref(caller);
	mtx_unlock(ctx->pairing_mutex);
	return err;
}


void ms_context_detach_callers(struct ms_context *ctx)
{
	if (!ctx || !ctx->mutex || !ctx->pairing_mutex)
		return;

	mtx_lock(ctx->pairing_mutex);
	for (;;) {
		struct ms_caller *caller;

		mtx_lock(ctx->mutex);
		if (!ctx->callers.head) {
			mtx_unlock(ctx->mutex);
			break;
		}

		caller = ctx->callers.head->data;
		list_unlink(&caller->le);
		mtx_unlock(ctx->mutex);

		mtx_lock(caller->mutex);
		caller->attached = false;
		mtx_unlock(caller->mutex);
		caller_stop(caller);
		mem_deref(caller); /* context-list ownership */
	}
	mtx_unlock(ctx->pairing_mutex);
}


static void caller_detach_state(struct ms_caller *caller, bool source,
				const void *state)
{
	struct ms_context *ctx;
	bool empty;
	bool removed = false;

	if (!caller)
		return;

	ctx = ms_context_lookup(caller->key);
	if (ctx)
		mtx_lock(ctx->pairing_mutex);

	mtx_lock(caller->mutex);
	if (source) {
		if (caller->src == state)
			caller->src = NULL;
	}
	else if (caller->play == state) {
		caller->play = NULL;
	}
	empty = caller->attached && !caller->src && !caller->play;
	mtx_unlock(caller->mutex);

	if (ctx && empty) {
		mtx_lock(ctx->mutex);
		if (caller->le.list == &ctx->callers) {
			list_unlink(&caller->le);
			removed = true;
		}
		mtx_unlock(ctx->mutex);

		if (removed) {
			mtx_lock(caller->mutex);
			caller->attached = false;
			mtx_unlock(caller->mutex);
		}
	}

	if (ctx)
		mtx_unlock(ctx->pairing_mutex);
	mem_deref(ctx);

	if (removed) {
		caller_stop(caller);
		mem_deref(caller); /* context-list ownership */
	}
}


static void ausrc_destructor(void *arg)
{
	struct ausrc_st *st = arg;
	struct ms_caller *caller = st->caller;

	if (caller) {
		caller_detach_state(caller, true, st);
		st->caller = mem_deref(caller);
	}

	st->s16 = mem_deref(st->s16);
	st->native = mem_deref(st->native);
	if (st->tracked) {
		st->tracked = false;
		device_track(false);
	}
}


static void auplay_destructor(void *arg)
{
	struct auplay_st *st = arg;
	struct ms_caller *caller = st->caller;

	if (caller) {
		caller_detach_state(caller, false, st);
		st->caller = mem_deref(caller);
	}

	st->s16 = mem_deref(st->s16);
	st->native = mem_deref(st->native);
	if (st->tracked) {
		st->tracked = false;
		device_track(false);
	}
}


static int setup_resampler(struct auresamp *resamp, uint32_t input_rate,
			   uint8_t input_ch, uint32_t output_rate,
			   uint8_t output_ch)
{
	auresamp_init(resamp);
	if (input_rate == output_rate && input_ch == output_ch)
		return 0;

	return auresamp_setup(resamp, input_rate, input_ch,
			      output_rate, output_ch);
}


static bool valid_call_token(const char *token)
{
	size_t i;

	if (!token || str_len(token) != MS_CALL_TOKEN_HEX_LEN)
		return false;

	for (i = 0; i < MS_CALL_TOKEN_HEX_LEN; ++i) {
		if (!isxdigit((unsigned char)token[i]))
			return false;
	}

	return true;
}


static int parse_device(char *key, size_t key_size, char *call_token,
			size_t call_token_size, const char *device)
{
	const char *delimiter;
	size_t key_len;
	size_t token_len;

	if (!key || !call_token || !str_isset(device))
		return EINVAL;

	delimiter = strchr(device, '|');
	if (!delimiter || delimiter == device || !delimiter[1] ||
	    strchr(delimiter + 1, '|'))
		return EINVAL;

	key_len = (size_t)(delimiter - device);
	token_len = str_len(delimiter + 1);
	if (key_len >= key_size ||
	    call_token_size <= MS_CALL_TOKEN_HEX_LEN)
		return EOVERFLOW;
	if (token_len != MS_CALL_TOKEN_HEX_LEN)
		return EINVAL;

	memcpy(key, device, key_len);
	key[key_len] = '\0';
	memcpy(call_token, delimiter + 1, token_len);
	call_token[token_len] = '\0';
	if (!ms_valid_identifier(key, key_size) ||
	    !valid_call_token(call_token))
		return EINVAL;

	return 0;
}


static int mediasoup_src_alloc(struct ausrc_st **stp,
			       const struct ausrc *ausrc,
			       struct ausrc_prm *prm, const char *device,
			       ausrc_read_h *rh, ausrc_error_h *errh,
			       void *arg)
{
	struct ms_context *ctx = NULL;
	struct ausrc_st *st;
	char call_token[MS_CALL_TOKEN_SIZE];
	char key[MS_KEY_SIZE];
	size_t native_size;
	int err;
	(void)ausrc;

	if (!stp || !prm || !rh ||
	    !prm->srate || !prm->ch || prm->ch > 2 ||
	    !supported_format(prm->fmt))
		return EINVAL;

	err = parse_device(key, sizeof(key), call_token, sizeof(call_token),
			   device);
	if (err)
		return err;

	st = mem_zalloc(sizeof(*st), ausrc_destructor);
	if (!st)
		return ENOMEM;

	st->prm = *prm;
	st->prm.ptime = MS_PTIME;
	st->rh = rh;
	st->errh = errh;
	st->arg = arg;
	st->sampc = au_calc_nsamp(prm->srate, prm->ch, MS_PTIME);
	st->s16_capacity = MAX(st->sampc, (size_t)MS_FRAME_SAMPC);
	native_size = st->sampc *
		      aufmt_sample_size((enum aufmt)prm->fmt);

	st->s16 = mem_zalloc(st->s16_capacity * sizeof(*st->s16), NULL);
	st->native = mem_zalloc(native_size, NULL);
	if (!st->s16 || !st->native) {
		err = ENOMEM;
		goto out;
	}

	err = setup_resampler(&st->resamp, MS_SRATE, MS_CHANNELS,
			      prm->srate, prm->ch);
	if (err)
		goto out;

	err = ms_context_get_or_create(&ctx, key, NULL);
	if (err)
		goto out;

	err = caller_attach(ctx, true, st, call_token, &st->caller);
	if (err)
		goto out;

	device_track(true);
	st->tracked = true;
	*stp = st;

out:
	mem_deref(ctx);
	if (err)
		mem_deref(st);
	return err;
}


static int mediasoup_play_alloc(struct auplay_st **stp,
				const struct auplay *auplay,
				struct auplay_prm *prm, const char *device,
				auplay_write_h *wh, void *arg)
{
	struct ms_context *ctx = NULL;
	struct auplay_st *st;
	char call_token[MS_CALL_TOKEN_SIZE];
	char key[MS_KEY_SIZE];
	size_t native_size;
	int err;
	(void)auplay;

	if (!stp || !prm || !wh ||
	    !prm->srate || !prm->ch || prm->ch > 2 ||
	    !supported_format(prm->fmt))
		return EINVAL;

	err = parse_device(key, sizeof(key), call_token, sizeof(call_token),
			   device);
	if (err)
		return err;

	st = mem_zalloc(sizeof(*st), auplay_destructor);
	if (!st)
		return ENOMEM;

	st->prm = *prm;
	st->prm.ptime = MS_PTIME;
	st->wh = wh;
	st->arg = arg;
	st->sampc = au_calc_nsamp(prm->srate, prm->ch, MS_PTIME);
	st->s16_capacity = st->sampc;
	native_size = st->sampc *
		      aufmt_sample_size((enum aufmt)prm->fmt);

	st->s16 = mem_zalloc(st->s16_capacity * sizeof(*st->s16), NULL);
	st->native = mem_zalloc(native_size, NULL);
	if (!st->s16 || !st->native) {
		err = ENOMEM;
		goto out;
	}

	err = setup_resampler(&st->resamp, prm->srate, prm->ch,
			      MS_SRATE, MS_CHANNELS);
	if (err)
		goto out;

	err = ms_context_get_or_create(&ctx, key, NULL);
	if (err)
		goto out;

	err = caller_attach(ctx, false, st, call_token, &st->caller);
	if (err)
		goto out;

	device_track(true);
	st->tracked = true;
	*stp = st;

out:
	mem_deref(ctx);
	if (err)
		mem_deref(st);
	return err;
}


int ms_audio_register(void)
{
	int err;

	err = mutex_alloc(&device_mutex);
	if (err)
		return err;

	err = ausrc_register(&mediasoup_ausrc, baresip_ausrcl(), "mediasoup",
			     mediasoup_src_alloc);
	if (err) {
		device_mutex = mem_deref(device_mutex);
		return err;
	}

	err = auplay_register(&mediasoup_auplay, baresip_auplayl(),
			      "mediasoup", mediasoup_play_alloc);
	if (err) {
		mediasoup_ausrc = mem_deref(mediasoup_ausrc);
		device_mutex = mem_deref(device_mutex);
		return err;
	}

	return 0;
}


void ms_audio_unregister(void)
{
	size_t count;

	mediasoup_ausrc = mem_deref(mediasoup_ausrc);
	mediasoup_auplay = mem_deref(mediasoup_auplay);

	count = ms_audio_active_devices();
	if (count) {
		warning("mediasoup_bridge: %zu audio device halves still active; "
			"runtime unload is unsafe and requires restart\n", count);
	}
	else {
		device_mutex = mem_deref(device_mutex);
	}
}
