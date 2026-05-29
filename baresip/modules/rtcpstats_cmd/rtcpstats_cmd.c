#include <re.h>
#include <baresip.h>

/**
 * @file rtcpstats_cmd.c RTCP stats command module
 * Provides RTCP statistics via getrtcpstats command.
 * Audio streams only. Output is a JSON array wrapped by ctrl_tcp.
 */

struct rtcpstats_call {
	struct le le;
	struct call *call;
	uint32_t last_rx_packets;  /* for dropout detection */
	uint32_t last_rx_bytes;
	uint32_t last_tx_bytes;
	uint64_t last_query_time;  /* ms, from tmr_jiffies() */
	uint64_t dropout_counter;
};

static struct list calll = LIST_INIT;

static void call_destructor(void *arg)
{
	struct rtcpstats_call *rc = arg;
	list_unlink(&rc->le);
}

static void event_handler(enum bevent_ev ev, struct bevent *event, void *arg)
{
	struct call *call = bevent_get_call(event);
	struct rtcpstats_call *rc;
	(void)arg;

	switch (ev) {

	case BEVENT_CALL_ESTABLISHED:
		/* Create tracking entry for this call */
		rc = mem_zalloc(sizeof(*rc), call_destructor);
		if (!rc) {
			warning("rtcpstats_cmd: mem_zalloc failed\n");
			return;
		}

		rc->call = call;
		list_append(&calll, &rc->le, rc);
		info("rtcpstats_cmd: tracking call %s\n", call_id(call));
		break;

	case BEVENT_CALL_CLOSED:
		/* Find and remove this call's stats tracker */
		{
			struct le *le;
			for (le = calll.head; le;) {
				rc = le->data;
				le = le->next;
				
				if (rc->call == call) {
					mem_deref(rc);
					break;
				}
			}
		}
		break;

	default:
		break;
	}
}

static int cmd_getrtcpstats(struct re_printf *pf, void *arg)
{
	(void)arg;

	struct le *le;
	struct rtcpstats_call *rc;
	int first = 1;
	uint64_t now = tmr_jiffies();

	/*
	 * Output a JSON array directly.  ctrl_tcp wraps it in
	 * {"response":true,"ok":true,"data":"<escaped>"} automatically,
	 * so we must NOT add our own wrapper here.
	 */
	re_hprintf(pf, "[");

	for (le = calll.head; le; le = le->next) {
		rc = le->data;
		const struct stream *s;
		struct le *sle;

		for (sle = call_streaml(rc->call)->head; sle; sle = sle->next) {
			s = sle->data;

			/* Audio streams only */
			if (stream_type(s) != 0) continue;
			if (!stream_is_ready(s)) continue;

			const struct rtcp_stats *rtcp = stream_rtcp_stats(s);
			if (!rtcp) continue;

			/* Audio jitter buffer delay (aubuf in audio module) */
			uint64_t audio_jb_ms = 0;
			struct audio *au = call_audio(rc->call);
			if (au)
				audio_jb_ms = audio_jb_current_value(au);

			uint32_t rx_packets = stream_metric_get_rx_n_packets(s);
			uint32_t tx_packets = stream_metric_get_tx_n_packets(s);
			uint32_t rx_bytes   = stream_metric_get_rx_n_bytes(s);
			uint32_t tx_bytes   = stream_metric_get_tx_n_bytes(s);
			uint32_t rx_errors  = stream_metric_get_rx_n_err(s);
			uint32_t tx_errors  = stream_metric_get_tx_n_err(s);

			/* Dropout detection: no new RX packets while RTCP reports loss */
			uint32_t rx_pkt_diff = rx_packets - rc->last_rx_packets;
			int rx_dropout = 0;
			if (rc->last_rx_packets > 0 && rx_pkt_diff == 0
			    && rtcp->rx.lost > 0) {
				rx_dropout = 1;
				rc->dropout_counter++;
			}

			/* Bitrate: delta_bytes * 8 / delta_ms  = kbit/s */
			uint32_t rx_bitrate_kbps = 0;
			uint32_t tx_bitrate_kbps = 0;
			if (rc->last_query_time > 0 && now > rc->last_query_time) {
				uint64_t dt = now - rc->last_query_time;
				rx_bitrate_kbps = (uint32_t)(
					((uint64_t)(rx_bytes - rc->last_rx_bytes) * 8) / dt);
				tx_bitrate_kbps = (uint32_t)(
					((uint64_t)(tx_bytes - rc->last_tx_bytes) * 8) / dt);
			}

			if (!first) re_hprintf(pf, ",");
			first = 0;

			re_hprintf(pf,
				"{"
				"\"call_id\":\"%s\","
				"\"rtp_rx_packets\":%u,"
				"\"rtp_tx_packets\":%u,"
				"\"rx_bitrate_kbps\":%u,"
				"\"tx_bitrate_kbps\":%u,"
				"\"rtcp_lost_rx\":%d,"
				"\"rtcp_lost_tx\":%d,"
				"\"rtcp_jitter_rx_us\":%u,"
				"\"rtcp_jitter_tx_us\":%u,"
				"\"rtcp_rtt_us\":%u,"
				"\"rtcp_jitter_rx_ms\":%.1f,"
				"\"rtcp_jitter_tx_ms\":%.1f,"
				"\"rtcp_rtt_ms\":%.1f,"
				"\"rtp_rx_errors\":%u,"
				"\"rtp_tx_errors\":%u,"
				"\"rx_dropout\":%s,"
				"\"rx_dropout_total\":%llu,"
				"\"jbuf_delay_ms\":%llu",
				call_id(rc->call),
				rx_packets, tx_packets,
				rx_bitrate_kbps, tx_bitrate_kbps,
				rtcp->rx.lost, rtcp->tx.lost,
				rtcp->rx.jit, rtcp->tx.jit, rtcp->rtt,
				1.0 * rtcp->rx.jit / 1000,
				1.0 * rtcp->tx.jit / 1000,
				1.0 * rtcp->rtt / 1000,
				rx_errors, tx_errors,
				rx_dropout ? "true" : "false",
				(unsigned long long)rc->dropout_counter,
				(unsigned long long)audio_jb_ms);

			re_hprintf(pf, "}");

			/* Update tracking for next query */
			rc->last_rx_packets = rx_packets;
			rc->last_rx_bytes   = rx_bytes;
			rc->last_tx_bytes   = tx_bytes;
			rc->last_query_time = now;
		}
	}

	re_hprintf(pf, "]");

	return 0;
}

static const struct cmd cmdv[] = {
	{"getrtcpstats", 0, 0, "Get RTCP statistics for all active calls", cmd_getrtcpstats },
};

static int module_init(void)
{
	int err;

	err = cmd_register(baresip_commands(), cmdv, RE_ARRAY_SIZE(cmdv));
	if (err) {
		warning("rtcpstats_cmd: cmd_register failed: %d\n", err);
		return err;
	}

	bevent_register(event_handler, NULL);
	info("rtcpstats_cmd: module loaded, getrtcpstats command registered\n");
	return 0;
}

static int module_close(void)
{
	struct le *le;
	
	cmd_unregister(baresip_commands(), cmdv);
	bevent_unregister(event_handler);
	/* Clean up all active call trackers */
	le = calll.head;
	while (le) {
		struct rtcpstats_call *rc = le->data;
		le = le->next;
		mem_deref(rc);
	}
	return 0;
}

EXPORT_SYM const struct mod_export DECL_EXPORTS(rtcpstats_cmd) = {
	"rtcpstats_cmd",
	"application",
	module_init,
	module_close,
};
