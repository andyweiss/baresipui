#include <re.h>
#include <baresip.h>
#include <re.h>
#include <baresip.h>

/**
 * @file rtcpstats_periodic.c Periodic RTCP stats module
 * Output RTCP stats every 2 seconds during active calls
 *
 * Modified from original rtcpsummary.c
 */
#include <re.h>
#include <baresip.h>

struct rtcpstats_call {
	struct le le;	
	struct call *call;
	struct tmr tmr;
};

static struct list calll = LIST_INIT;

static void print_rtcp_stats_line(const struct call *call, const struct stream *s)
{
	const struct rtcp_stats *rtcp;
	rtcp = stream_rtcp_stats(s);

	if (!rtcp) {
		info("RTCP_STATS: no rtcp stats for call %s, stream %s\n", call_id(call), sdp_media_name(stream_sdpmedia(s)));
		return;
	}
	
	/* Debug: Print all available RTCP fields to understand structure */
	info("RTCP_STATS_DEBUG: call_id=%s media=%s\n", call_id(call), sdp_media_name(stream_sdpmedia(s)));
	info("RTCP_STATS_DEBUG: rx.sent=%u rx.lost=%d rx.jit=%u\n", rtcp->rx.sent, rtcp->rx.lost, rtcp->rx.jit);
	info("RTCP_STATS_DEBUG: tx.sent=%u tx.lost=%d tx.jit=%u\n", rtcp->tx.sent, rtcp->tx.lost, rtcp->tx.jit);
	info("RTCP_STATS_DEBUG: rtt=%u\n", rtcp->rtt);
	
	/* Get RTP metrics for packets/bytes even if RTCP not available yet */
	uint32_t rx_packets = stream_metric_get_rx_n_packets(s);
	uint32_t tx_packets = stream_metric_get_tx_n_packets(s);
	uint32_t rx_bytes = stream_metric_get_rx_n_bytes(s);
	uint32_t tx_bytes = stream_metric_get_tx_n_bytes(s);
	uint32_t rx_errors = stream_metric_get_rx_n_err(s);
	uint32_t tx_errors = stream_metric_get_tx_n_err(s);
	
    info("RTCP_STATS_DEBUG: RTP metrics: rx_packets=%u tx_packets=%u rx_bytes=%u tx_bytes=%u rx_errors=%u tx_errors=%u\n",
         rx_packets, tx_packets, rx_bytes, tx_bytes, rx_errors, tx_errors);
	
	/* Note: stream_jbuf_stats() returns ENOSYS (38) - not supported in this build */
	/* Using RTCP jitter and RTP metrics instead */
	
	info("RTCP_STATS: "
		 "call_id=%s;"
		 "media=%s;"
		 "rtcp_packets_rx=%u;"
		 "rtcp_packets_tx=%u;"
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
		 "\n",
		 call_id(call),
		 sdp_media_name(stream_sdpmedia(s)),
		 rtcp->rx.sent,
		 rtcp->tx.sent,
		 rtcp->rx.lost,
		 rtcp->tx.lost,
		 1.0 * rtcp->rx.jit/1000,
		 1.0 * rtcp->tx.jit/1000,
		 1.0 * rtcp->rtt/1000,
		 rx_packets, tx_packets, rx_bytes, tx_bytes,
		 rx_errors, tx_errors);
}

static void tmr_handler(void *arg)
	
{
	struct rtcpstats_call *rc = arg;
	const struct stream *s;
	struct le *le;

	info("RTCP_STATS: tmr_handler called for call %s\n", call_id(rc->call));
	
	int stream_count = 0;
	for (le = call_streaml(rc->call)->head; le; le = le->next) stream_count++;
	info("RTCP_STATS: call %s has %d streams\n", call_id(rc->call), stream_count);
	
	/* Print stats for all streams in this call */
	for (le = call_streaml(rc->call)->head; le; le = le->next) {
		s = le->data;
		
		/* Additional debug: Check stream type and RTP socket */
		info("RTCP_STATS: Processing stream type=%s, sdp_name=%s\n",
		     (stream_type(s) == 0) ? "audio" : "video",
		     sdp_media_name(stream_sdpmedia(s)));
		
		/* Check if stream is ready */
		if (!stream_is_ready(s)) {
			info("RTCP_STATS: Stream %s not ready yet\n", sdp_media_name(stream_sdpmedia(s)));
			continue;
		}
		
		print_rtcp_stats_line(rc->call, s);
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
		list_append(&calll, &rc->le, rc);
		
		/* Initialize and start timer - first trigger after 5 seconds to allow RTCP to establish */
		tmr_init(&rc->tmr);
		tmr_start(&rc->tmr, 5000, tmr_handler, rc);
		info("rtcpstats_periodic: started for call %s, timer=%p, first trigger in 5s\n", call_id(call), &rc->tmr);
		break;

	case BEVENT_CALL_CLOSED:
		/* Find and remove this call's stats tracker */
		{
			struct le *le;
			for (le = calll.head; le;) {
				rc = le->data;
				le = le->next;
				
				if (rc->call == call) {
					/* Print final stats */
					const struct stream *s;
					struct le *sle;
					for (sle = call_streaml(call)->head; sle; sle = sle->next) {
						s = sle->data;
						print_rtcp_stats_line(call, s);
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
