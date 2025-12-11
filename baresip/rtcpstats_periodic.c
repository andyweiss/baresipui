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
	info("RTCP_STATS: "
		 "call_id=%s;"
		 "media=%s;"
		 "packets_rx=%u;"
		 "packets_tx=%u;"
		 "lost_rx=%d;"
		 "lost_tx=%d;"
		 "jitter_rx=%.1f;"
		 "jitter_tx=%.1f;"
		 "rtt=%.1f;"
		 "\n",
		 call_id(call),
		 sdp_media_name(stream_sdpmedia(s)),
		 rtcp->rx.sent,
		 rtcp->tx.sent,
		 rtcp->rx.lost,
		 rtcp->tx.lost,
		 1.0 * rtcp->rx.jit/1000,
		 1.0 * rtcp->tx.jit/1000,
		 1.0 * rtcp->rtt/1000);
}

static void tmr_handler(void *arg)
	
{
		info("RTCP_STATS: TEST DEBUG LINE\n");
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
		
		/* Initialize and start timer - first trigger after 2 seconds */
		tmr_init(&rc->tmr);
		tmr_start(&rc->tmr, 2000, tmr_handler, rc);
		info("rtcpstats_periodic: started for call %s, timer=%p\n", call_id(call), &rc->tmr);
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
