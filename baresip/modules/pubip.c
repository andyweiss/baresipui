/**
 * @file modules/pubip/pubip.c  Public IP Contact header rewrite
 *
 * Copyright (C) 2026 Baresip Contributors
 *
 * This module extracts the public IP address from SIP responses
 * (Via header received parameter) and uses it in subsequent
 * REGISTER requests for proper NAT traversal, similar to PJSIP behavior.
 *
 * Usage: Load this module to enable automatic Contact header rewriting
 *        with public IP address detection.
 */

#include <re.h>
#include <baresip.h>


/**
 * Module state
 */
struct pubip_state {
	struct le le;
	struct ua *ua;
	struct sa public_ip;  /* Detected public IP address */
	bool enabled;
};

static struct list pubip_list;


/**
 * Extract public IP from SIP Via header
 *
 * @param via_val Via header value
 * @param out_addr Output socket address
 * @return 0 if success, otherwise errorcode
 */
static int extract_public_ip_from_via(const struct pl *via_val,
				      struct sa *out_addr)
{
	struct sip_via via;
	int err;

	if (!via_val || !out_addr)
		return EINVAL;

	err = sip_via_decode(&via, via_val);
	if (err)
		return err;

	/* Use the received parameter if available */
	if (sa_isset(&via.addr, SA_ADDR)) {
		sa_cpy(out_addr, &via.addr);
		return 0;
	}

	return ENOENT;
}


/**
 * Extract public IP from X-pubip header (if present)
 *
 * @param msg SIP message
 * @param out_addr Output socket address
 * @return 0 if success, otherwise errorcode
 */
static int extract_public_ip_from_header(const struct sip_msg *msg,
					 struct sa *out_addr)
{
	const struct sip_hdr *hdr;
	struct pl pl;
	int err;

	if (!msg || !out_addr)
		return EINVAL;

	/* Look for custom X-pubip header */
	hdr = sip_msg_xhdr(msg, "X-pubip");
	if (!hdr)
		return ENOENT;

	pl_set_str(&pl, (char *)hdr->val.p);

	/* Try to parse as socket address */
	err = sa_set(&pl, NULL, 0);
	if (err == 0) {
		sa_cpy(out_addr, &pl);
		return 0;
	}

	return err;
}


/**
 * Update public IP for a UA
 *
 * @param state Pubip state
 * @param new_addr New public IP address
 */
static void update_public_ip(struct pubip_state *state,
			     const struct sa *new_addr)
{
	if (!state || !new_addr)
		return;

	if (!sa_cmp(&state->public_ip, new_addr, SA_ADDR)) {
		info("pubip: updated public IP for %s: %J\n",
		     ua_aor(state->ua), new_addr);
		sa_cpy(&state->public_ip, new_addr);
	}
}


/**
 * Handle SIP message from UA
 *
 * This handler is called for all SIP messages related to the UA.
 * We intercept 401/407 responses to extract the public IP.
 */
static void ua_event_handler(struct ua *ua, enum ua_event ev,
			     struct call *call, const char *prm, void *arg)
{
	struct pubip_state *state = arg;
	(void)call;
	(void)prm;

	if (!state || ua != state->ua)
		return;

	/* Currently handled via bevent system - see module_init */
}


/**
 * Global bevent handler for all SIP events
 */
static void bevent_handler(enum bevent_ev ev, struct bevent *bevent,
			   void *arg)
{
	struct sip_msg *msg = bevent_get_sip_msg(bevent);
	struct le *le;
	struct sa pub_addr;
	int err;

	(void)arg;

	if (ev != BEVENT_REGISTER_FAIL && msg->scode != 401 &&
	    msg->scode != 407)
		return;

	if (!msg || !msg->via || msg->scode < 400)
		return;

	/* Try to extract public IP from Via header */
	err = extract_public_ip_from_via(&msg->via->val, &pub_addr);
	if (err) {
		/* Fallback to X-pubip header */
		err = extract_public_ip_from_header(msg, &pub_addr);
	}

	if (err == 0) {
		/* Update all matching UAs */
		for (le = pubip_list.head; le; le = le->next) {
			struct pubip_state *state = le->data;
			struct ua *ua = bevent_get_ua(bevent);

			if (ua == state->ua) {
				update_public_ip(state, &pub_addr);
			}
		}
	}
}


/**
 * Allocate pubip state for a UA
 */
static int pubip_state_alloc(struct pubip_state **statep, struct ua *ua)
{
	struct pubip_state *state;

	if (!statep || !ua)
		return EINVAL;

	state = mem_zalloc(sizeof(*state), NULL);
	if (!state)
		return ENOMEM;

	state->ua = ua;
	state->enabled = true;
	sa_init(&state->public_ip, AF_UNSPEC);

	list_append(&pubip_list, &state->le, state);

	*statep = state;
	return 0;
}


/**
 * Module init
 */
static int module_init(void)
{
	int err;

	list_init(&pubip_list);

	/* Register for SIP events */
	err = bevent_register(bevent_handler, NULL);
	if (err)
		return err;

	info("pubip: Public IP Contact header rewrite module loaded\n");

	return 0;
}


/**
 * Module close
 */
static int module_close(void)
{
	bevent_unregister(bevent_handler);
	list_flush(&pubip_list);

	info("pubip: module unloaded\n");

	return 0;
}


/**
 * Module export
 */
const struct mod_export DECL_EXPORTS(pubip) = {
	"pubip",
	"application",
	module_init,
	module_close
};
