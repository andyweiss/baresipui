/**
 * @file rtp.c Fixed-port RTP transport, jitter buffering and Opus RX
 */

#include <string.h>

#include "mediasoup_bridge.h"


static const uint8_t rtcp_rr_probe[] = {
	0x80, 0xc9, 0x00, 0x01, 0x54, 0x41, 0x4c, 0x4b
};


int ms_port_pool_init(uint16_t first, uint16_t last)
{
	uint32_t normalized = first;
	int err;

	memset(&ms_port_pool, 0, sizeof(ms_port_pool));

	if (normalized & 1)
		++normalized;
	if (normalized > last || normalized > UINT16_MAX)
		return EINVAL;
	first = (uint16_t)normalized;

	ms_port_pool.first = first;
	ms_port_pool.last = last;
	ms_port_pool.count = ((size_t)last - first) / 2 + 1;

	err = mutex_alloc(&ms_port_pool.mutex);
	if (err)
		return err;

	ms_port_pool.used = mem_zalloc(ms_port_pool.count *
				      sizeof(*ms_port_pool.used), NULL);
	if (!ms_port_pool.used) {
		ms_port_pool.mutex = mem_deref(ms_port_pool.mutex);
		return ENOMEM;
	}

	return 0;
}


void ms_port_pool_close(void)
{
	ms_port_pool.used = mem_deref(ms_port_pool.used);
	ms_port_pool.mutex = mem_deref(ms_port_pool.mutex);
	ms_port_pool.count = 0;
}


size_t ms_port_pool_used(void)
{
	size_t count = 0;
	size_t i;

	if (!ms_port_pool.mutex)
		return 0;

	mtx_lock(ms_port_pool.mutex);
	for (i = 0; i < ms_port_pool.count; ++i) {
		if (ms_port_pool.used[i])
			++count;
	}
	mtx_unlock(ms_port_pool.mutex);

	return count;
}


int ms_rtp_socket_alloc(struct rtp_sock **rtpp, size_t *pool_index,
			uint16_t *port, rtp_recv_h *recvh, void *arg)
{
	bool free_slot = false;
	size_t i;
	int bind_err = EADDRINUSE;

	if (!rtpp || !pool_index || !port || !recvh ||
	    !ms_port_pool.mutex)
		return EINVAL;

	mtx_lock(ms_port_pool.mutex);
	for (i = 0; i < ms_port_pool.count; ++i) {
		struct rtp_sock *rtp = NULL;
		const uint16_t candidate =
			(uint16_t)(ms_port_pool.first + i * 2);

		if (ms_port_pool.used[i])
			continue;

		free_slot = true;
		bind_err = rtp_listen_single(&rtp, &ms_bind_addr, candidate,
					     recvh, arg);
		if (bind_err)
			continue;

		rtcp_enable_mux(rtp, true);
		ms_port_pool.used[i] = true;
		*rtpp = rtp;
		*pool_index = i;
		*port = candidate;
		mtx_unlock(ms_port_pool.mutex);
		return 0;
	}
	mtx_unlock(ms_port_pool.mutex);

	/* ENOSPC means bookkeeping is full; bind errors remain distinguishable. */
	return free_slot ? bind_err : ENOSPC;
}


int ms_rtp_socket_alloc_ephemeral(struct rtp_sock **rtpp, uint16_t *port,
				  rtp_recv_h *recvh, void *arg)
{
	unsigned attempt;

	if (!rtpp || !port || !recvh)
		return EINVAL;

	for (attempt = 0; attempt < 32; ++attempt) {
		struct rtp_sock *rtp = NULL;
		struct sa local;
		uint16_t local_port;
		bool receive_slot;
		int err;

		err = rtp_listen_single(&rtp, &ms_bind_addr, 0, recvh, arg);
		if (err)
			return err;

		rtcp_enable_mux(rtp, true);
		err = udp_local_get(rtp_sock(rtp), &local);
		if (err) {
			mem_deref(rtp);
			return err;
		}
		local_port = sa_port(&local);
		if (!local_port) {
			mem_deref(rtp);
			return EADDRNOTAVAIL;
		}

		receive_slot = local_port >= ms_port_pool.first &&
			       local_port <= ms_port_pool.last &&
			       !((local_port - ms_port_pool.first) & 1);
		if (receive_slot) {
			mem_deref(rtp);
			continue;
		}

		*rtpp = rtp;
		*port = local_port;
		return 0;
	}

	return EADDRINUSE;
}


void ms_rtp_socket_release(struct rtp_sock **rtpp, size_t *pool_index)
{
	if (!rtpp || !pool_index)
		return;

	if (ms_port_pool.mutex)
		mtx_lock(ms_port_pool.mutex);

	*rtpp = mem_deref(*rtpp);
	if (*pool_index != MS_PORT_NONE &&
	    *pool_index < ms_port_pool.count && ms_port_pool.used)
		ms_port_pool.used[*pool_index] = false;
	*pool_index = MS_PORT_NONE;

	if (ms_port_pool.mutex)
		mtx_unlock(ms_port_pool.mutex);
}


int ms_send_probe(struct rtp_sock *rtp, const struct sa *remote,
		  unsigned count)
{
	struct mbuf *mb;
	unsigned i;
	int err = 0;

	if (!rtp || !remote || !count)
		return EINVAL;

	mb = mbuf_alloc(sizeof(rtcp_rr_probe));
	if (!mb)
		return ENOMEM;

	err = mbuf_write_mem(mb, rtcp_rr_probe, sizeof(rtcp_rr_probe));
	if (err)
		goto out;

	for (i = 0; i < count; ++i) {
		mb->pos = 0;
		err = udp_send(rtp_sock(rtp), remote, mb);
		if (err)
			break;
		if (i + 1 < count)
			sys_msleep(MS_PROBE_INTERVAL_MS);
	}

out:
	mem_deref(mb);
	return err;
}


static void source_media_reset(struct ms_source *src)
{
	if (!src)
		return;

	tmr_cancel(&src->decode_tmr);
	src->active = false;
	src->decode_started = false;
	src->seq_set = false;
	src->latched_ssrc = 0;
	if (src->mix_source)
		aumix_source_enable(src->mix_source, false);
	src->mix_source = mem_deref(src->mix_source);
	src->jbuf = mem_deref(src->jbuf);
	src->decode_buf = mem_deref(src->decode_buf);
	if (src->decoder) {
		opus_decoder_destroy(src->decoder);
		src->decoder = NULL;
	}
}


static void source_destructor(void *arg)
{
	struct ms_source *src = arg;

	list_unlink(&src->le);
	source_media_reset(src);
	ms_rtp_socket_release(&src->rtp, &src->pool_index);
}


static void source_put_pcm(struct ms_source *src, size_t sampc)
{
	if (!src || !src->mix_source || !sampc)
		return;

	src->level_dbfs = ms_level_dbfs(src->decode_buf, sampc);
	(void)aumix_source_put(src->mix_source, src->decode_buf, sampc);
}


static int source_decode_plc(struct ms_source *src, unsigned count,
			     bool playout)
{
	unsigned i;

	count = MIN(count, 3U);
	for (i = 0; i < count; ++i) {
		int n = opus_decode(src->decoder, NULL, 0, src->decode_buf,
				    MS_FRAME_SAMP_PER_CH, 0);
		if (n < 0) {
			++src->decode_errors;
			ms_context_error(src->ctx, "opus-plc-failed", EPROTO);
			return EPROTO;
		}

		++src->plc_frames;
		/*
		 * Emit at most one 20 ms frame at this playout instant.  Sending
		 * every PLC frame followed by the real frame makes aumix queue
		 * stale audio and causes latency to grow after each gap.
		 */
		if (playout && i + 1 == count)
			source_put_pcm(src, (size_t)n * MS_CHANNELS);
	}

	return 0;
}


static void source_decode_packet(struct ms_source *src,
				 const struct rtp_header *hdr,
				 struct mbuf *mb, bool playout)
{
	bool concealed = false;
	uint16_t delta;
	int n;

	if (src->seq_set) {
		delta = (uint16_t)(hdr->seq - src->last_seq);
		if (delta > 1 && delta < 0x8000) {
			const unsigned lost = (unsigned)delta - 1;
			src->rx_lost += lost;
			if (lost <= 3) {
				if (source_decode_plc(src, lost, playout))
					return;
				concealed = true;
			}
			else {
				/*
				 * A long discontinuity is not recoverable in real
				 * time.  Reset Opus and resume at the current packet
				 * instead of manufacturing a delayed PLC backlog.
				 */
				(void)opus_decoder_ctl(src->decoder,
						       OPUS_RESET_STATE);
				aumix_source_flush(src->mix_source);
			}
		}
	}

	src->last_seq = hdr->seq;
	src->seq_set = true;

	n = opus_decode(src->decoder, mbuf_buf(mb),
			(opus_int32)mbuf_get_left(mb), src->decode_buf,
			MS_OPUS_MAX_FRAME, 0);
	if (n < 0) {
		++src->decode_errors;
		ms_context_error(src->ctx, "opus-decode-failed", EPROTO);
		return;
	}

	/* The real frame advances decoder state; PLC replaced its playout slot. */
	if (playout && !concealed)
		source_put_pcm(src, (size_t)n * MS_CHANNELS);
}


static void source_decode_handler(void *arg)
{
	struct ms_source *src = arg;
	uint32_t pending = 1;
	int32_t delay;

	if (!src || !src->active || !src->jbuf)
		return;

	do {
		struct rtp_header hdr;
		void *packet = NULL;
		int err;

		err = jbuf_get(src->jbuf, &hdr, &packet);
		if (err == EAGAIN)
			++pending;
		else if (err)
			break;

		/* EAGAIN means another stale packet is immediately due: decode it
		 * for codec state, but only play the newest due frame.
		 */
		source_decode_packet(src, &hdr, packet, err != EAGAIN);
		mem_deref(packet);
	} while (--pending);

	delay = jbuf_next_play(src->jbuf);
	if (delay < 0)
		delay = 10;
	tmr_start(&src->decode_tmr, (uint64_t)delay,
		  source_decode_handler, src);
}


static void source_rtp_handler(const struct sa *peer,
			       const struct rtp_header *header,
			       struct mbuf *mb, void *arg)
{
	struct ms_source *src = arg;
	struct rtp_header hdr;
	size_t payload_len;
	int err;

	if (!src || !src->active || !src->jbuf || !src->decoder)
		return;

	if (!sa_cmp(peer, &src->remote, SA_ALL) || header->pt != src->pt) {
		++src->rx_invalid;
		return;
	}

	if (src->expected_ssrc && header->ssrc != src->expected_ssrc) {
		++src->rx_invalid;
		return;
	}

	if (!src->latched_ssrc)
		src->latched_ssrc = header->ssrc;
	else if (header->ssrc != src->latched_ssrc) {
		++src->rx_invalid;
		return;
	}

	payload_len = mbuf_get_left(mb);
	if (header->pad) {
		uint8_t padding;

		if (!payload_len) {
			++src->rx_invalid;
			return;
		}
		padding = mbuf_buf(mb)[payload_len - 1];
		if (!padding || padding >= payload_len) {
			++src->rx_invalid;
			return;
		}
		mbuf_set_end(mb, mbuf_end(mb) - padding);
		payload_len -= padding;
	}
	if (!payload_len) {
		++src->rx_invalid;
		return;
	}

	hdr = *header;
	hdr.ts_arrive = tmr_jiffies() * (MS_SRATE / 1000);

	err = jbuf_put(src->jbuf, &hdr, mb);
	if (err) {
		++src->rx_invalid;
		return;
	}

	++src->rx_packets;
	src->rx_bytes += payload_len;
	src->last_rx_ms = tmr_jiffies();

	if (!src->decode_started) {
		src->decode_started = true;
		tmr_start(&src->decode_tmr, 0, source_decode_handler, src);
	}
}


struct ms_source *ms_source_find(struct ms_context *ctx,
				 const char *producer_id)
{
	struct le *le;

	if (!ctx || !producer_id)
		return NULL;

	for (le = ctx->sources.head; le; le = le->next) {
		struct ms_source *src = le->data;

		if (!str_cmp(src->producer_id, producer_id))
			return src;
	}

	return NULL;
}


int ms_source_reserve(struct ms_context *ctx, const char *producer_id,
		      struct ms_source **srcp, bool *created)
{
	struct ms_source *src;
	int err;

	if (!ctx || !srcp ||
	    !ms_valid_identifier(producer_id, MS_PRODUCER_SIZE))
		return EINVAL;

	mtx_lock(ctx->mutex);
	if (ctx->closing) {
		mtx_unlock(ctx->mutex);
		return ESHUTDOWN;
	}

	src = ms_source_find(ctx, producer_id);
	if (src) {
		*srcp = mem_ref(src);
		if (created)
			*created = false;
		mtx_unlock(ctx->mutex);
		return 0;
	}

	src = mem_zalloc(sizeof(*src), source_destructor);
	if (!src) {
		mtx_unlock(ctx->mutex);
		return ENOMEM;
	}

	src->ctx = ctx;
	src->pool_index = MS_PORT_NONE;
	src->level_dbfs = MS_DBFS_FLOOR;
	str_ncpy(src->producer_id, producer_id, sizeof(src->producer_id));

	err = ms_rtp_socket_alloc(&src->rtp, &src->pool_index,
				  &src->local_port, source_rtp_handler, src);
	if (err) {
		mtx_unlock(ctx->mutex);
		mem_deref(src);
		ms_context_error(ctx, err == ENOSPC
				      ? "port-range-exhausted"
				      : "rtp-bind-failed", err);
		return err;
	}

	list_append(&ctx->sources, &src->le, src);
	*srcp = mem_ref(src);
	if (created)
		*created = true;
	mtx_unlock(ctx->mutex);

	return 0;
}


int ms_source_activate(struct ms_source *src, const struct sa *remote,
		       uint8_t pt, uint32_t ssrc, bool *changed)
{
	struct ms_context *ctx;
	struct aumix_source *mix_source = NULL;
	struct aumix_source *old_mix_source = NULL;
	struct jbuf *jbuf = NULL;
	struct jbuf *old_jbuf = NULL;
	OpusDecoder *decoder = NULL;
	OpusDecoder *old_decoder = NULL;
	int16_t *decode_buf = NULL;
	int16_t *old_decode_buf = NULL;
	bool mix_enabled = false;
	bool same;
	int opus_err;
	int err;

	if (!src || !remote || pt > 127)
		return EINVAL;
	if (sa_af(remote) != sa_af(&ms_bind_addr))
		return EAFNOSUPPORT;

	ctx = src->ctx;
	mtx_lock(ctx->mutex);
	if (ctx->closing || src->le.list != &ctx->sources) {
		mtx_unlock(ctx->mutex);
		return ESHUTDOWN;
	}
	same = src->active && src->pt == pt &&
	       src->expected_ssrc == ssrc &&
	       sa_cmp(&src->remote, remote, SA_ALL);
	mtx_unlock(ctx->mutex);

	if (same) {
		err = ms_send_probe(src->rtp, remote, 3);
		if (err) {
			ms_context_error(ctx, "rx-probe-failed", err);
			return err;
		}

		mtx_lock(ctx->mutex);
		if (ctx->closing || src->le.list != &ctx->sources) {
			mtx_unlock(ctx->mutex);
			return ESHUTDOWN;
		}
		if (src->active && src->pt == pt &&
		    src->expected_ssrc == ssrc &&
		    sa_cmp(&src->remote, remote, SA_ALL)) {
			src->last_probe_ms = tmr_jiffies();
			if (changed)
				*changed = false;
			mtx_unlock(ctx->mutex);
			return 0;
		}
		mtx_unlock(ctx->mutex);

		/* A concurrent reconfiguration won; let the caller retry. */
		return EAGAIN;
	}

	err = ms_send_probe(src->rtp, remote, 3);
	if (err) {
		ms_context_error(src->ctx, "rx-probe-failed", err);
		return err;
	}

	decoder = opus_decoder_create(MS_SRATE, MS_CHANNELS, &opus_err);
	if (!decoder)
		return opus_err == OPUS_ALLOC_FAIL ? ENOMEM : EPROTO;

	decode_buf = mem_zalloc(MS_OPUS_MAX_FRAME * MS_CHANNELS *
			       sizeof(*decode_buf), NULL);
	if (!decode_buf) {
		err = ENOMEM;
		goto out;
	}

	err = jbuf_alloc(&jbuf, 40, 200, 50);
	if (err)
		goto out;
	jbuf_set_srate(jbuf, MS_SRATE);

	err = aumix_source_alloc(&mix_source, ctx->rx_mix, NULL, src);
	if (err)
		goto out;
	aumix_source_enable(mix_source, true);
	mix_enabled = true;

	mtx_lock(ctx->mutex);
	if (ctx->closing || src->le.list != &ctx->sources) {
		mtx_unlock(ctx->mutex);
		err = ESHUTDOWN;
		goto out;
	}

	tmr_cancel(&src->decode_tmr);
	src->active = false;
	src->decode_started = false;
	src->seq_set = false;
	src->latched_ssrc = 0;
	old_decoder = src->decoder;
	old_decode_buf = src->decode_buf;
	old_jbuf = src->jbuf;
	old_mix_source = src->mix_source;
	src->decoder = decoder;
	decoder = NULL;
	src->decode_buf = decode_buf;
	decode_buf = NULL;
	src->jbuf = jbuf;
	jbuf = NULL;
	src->mix_source = mix_source;
	mix_source = NULL;
	mix_enabled = false;
	src->remote = *remote;
	src->pt = pt;
	src->expected_ssrc = ssrc;
	src->level_dbfs = MS_DBFS_FLOOR;
	src->active = true;
	src->last_probe_ms = tmr_jiffies();
	mtx_unlock(ctx->mutex);

	if (old_mix_source)
		aumix_source_enable(old_mix_source, false);
	mem_deref(old_mix_source);
	mem_deref(old_jbuf);
	mem_deref(old_decode_buf);
	if (old_decoder)
		opus_decoder_destroy(old_decoder);

	if (changed)
		*changed = true;

out:
	if (mix_enabled)
		aumix_source_enable(mix_source, false);
	mem_deref(mix_source);
	mem_deref(jbuf);
	mem_deref(decode_buf);
	if (decoder)
		opus_decoder_destroy(decoder);
	return err;
}


int ms_source_remove(struct ms_context *ctx, const char *producer_id,
		     bool *changed)
{
	struct ms_source *src;

	if (!ctx || !ms_valid_identifier(producer_id, MS_PRODUCER_SIZE))
		return EINVAL;

	mtx_lock(ctx->mutex);
	src = ms_source_find(ctx, producer_id);
	if (!src) {
		mtx_unlock(ctx->mutex);
		if (changed)
			*changed = false;
		return 0;
	}

	list_unlink(&src->le);
	mtx_unlock(ctx->mutex);
	mem_deref(src);

	if (changed)
		*changed = true;
	return 0;
}


void ms_source_keepalive(struct ms_source *src, uint64_t now)
{
	struct ms_context *ctx;
	struct rtp_sock *rtp;
	struct sa remote;
	int err;

	if (!src)
		return;

	ctx = src->ctx;
	mtx_lock(ctx->mutex);
	if (ctx->closing || src->le.list != &ctx->sources || !src->active ||
	    now - src->last_probe_ms < MS_KEEPALIVE_MS) {
		mtx_unlock(ctx->mutex);
		return;
	}

	src->last_probe_ms = now;
	rtp = mem_ref(src->rtp);
	remote = src->remote;
	mtx_unlock(ctx->mutex);

	err = ms_send_probe(rtp, &remote, 1);
	mem_deref(rtp);
	if (err)
		ms_context_error(ctx, "rx-keepalive-failed", err);
}
