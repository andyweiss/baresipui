#include <re.h>
#include <baresip.h>
#include <stdio.h>

/**
 * @file rtcpstats_cmd.c RTCP stats command module
 * Provides RTCP statistics via getrtcpstats command
 * Audio streams only, provides RTCP/RTP metrics
 */

struct rtcpstats_call {
	struct le le;	
	struct call *call;
	uint32_t last_rx_packets;  /* Track packet loss detection */
	uint32_t last_tx_packets;
	uint32_t last_rx_bytes;
	uint32_t last_tx_bytes;
	uint64_t dropout_counter;  /* Count drops */
	time_t call_start_time;
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
			warning("rtcpstats_periodic: mem_zalloc failed\n");
			return;
		}

		rc->call = call;
		list_append(&calll, &rc->le, rc);
		info("rtcpstats_periodic: tracking call %s for getrtcpstats command\n", call_id(call));
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
	struct mbuf *json_buf;
	int first = 1;
	int count = 0;
	
	/* Create buffer for JSON array */
	json_buf = mbuf_alloc(8192);
	if (!json_buf) {
		return ENOMEM;
	}
	
	/* Build JSON array of call stats */
	mbuf_printf(json_buf, "[");
	
	/* Iterate through all active calls and build their stats */
	for (le = calll.head; le; le = le->next) {
		rc = le->data;
		const struct stream *s;
		struct le *sle;
		
		for (sle = call_streaml(rc->call)->head; sle; sle = sle->next) {
			s = sle->data;
			
			/* Only process audio streams */
			if (stream_type(s) != 0) continue;
			if (!stream_is_ready(s)) continue;
			
			const struct rtcp_stats *rtcp = stream_rtcp_stats(s);
			if (!rtcp) continue;
			
			uint32_t rx_packets = stream_metric_get_rx_n_packets(s);
			uint32_t tx_packets = stream_metric_get_tx_n_packets(s);
			uint32_t rx_bytes = stream_metric_get_rx_n_bytes(s);
			uint32_t tx_bytes = stream_metric_get_tx_n_bytes(s);
			uint32_t rx_errors = stream_metric_get_rx_n_err(s);
			uint32_t tx_errors = stream_metric_get_tx_n_err(s);
			
			uint32_t rx_diff = rx_packets - rc->last_rx_packets;
			int rx_dropout = 0;
			if (rc->last_rx_packets > 0 && rx_diff == 0 && rtcp->rx.lost > 0) {
				rx_dropout = 1;
				rc->dropout_counter++;
			}
			
			uint32_t rx_bitrate_kbps = (rx_diff > 0) ? (rx_diff * 8 / 2) / 1000 : 0;
			uint32_t tx_bitrate_kbps = (tx_packets - rc->last_tx_packets) > 0 ? ((tx_packets - rc->last_tx_packets) * 8 / 2) / 1000 : 0;
			
			if (!first) mbuf_printf(json_buf, ",");
			first = 0;
			count++;
			
			mbuf_printf(json_buf, "{\"call_id\":\"%s\",\"rtp_rx_packets\":%u,\"rtp_tx_packets\":%u,\"rx_bitrate_kbps\":%u,\"tx_bitrate_kbps\":%u,\"rtcp_lost_rx\":%d,\"rtcp_lost_tx\":%d,\"rtcp_jitter_rx_ms\":%.1f,\"rtcp_jitter_tx_ms\":%.1f,\"rx_dropout\":%s,\"rx_dropout_total\":%llu}",
				call_id(rc->call),
				rx_packets, tx_packets,
				rx_bitrate_kbps, tx_bitrate_kbps,
				rtcp->rx.lost,
				rtcp->tx.lost,
				1.0 * rtcp->rx.jit/1000,
				1.0 * rtcp->tx.jit/1000,
				rx_dropout ? "true" : "false", rc->dropout_counter);
			
			/* Update tracking for next iteration */
			rc->last_rx_packets = rx_packets;
			rc->last_tx_packets = tx_packets;
		}
	}
	
	mbuf_printf(json_buf, "]");
	
	/* Send as baresip response format: {"response":true,"ok":true,"data":"..."} */
	if (json_buf->end > 0) {
		re_hprintf(pf, "{\"response\":true,\"ok\":true,\"data\":\"%b\"}", 
			   json_buf->buf, json_buf->end);
		info("🔧 cmd_getrtcpstats: sent %d call stats", count);
	} else {
		re_hprintf(pf, "{\"response\":true,\"ok\":true,\"data\":\"[]\"}");
		info("🔧 cmd_getrtcpstats: no active calls");
	}
	
	mem_deref(json_buf);
	return 0;
}

static const struct cmd cmdv[] = {
	{"getrtcpstats", 0, 0, "Get RTCP statistics for all active calls (no params)", cmd_getrtcpstats },
};

static int module_init(void)
{
	int err = 0;
	info("🔧 rtcpstats_periodic module_init called\n");
	
	err = cmd_register(baresip_commands(), cmdv, RE_ARRAY_SIZE(cmdv));
	if (err) {
		warning("🔴 cmd_register failed: %d\n", err);
		return err;
	}
	
	info("✓ getrtcpstats command registered successfully\n");
	bevent_register(event_handler, NULL);
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
