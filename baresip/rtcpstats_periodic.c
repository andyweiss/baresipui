#include <re.h>
#include <baresip.h>

/**
 * @file rtcpstats_periodic.c Periodic RTCP stats module
 * Output RTCP stats every 2 seconds during active calls
 * Audio streams only, provides RTCP/RTP metrics and jitter buffer info
 *
 * Modified from original rtcpsummary.c
 */

struct rtcpstats_call {
	struct le le;	
	struct call *call;
	struct tmr tmr;
	char peer_uri[256];  /* Store peer URI for stats correlation */
};

static struct list calll = LIST_INIT;

static void print_rtcp_stats_line(const struct call *call, const struct stream *s, const char *peer_uri)
{
	const struct rtcp_stats *rtcp;
	rtcp = stream_rtcp_stats(s);

	if (!rtcp) {
		info("RTCP_STATS: waiting for RTCP - call %s (peer=%s), stream %s\n", call_id(call), peer_uri, sdp_media_name(stream_sdpmedia(s)));
		return;
	}
	
	/* Get RTP metrics for packets/bytes */
	uint32_t rx_packets = stream_metric_get_rx_n_packets(s);
	uint32_t tx_packets = stream_metric_get_tx_n_packets(s);
	uint32_t rx_bytes = stream_metric_get_rx_n_bytes(s);
	uint32_t tx_bytes = stream_metric_get_tx_n_bytes(s);
	uint32_t rx_errors = stream_metric_get_rx_n_err(s);
	uint32_t tx_errors = stream_metric_get_tx_n_err(s);
	
	/* Try to get jitter buffer stats (may not be available in all builds) */
	int jbuf_available = (stream_jbuf_stats(s, NULL) == 0) ? 1 : 0;
	
	info("RTCP_STATS: "
		 "call_id=%s;"
		 "peer_uri=%s;"
		 "media=%s;"
		 "rtcp_rx_packets=%u;"
		 "rtcp_tx_packets=%u;"
		 "rtcp_lost_rx=%d;"
		 "rtcp_lost_tx=%d;"
		 "rtcp_jitter_rx=%.1f;"
		 "rtcp_jitter_tx=%.1f;"
		 "rtcp_rtt=%.1f;"
		 "rtp_rx_packets=%u;"
		 "rtp_tx_packets=%u;"
		 "rtp_rx_bytes=%u;"
		 "rtp_tx_bytes=%u;"
		 "rtp_rx_errors=%u;"
		 "rtp_tx_errors=%u;"
		 "jbuf_available=%s;"
		 "\n",
		 call_id(call),
		 peer_uri,
		 sdp_media_name(stream_sdpmedia(s)),
		 rtcp->rx.sent,
		 rtcp->tx.sent,
		 rtcp->rx.lost,
		 rtcp->tx.lost,
		 1.0 * rtcp->rx.jit/1000,
		 1.0 * rtcp->tx.jit/1000,
		 1.0 * rtcp->rtt/1000,
		 rx_packets, tx_packets, rx_bytes, tx_bytes,
		 rx_errors, tx_errors,
		 jbuf_available ? "yes" : "no");
}

static void tmr_handler(void *arg)
{
	struct rtcpstats_call *rc = arg;
	const struct stream *s;
	struct le *le;
	
	/* Print stats only for audio streams */
	for (le = call_streaml(rc->call)->head; le; le = le->next) {
		s = le->data;
		
		/* Only process audio streams (type 0 = audio, type 1 = video) */
		if (stream_type(s) != 0) {
			continue;  /* Skip video */
		}
		
		/* Check if stream is ready */
		if (!stream_is_ready(s)) {
			continue;
		}
		
		print_rtcp_stats_line(rc->call, s, rc->peer_uri);
	}
	
	/* Re-arm timer for next interval */
	tmr_start(&rc->tmr, 2000, tmr_handler, rc);
}

static void call_destructor(void *arg)
{
	struct rtcpstats_call *rc = arg;
	tmr_cancel(&rc->tmr);
	list_unlink(&rc->le);
}

static void event_handler(enum bevent_ev ev, struct bevent *event, void *arg)
{
	struct call *call = bevent_get_call(event);
	struct rtcpstats_call *rc;
	(void)arg;

	switch (ev) {

	case BEVENT_CALL_ESTABLISHED:
		/* Start periodic stats output */
		rc = mem_zalloc(sizeof(*rc), call_destructor);
		if (!rc) {
			warning("rtcpstats_periodic: mem_zalloc failed\n");
			return;
		}

		rc->call = call;
		/* Store peer URI for stats tracking */
		str_ncpy(rc->peer_uri, call_peer_uri(call), sizeof(rc->peer_uri));
		list_append(&calll, &rc->le, rc);
		
		/* Initialize and start timer - wait 5 seconds for RTCP to establish */
		tmr_init(&rc->tmr);
		tmr_start(&rc->tmr, 5000, tmr_handler, rc);
		info("rtcpstats_periodic: started for call %s (peer=%s), first timer in 5s\n", call_id(call), rc->peer_uri);
		break;

	case BEVENT_CALL_CLOSED:
		/* Find and remove this call's stats tracker */
		{
			struct le *le;
			for (le = calll.head; le;) {
				rc = le->data;
				le = le->next;
				
				if (rc->call == call) {
					/* Print final stats on call close */
					const struct stream *s;
					struct le *sle;
					for (sle = call_streaml(call)->head; sle; sle = sle->next) {
						s = sle->data;
						if (stream_type(s) == 0) {  /* Audio only */
							print_rtcp_stats_line(call, s, rc->peer_uri);
						}
					}
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

static int module_init(void)
{
	bevent_register(event_handler, NULL);
	return 0;
}

static int module_close(void)
{
	struct le *le;
	
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

EXPORT_SYM const struct mod_export DECL_EXPORTS(rtcpstats_periodic) = {
	"rtcpstats_periodic",
	"application",
	module_init,
	module_close,
};
