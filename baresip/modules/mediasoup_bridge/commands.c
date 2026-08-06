/**
 * @file commands.c ctrl_tcp command surface for mediasoup_bridge
 */

#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include "mediasoup_bridge.h"


enum {
	MS_MAX_ARGS = 6,
	MS_PARAM_SIZE = 1024,
};

struct command_params {
	char storage[MS_PARAM_SIZE];
	char *argv[MS_MAX_ARGS];
	size_t argc;
};

static bool commands_registered;


static int parse_params(struct command_params *params, void *arg,
			size_t min_args, size_t max_args)
{
	const struct cmd_arg *carg = arg;
	char *token;
	char *save = NULL;

	if (!params || !carg || !str_isset(carg->prm) ||
	    max_args > MS_MAX_ARGS)
		return EINVAL;

	memset(params, 0, sizeof(*params));
	if (str_len(carg->prm) >= sizeof(params->storage))
		return EOVERFLOW;

	str_ncpy(params->storage, carg->prm, sizeof(params->storage));
	token = strtok_r(params->storage, " \t\r\n", &save);
	while (token) {
		if (params->argc >= max_args)
			return EINVAL;
		params->argv[params->argc++] = token;
		token = strtok_r(NULL, " \t\r\n", &save);
	}

	return params->argc >= min_args && params->argc <= max_args
		? 0 : EINVAL;
}


static int parse_u32(const char *value, uint32_t *number)
{
	unsigned long parsed;
	char *end;

	if (!str_isset(value) || !number)
		return EINVAL;

	errno = 0;
	parsed = strtoul(value, &end, 10);
	if (errno || *end || parsed > UINT32_MAX)
		return EINVAL;

	*number = (uint32_t)parsed;
	return 0;
}


static int parse_remote(struct sa *remote, const char *ip, const char *port)
{
	uint32_t value;
	int err;

	err = parse_u32(port, &value);
	if (err || !value || value > UINT16_MAX)
		return EINVAL;

	return sa_set_str(remote, ip, (uint16_t)value);
}


static int command_error(struct re_printf *pf, const char *key,
			 const char *reason, int err)
{
	(void)re_hprintf(pf,
			 "{\"error\":\"%s\",\"key\":\"%s\",\"errno\":%d}",
			 reason, key ? key : "", err);
	ms_emit_error(key, reason, err);
	return err;
}


static int command_context(struct ms_context **ctxp, struct re_printf *pf,
			   const char *key)
{
	if (!ms_valid_identifier(key, MS_KEY_SIZE))
		return command_error(pf, key, "invalid-key", EINVAL);

	*ctxp = ms_context_lookup(key);
	if (!*ctxp)
		return command_error(pf, key, "context-not-found", ENOENT);

	return 0;
}


static int cmd_ctx_open(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	bool created;
	int err;

	err = parse_params(&params, arg, 1, 1);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err = ms_context_get_or_create(&ctx, params.argv[0], &created);
	if (err)
		return command_error(pf, params.argv[0],
				     "context-open-failed", err);

	err = re_hprintf(pf,
			 "{\"key\":\"%s\",\"state\":\"open\","
			 "\"created\":%s}",
			 ctx->key, created ? "true" : "false");
	mem_deref(ctx);
	return err;
}


static int cmd_ctx_close(struct re_printf *pf, void *arg)
{
	struct command_params params;
	bool changed;
	int err;

	err = parse_params(&params, arg, 1, 1);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err = ms_context_close(params.argv[0], &changed);
	if (err)
		return command_error(pf, params.argv[0],
				     "context-close-failed", err);

	return re_hprintf(pf,
			  "{\"key\":\"%s\",\"state\":\"closed\","
			  "\"changed\":%s}",
			  params.argv[0], changed ? "true" : "false");
}


static int cmd_ctx_config(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	uint32_t bitrate = 0;
	bool mix_local_callers;
	bool changed;
	int err;

	err = parse_params(&params, arg, 3, 3);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	if (!str_cmp(params.argv[1], "party-line"))
		mix_local_callers = true;
	else if (!str_cmp(params.argv[1], "isolated"))
		mix_local_callers = false;
	else
		return command_error(pf, params.argv[0],
				     "invalid-mix-mode", EINVAL);

	err = parse_u32(params.argv[2], &bitrate);
	if (err || bitrate < MS_BITRATE_MIN || bitrate > MS_BITRATE_MAX)
		return command_error(pf, params.argv[0],
				     "invalid-bitrate", EINVAL);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	err = ms_context_configure(ctx, mix_local_callers, (int)bitrate,
				   &changed);
	if (err) {
		mem_deref(ctx);
		return command_error(pf, params.argv[0],
				     "context-configure-failed", err);
	}

	err = re_hprintf(
		pf,
		"{\"key\":\"%s\",\"mixMode\":\"%s\","
		"\"mixLocalCallers\":%s,\"bitrateBps\":%u,"
		"\"changed\":%s}",
		ctx->key, mix_local_callers ? "party-line" : "isolated",
		mix_local_callers ? "true" : "false", bitrate,
		changed ? "true" : "false");
	mem_deref(ctx);
	return err;
}


static int cmd_bridge_tx(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	struct sa remote;
	uint32_t port = 0;
	uint32_t pt = 0;
	uint32_t ssrc = 0;
	bool changed;
	int err;

	err = parse_params(&params, arg, 5, 5);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err  = parse_u32(params.argv[2], &port);
	err |= parse_u32(params.argv[3], &pt);
	err |= parse_u32(params.argv[4], &ssrc);
	if (err || !port || port > UINT16_MAX || pt > 127 || !ssrc ||
	    parse_remote(&remote, params.argv[1], params.argv[2]))
		return command_error(pf, params.argv[0],
				     "invalid-tx-endpoint", EINVAL);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	err = ms_tx_configure(ctx, &remote, (uint8_t)pt, ssrc, &changed);
	if (err) {
		mem_deref(ctx);
		return command_error(pf, params.argv[0],
				     "tx-configure-failed", err);
	}

	err = re_hprintf(pf,
			 "{\"key\":\"%s\",\"tx\":\"configured\","
			 "\"changed\":%s,\"localPort\":%u,"
			 "\"payloadType\":%u,\"ssrc\":%u}",
			 ctx->key, changed ? "true" : "false",
			 ctx->tx_local_port, ctx->tx_pt, ctx->tx_ssrc);
	mem_deref(ctx);
	return err;
}


static int cmd_bridge_tx_mute(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	bool mute;
	bool changed;
	int err;

	err = parse_params(&params, arg, 2, 2);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	if (!str_cmp(params.argv[1], "on"))
		mute = true;
	else if (!str_cmp(params.argv[1], "off"))
		mute = false;
	else
		return command_error(pf, params.argv[0],
				     "invalid-mute-value", EINVAL);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	err = ms_tx_set_mute(ctx, mute, &changed);
	if (err) {
		mem_deref(ctx);
		return command_error(pf, params.argv[0], "mute-failed", err);
	}

	err = re_hprintf(pf,
			 "{\"key\":\"%s\",\"muted\":%s,\"changed\":%s}",
			 ctx->key, mute ? "true" : "false",
			 changed ? "true" : "false");
	mem_deref(ctx);
	return err;
}


static int cmd_src_reserve(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	struct ms_source *src;
	bool created;
	int err;

	err = parse_params(&params, arg, 2, 2);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	err = ms_source_reserve(ctx, params.argv[1], &src, &created);
	if (err) {
		const char *reason = err == ENOSPC ? "port-range-exhausted"
						  : "source-reserve-failed";
		mem_deref(ctx);
		return command_error(pf, params.argv[0], reason, err);
	}

	err = re_hprintf(pf,
			 "{\"key\":\"%s\",\"producerId\":\"%s\","
			 "\"localRecvPort\":%u,\"created\":%s}",
			 ctx->key, src->producer_id, src->local_port,
			 created ? "true" : "false");
	mem_deref(src);
	mem_deref(ctx);
	return err;
}


static int cmd_bridge_addsrc(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	struct ms_source *src;
	struct sa remote;
	uint32_t pt = 0;
	uint32_t ssrc = 0;
	bool changed;
	int err;

	err = parse_params(&params, arg, 5, 6);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err = parse_remote(&remote, params.argv[2], params.argv[3]);
	err |= parse_u32(params.argv[4], &pt);
	if (params.argc == 6)
		err |= parse_u32(params.argv[5], &ssrc);
	if (err || pt > 127)
		return command_error(pf, params.argv[0],
				     "invalid-rx-endpoint", EINVAL);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	mtx_lock(ctx->mutex);
	src = ms_source_find(ctx, params.argv[1]);
	if (src)
		mem_ref(src);
	mtx_unlock(ctx->mutex);
	if (!src) {
		mem_deref(ctx);
		return command_error(pf, params.argv[0],
				     "source-not-reserved", ENOENT);
	}

	err = ms_source_activate(src, &remote, (uint8_t)pt, ssrc, &changed);
	if (err) {
		mem_deref(src);
		mem_deref(ctx);
		return command_error(pf, params.argv[0],
				     "source-activate-failed", err);
	}

	err = re_hprintf(pf,
			 "{\"key\":\"%s\",\"producerId\":\"%s\","
			 "\"state\":\"active\",\"changed\":%s,"
			 "\"localRecvPort\":%u,\"payloadType\":%u,"
			 "\"ssrc\":%u}",
			 ctx->key, src->producer_id,
			 changed ? "true" : "false", src->local_port,
			 src->pt, src->expected_ssrc);
	mem_deref(src);
	mem_deref(ctx);
	return err;
}


static int cmd_bridge_delsrc(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	bool changed;
	int err;

	err = parse_params(&params, arg, 2, 2);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	err = ms_source_remove(ctx, params.argv[1], &changed);
	if (err) {
		mem_deref(ctx);
		return command_error(pf, params.argv[0],
				     "source-remove-failed", err);
	}

	err = re_hprintf(pf,
			 "{\"key\":\"%s\",\"producerId\":\"%s\","
			 "\"state\":\"removed\",\"changed\":%s}",
			 ctx->key, params.argv[1],
			 changed ? "true" : "false");
	mem_deref(ctx);
	return err;
}


static int print_source_stat(struct re_printf *pf,
			     const struct ms_source *src)
{
	struct jbuf_stat jstat;
	char remote[64] = "";

	memset(&jstat, 0, sizeof(jstat));
	if (src->jbuf)
		(void)jbuf_stats(src->jbuf, &jstat);
	if (src->active)
		(void)sa_ntop(&src->remote, remote, sizeof(remote));

	return re_hprintf(
		pf,
		"{\"producerId\":\"%s\",\"state\":\"%s\","
		"\"localRecvPort\":%u,\"remoteIp\":\"%s\","
		"\"remotePort\":%u,\"payloadType\":%u,\"ssrc\":%u,"
		"\"latchedSsrc\":%u,\"rxPackets\":%llu,\"rxBytes\":%llu,"
		"\"rxInvalid\":%llu,\"rxLost\":%llu,\"plcFrames\":%llu,"
		"\"decodeErrors\":%llu,\"jbufDepth\":%u,"
		"\"jbufDelayMs\":%u,\"levelDbfs\":%.1f}",
		src->producer_id, src->active ? "active" : "reserved",
		src->local_port, remote,
		src->active ? sa_port(&src->remote) : 0,
		src->active ? src->pt : 0, src->expected_ssrc,
		src->latched_ssrc, (unsigned long long)src->rx_packets,
		(unsigned long long)src->rx_bytes,
		(unsigned long long)src->rx_invalid,
		(unsigned long long)src->rx_lost,
		(unsigned long long)src->plc_frames,
		(unsigned long long)src->decode_errors,
		jstat.c_packets, jstat.c_delay, src->level_dbfs);
}


static int cmd_bridge_stat(struct re_printf *pf, void *arg)
{
	struct command_params params;
	struct ms_context *ctx = NULL;
	struct le *le;
	char remote[64] = "";
	size_t source_count;
	size_t call_count;
	size_t ports_used;
	bool first = true;
	int err;

	err = parse_params(&params, arg, 1, 1);
	if (err)
		return command_error(pf, "", "invalid-parameters", err);

	err = command_context(&ctx, pf, params.argv[0]);
	if (err)
		return err;

	mtx_lock(ctx->mutex);
	source_count = list_count(&ctx->sources);
	call_count = list_count(&ctx->callers);
	if (ctx->tx_ready)
		(void)sa_ntop(&ctx->tx_remote, remote, sizeof(remote));
	ports_used = ms_port_pool_used();

	err = re_hprintf(
		pf,
		"{\"key\":\"%s\",\"state\":\"open\",\"calls\":%zu,"
		"\"mixMode\":\"%s\",\"mixLocalCallers\":%s,"
		"\"bitrateBps\":%d,"
		"\"tx\":{\"configured\":%s,\"muted\":%s,"
		"\"localPort\":%u,\"remoteIp\":\"%s\",\"remotePort\":%u,"
		"\"payloadType\":%u,\"ssrc\":%u,\"packets\":%llu,"
		"\"bytes\":%llu,\"errors\":%llu,\"levelDbfs\":%.1f},"
		"\"rxSourceCount\":%zu,"
		"\"ports\":{\"inUse\":%zu,\"capacity\":%zu,"
		"\"purpose\":\"remote-receive\","
		"\"txConsumesPool\":false},\"sources\":[",
		ctx->key, call_count,
		ctx->mix_local_callers ? "party-line" : "isolated",
		ctx->mix_local_callers ? "true" : "false",
		ctx->bitrate_bps, ctx->tx_ready ? "true" : "false",
		ctx->tx_muted ? "true" : "false", ctx->tx_local_port, remote,
		ctx->tx_ready ? sa_port(&ctx->tx_remote) : 0,
		ctx->tx_ready ? ctx->tx_pt : 0, ctx->tx_ssrc,
		(unsigned long long)ctx->tx_packets,
		(unsigned long long)ctx->tx_bytes,
		(unsigned long long)ctx->tx_errors, ctx->tx_level_dbfs,
		source_count, ports_used, ms_port_pool.count);

	for (le = ctx->sources.head; !err && le; le = le->next) {
		if (!first)
			err = re_hprintf(pf, ",");
		first = false;
		if (!err)
			err = print_source_stat(pf, le->data);
	}
	if (!err)
		err = re_hprintf(pf, "]}");
	mtx_unlock(ctx->mutex);

	mem_deref(ctx);
	return err;
}


static const struct cmd commandv[] = {
	{"ms_ctx_open", 0, CMD_PRM, "Open a mediasoup bridge context",
	 cmd_ctx_open},
	{"ms_ctx_close", 0, CMD_PRM, "Close a mediasoup bridge context",
	 cmd_ctx_close},
	{"ms_ctx_config", 0, CMD_PRM, "Configure mediasoup bridge context",
	 cmd_ctx_config},
	{"ms_bridge_tx", 0, CMD_PRM, "Configure mediasoup RTP transmit",
	 cmd_bridge_tx},
	{"ms_bridge_tx_mute", 0, CMD_PRM, "Mute mediasoup RTP transmit",
	 cmd_bridge_tx_mute},
	{"ms_src_reserve", 0, CMD_PRM, "Reserve a mediasoup RTP receive port",
	 cmd_src_reserve},
	{"ms_bridge_addsrc", 0, CMD_PRM, "Activate a mediasoup RTP source",
	 cmd_bridge_addsrc},
	{"ms_bridge_delsrc", 0, CMD_PRM, "Remove a mediasoup RTP source",
	 cmd_bridge_delsrc},
	{"ms_bridge_stat", 0, CMD_PRM, "Show mediasoup bridge statistics",
	 cmd_bridge_stat},
};


int ms_commands_register(void)
{
	int err;

	if (commands_registered)
		return 0;

	err = cmd_register(baresip_commands(), commandv,
			   RE_ARRAY_SIZE(commandv));
	if (!err)
		commands_registered = true;

	return err;
}


void ms_commands_unregister(void)
{
	if (!commands_registered)
		return;

	cmd_unregister(baresip_commands(), commandv);
	commands_registered = false;
}
